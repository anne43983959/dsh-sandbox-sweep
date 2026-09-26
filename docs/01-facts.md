# 01 · 事实基线

> ⚠️ **本文件是本机实验记录**：含 PID / 版本目录等环境细节（实例/会话 ID、端口已打码，绝对路径用 `%APPDATA%` / `$DSH_HOME` 等占位符）。
> 分享或发布前请按 `AGENTS.md` §6 脱敏；本机专属的完整信息在未追踪的 `SOURCE.local.md` 与各 home 的 `sandbox-sweep/SOURCE.md`。


> 全部为本机实测或已发布产物核对所得。证据等级：**A**=实测且可复现；**B**=源码/产物核对；**C**=文档记载；**D**=推断未验证。

## 1. 三件套是什么

write-enabled（workspace-write）授权时，一次 `SetNamedSecurityInfoW`（`SecurityInfo = 20 = DACL|SACL`）写入三样（A/B，`dsh-sandbox-windows-acl/lib/types-DxezulnA.js`）：

| 组成 | 形式 | 作用 |
|---|---|---|
| 能力 SID 允许 ACE | `S-1-4-x-y:(OI)(CI)(W,D,DC)`，掩码 `0x110156` | 写白名单本体 |
| world 删除拒绝 | `Everyone:(CI)(DENY)(DC)` | 堵"父目录 DC 授权删除"绕过 |
| 低完整性标签 | `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` | 让被降为 Low 的受限令牌在被授权根内**重新可写** |

授权根：工作区根（standing，永不撤销）+ 每会话私有 temp 目录（revocable）。E / B

## 2. 版本边界（A/B）

| 版本 | 三件套 |
|---|---|
| 0.1.5-rc.1 … 0.1.6-alpha.1 | **无**（只有能力 ACE；`SetNamedSecurityInfoW` 掩码 = 4，只动 DACL） |
| **0.1.7-alpha.1 起**（α1/α2/rc.1/rc.2 bundle 逐字节相同） | **有** |

→ 本项目中的风险实例判定阈值应为 **`>= 0.1.7-alpha.1`（含预发布）**。

## 3. 擦除（A，6040 对象实验树）

| 操作 | 耗时 |
|---|---|
| 首次授权（三件 + 全树传播） | 510 ms |
| 再次授权（三条精确匹配 → 跳过） | **1 ms** |
| 去拒绝 + 复位标签（各一次根级调用） | 458 + 495 ms |
| 擦除后重新授权 | 509 ms |
| 根级打标 vs `/T` 复位 | 494 ms vs **1892 ms** |
| 单次 `icacls` 调用开销 | ≈ 14.4 ms |
| 私有 temp 授权 / dispose（10 对象） | 2 ms / 2 ms |

换算：授权 ≈ 0.085 ms/对象，擦除 ≈ 0.16 ms/对象。

## 4. 擦除手段的能力边界（A）

| 手段 | 能力 SID ACE | 低标签 | world 拒绝 |
|---|---|---|---|
| 模块 API：`AclWriteGrant.create(sid) → add(path,false) → dispose()` | ✅ 清除 | ✅ **彻底移除**（非替换为 Medium） | ❌ 保留（模块无撤销路径） |
| 模块借道撤销（对已 standing 的三件） | ✅ 清除 | ✅ 清除 | ❌ 保留 |
| `icacls <root> /remove:g "*S-1-4-…"` | ❌ **无效**（`processed 0 files`，未映射 SID） | — | — |
| `icacls <root> /remove:d "*S-1-1-0"` | — | — | ✅ 有效 |
| `icacls <root> /setintegritylevel Medium` | — | ✅（根级一次即全树，无需 `/T`） | — |
| `icacls <root> /reset` | ✅ 清（连带用户自定义 ACE） | ❌ 不动标签 | ✅ 清 |

**继承形态**：根 `(OI)(CI)`，子项 `(I)`（继承而来）。子项上删不掉继承来的 ACE，必须从根上撤。

**访问限制（A）**：受限会话（沙箱内）在**自己刚创建的目录**上写 ACL 亦被拒（`Access is denied`）；宿主进程不受限，可写。→ 擦除必须由宿主半执行。

## 5. 触发与生命周期（A/B）

- 授权时机：**第一条会话内的受限 workspace-write 命令**（provider 按工作区缓存，每 provider 生命周期一次）。
- **跳过条件是三条精确匹配**；任一缺失 → 重写三件 + 全树重传播。
- **缓存陈旧风险（B，关键）**：`sandbox-local` 的 `workspaceGrants` 以工作区根为键缓存，命中即返回，**不再复查 ACL**。→ 外部擦除后，本实例仍会发放写 SID，但目录已无 Low 标签 → 受限写入静默失败，直到重启。
- 标签随**同卷移动**外溢；孤儿标签可被新父目录的一次可继承标签写入回收。
- 显式（非继承）标签不随根复位消失（边角情形）。

## 6. 启动器行为（A/B）

- 安装位置 `C:\Program Files\dsh-launcher\dsh-launcher.exe`（Rust）；实例由 `bin\dsh.bat` → `node …\versions\<v>\node_modules\@deepseek-ai\dsh\lib\bin.js` 拉起 → **版本可直接从进程命令行路径解析**。
- "停止实例"= **硬杀**：二进制含 `TerminateProcess`/`WaitForSingleObject`，无 `GenerateConsoleCtrlEvent`/`CTRL_C_EVENT`/`taskkill`；日志实测 `收到停止实例…` → 62 ms → `已停止（exit code: Some(1)）`（= Rust `Child::kill()` 语义）。
- 结论：**任何以"优雅退出"为目标的方案都只能由实例自身发起**——这正是本项目在 WebUI 内实现关闭按钮的动机。

## 7. WebUI 插件机制（B/C）

- 客户端插件：`package.json` 声明 `dsh.client`（`platform: 'web'`、导出 `./client`、可列 `dsh.client.externals`）；宿主经 `/plugins` 提供构建产物，**缺失 `lib/client.js` 会激活失败并报错**。
- 安装：插件侧栏 "Add plugin" 支持包名/版本、Git、tarball、**绝对本地路径**；行写入 profile 的 `cordis.patch.yml`。
- UI 通过 `ctx.slots` 注册；槽位条目带 `priority`/`order`，list 型槽按 `priority → order` 排序，单占位槽只按 `priority`。

### 侧栏已有槽位（B，`dsh-client-ui-sidebar/lib/client.js`）
`sidebar.panellist`、`sidebar.brand.mark`、`sidebar.brand.name`、`sidebar.toggle.badge`、**`sidebar.workspaces`**、`sidebar.footer.action`、`sidebar.settings`

### 工作区插件声明的子槽位（B，`dsh-client-ui-workspace`）
`sidebar.workspaces.directoryFlow`、`sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action`

**"新会话"按钮归属**：`dsh-client-ui-workspace` 的 `actions.newSession`（`新会话` / `New session`），渲染在 `sidebar.workspaces` 区域内。→ 想落在它**上方**，最可能是"以更高优先级注册进 `sidebar.workspaces`"；该槽位是 list 还是 single **未确认**（见 Spike S1）。

## 8. 会话与并行工作（B/C）

- `ctx.agents`：活跃 agent 注册表；句柄支持 cancel / wait-for-idle / dispose（`dispose()` 文档描述为 "stops the loop, unregisters, removes the session, unwinds the scope"——**具体删什么需 Spike S4**）。
- 活动类型至少四类，UI 已有的口径可对齐：**进行中的回合 / 运行中的子智能体 / 后台任务 / 定时提醒**（`dsh-client-ui-workspace` 的 `archive.confirm.*` 文案）。
- 常驻终端：`dsh-terminal`/`dsh-terminal-bash`，"整个生命周期运行在该沙箱边界下"；**沙箱模式围栏**：owner 有打开的会话或 spawn 进行中时，模式切换被拒绝。
- 会话刷盘：存在共享的 durability barrier（`ctx.sessions.flush(session)`），退出前必须走。
- 宿主 dispose：`sandbox-local` 的 temp 撤销注册在 `ctx.effect` 上 → **`process.exit()` 会跳过它**。

## 9. 已验证无效或需修正的既有结论

1. `icacls /remove:g "*S-1-4-…"` **清不掉能力 ACE**（原技能标为"可选"）。
2. `/T` 对继承标签**并非必要且约 4 倍慢**，还会给每个对象留下显式 Medium 记录。
3. "删除拒绝 ACE 导致删不掉"需**条件化**：实测对象自身有 DELETE 时，父目录有拒绝照样能删；对象自身无 DELETE 时，有无拒绝都删不掉（PowerShell/.NET 路径）。资源管理器路径未复测。
