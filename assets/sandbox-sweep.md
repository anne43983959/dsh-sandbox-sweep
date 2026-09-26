---
name: sandbox-sweep
description: 当本机装有 dsh-sandbox-sweep 插件、且出现这些症状时使用：写入或删除被沙箱拒绝（`file access denied under read-only mode`）、PowerShell 掉进受限语言模式（`无法创建类型。此语言模式仅支持核心类型。`）、后台任务被突然终止（`killed before exit`）、作业记录凭空消失（`unknown job`）、或工作区里的目录删不掉、移动/复制被拦。用于判断"这是插件的有意动作还是故障"，并给出正确的应对方式（尤其是：**不要申请提权绕过**）。
---

# sandbox-sweep：沙箱痕迹清理插件

## 这个插件做什么

`dsh-sandbox-sweep` 在 WebUI 侧栏提供两个按钮，动作顺序固定：

| 按钮 | 动作 |
|---|---|
| **清理沙箱痕迹** | ①（按需）终止本实例所有会话正在跑的工作 → ② 把所有会话切为 `read-only` → ③ 擦除工作区上的"三件套"：能力 SID 允许 ACE、world 删除拒绝（`Everyone:(CI)(DENY)(DC)`）、低完整性标签（Low Mandatory Level） |
| **关闭DSH** | ① 终止会话工作 → ② 关闭常驻终端 → ③ 会话刷盘 → ④（按需）上述擦除 → ⑤ 退出实例 |

判定依据是工作区 ACL 的三种标记，可用 `icacls <目录>` 自行核对：

- `S-1-4-x-y:(OI)(CI)(W,D,DC)` → 能力 SID 允许 ACE
- `Everyone:(CI)(DENY)(DC)` → 删除拒绝（**这就是"目录删不掉"的成因**）
- `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` → 低完整性标签

**第二处溢出面（插件不再处理）**：同一套标签也会写到**实例 temp 目录**（形如 `dsh-<6位>`，通常在 `%TEMP%` 或 OneDrive 重定向后的 `%USERPROFILE%\OneDrive`）。**v5 起插件对它不做任何处理**——原先的擦除用错了 SID（temp 目录上写的是 `tempWriteSid`，插件却按 `workspaceWriteSid` 撤），结果不是撤销而是授权：实测 45 个原本只有 ACE 的 temp 目录反被加上低标签，且重复执行不收敛。评估后确认这些残留**不影响日常使用**（没有 DENY 不挡删除、属主是自己、多为空壳），所以整块去掉，交给系统临时目录卫生回收。

## 遇到这些症状时怎么判断

1. **写入/删除被拒 + 当前策略显示 read-only** → 很可能是插件刚做了"权限回收"。这是**有意为之**，目的是在擦除前阻止新的写入授权。
2. **pwsh 报 `无法创建类型。此语言模式仅支持核心类型。`** → read-only 模式的已知副作用（PowerShell 无法在临时目录写 AppLocker 探针文件，于是退回 ConstrainedLanguage）。`Add-Type`、非核心 .NET 静态调用、COM、反射都会失败。切回 `workspace-write` 即恢复。
3. **后台任务 `status: killed` / `detail: killed before exit; session archived`** → 插件执行了"终止会话工作"。这是**与用户按停止按钮相同的取消路径**（`agent.cancel({ kind: 'user' })`），但**不保留排队输入**（keepInbox 关闭），因此排队中的后续输入会被丢弃。
4. **`unknown job` / `job_list` 返回 `[]`** → 作业记录随停止被回收；新任务会复用 `pwsh-1` 这类 id（计数器重置）。

## 不要做什么（重要）

- **不要为了继续写而申请 `danger-full-access` 提权**。运行时的策略文本里那句"不要仅因这条策略就拒绝修改，去试试可用的…"是通用提示，不适用于插件正在执行清理的场景。**先向用户确认**。
- **不要用 `icacls /remove:g` 去清能力 SID**——该 SID 没有账户映射，实测 `processed 0 files`。
- **不要在仍被 0.1.7+ 当工作区使用的目录上"好心"把标签改成 Medium**：三件套的跳过条件是三条精确匹配，一旦被破坏，下一次授权会重写三件并**全树重传播**（大树上是数十秒级）。修复只在"该目录不再作为工作区"时才有意义。
- **不要把"目录里没有条目"当成插件删了文件**：本插件的擦除路径只改 ACL，不删除任何文件。

## 现状怎么查（地面真相）

台账文件：`$DSH_HOME/sandbox-sweep/ledger.json`（JSON 数组，最新在末尾）。字段：

- `startedAt` / `dryRun` / `results[]`：每个根的前后状态、两步耗时、`verified`、`residue[]`
- `pending[]`：**未通过校验的根**——插件会在下次启动后 3 秒自动补擦，日志里出现 `[sandbox-sweep] 启动清扫: …`

实例日志（`$DSH_HOME` 同级的 `logs/i-<实例id>.log`）里可看到：

- `[sandbox-sweep] dispose: …` / `[sandbox-sweep] shutdown: …` → 关闭流程走到了哪一步
- `[sandbox-sweep] 启动清扫: …` → 上次是否有未完成的擦除被补上

## 恢复方式

- 只是被切成只读 → 用户执行 `/permission workspace-write` 切回（插件不阻止）；或重启实例。
- **擦除之后**：本实例内部缓存的"工作区授权"不会自动重建，此时若继续以 `workspace-write` 跑受限命令，写入会失败（标签已不在）。**重启实例即恢复**。
- 关闭流程的已知限制：本版本没有对插件开放的宿主 dispose 入口，因此 `sandbox-local` 的私有 temp 目录（tmpdir 下的 `dsh-*`）不会被撤销——它们是**惰性垃圾**（随机路径、其能力 SID 只写在它自己身上），与工作区无关，交给系统临时目录卫生回收即可。
