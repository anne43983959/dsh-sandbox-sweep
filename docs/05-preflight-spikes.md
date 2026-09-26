# 05 · 开发前准备（最后一公里）

> ⚠️ **本文件是本机实验记录**：含绝对路径 / PID / 端口 / 版本目录等本机环境细节。
> 分享或发布前请按 `AGENT.md` §6 脱敏；本机专属的完整信息在未追踪的 `SOURCE.local.md` 与各 home 的 `sandbox-sweep/SOURCE.md`。


## 0. 环境基线（本机实测）

| 项 | 值 |
|---|---|
| 插件目标版本 | DSH **0.1.7-rc.2**（用户新建的专用实验实例 `i-8352a98d-…` / `homes\0.1.7-rc.2`；沙箱包与 rc.1 逐字节相同） |
| 对照实例 | 0.1.5-rc.3（无三件套；仅写能力 ACE）与 0.1.7-rc.1（未运行） |
| Node | v22.23.2（`C:\Program Files\nodejs\node.exe`） |
| 启动器 | `C:\Program Files\dsh-launcher\dsh-launcher.exe`（Rust；停止 = 硬杀） |
| 参考实现（只读） | `versions\0.1.7-rc.2\node_modules\.pnpm\@deepseek-ai+dsh-client-ui-*\…\lib\client.js` 与 `…\dsh-sandbox-windows-acl\lib\types-*.js` |
| 开发时会话工作区 | 当时是 `%APPDATA%\in.dsh-plug.dsh-launcher`（插件源码就放在它下面）。**2026-09-26 计划把源码搬到 `%USERPROFILE%\Documents\dsh-plugins\`，但跨工作区提权被拒 → 搬迁未执行，源码仍在原处**（详见 `docs/07` 的 M9） |

## 1. Spike 清单（按顺序做，S1 决定 UI 能否达标）

| 编号 | 问题 | 方法 | 产出 | 影响的决策 |
|---|---|---|---|---|
| **S1** | `sidebar.workspaces` 是 list 型还是 single 型槽位？注册进去能否排在 workspace occupant 之前？ | ① 在该槽位声明处确认 `kind`；② 最快的办法：写一个最小客户端插件，向 `sidebar.workspaces` 注册一个彩色色块并观察渲染位置 | 座位判定结论 + 最小可复现实验 | **D1 按钮座位**；决定是否需要向上游申请新座位 |
| S2 | `dsh.client` 的完整契约与构建基线 | 读 `dsh-client-modules` + 一个官方客户端插件的 `package.json`；对齐 `externals`（React/Cordis/静态 UI 库）与打包器 | 可构建的 hello-world 客户端插件 | D2 构建基线 |
| S3 | 宿主↔客户端 RPC 的注册与鉴权 | 读 `dsh-api-remote*`/`dsh-client-connection` 的注册面；在宿主半注册一个 echo 方法，客户端调用成功 | RPC 模板（含 nonce 校验） | D3 通道 |
| S4 | "活跃对话"的准确口径与 `AgentHandle.dispose()` 的真实副作用 | 读 `dsh-agent` 类型定义 + 在小实例上实测（1 个空会话） | 口径表（四类）+ dispose 副作用结论 | 02 · 自检字段；风险 R6 |
| S5 | 常驻终端的枚举与关闭 API | 读 `dsh-terminal` 类型；实测"有终端时会话模式切换被拒"与"先关终端后可切" | 终端阻塞的处置流程 | R3 对策 |
| S6 | 宿主优雅退出链：是否有官方 shutdown 钩子 | 读 `dsh-sandbox-local` 的 `ctx.effect` 与宿主生命周期；实测 `dispose → exit` 后 temp 目录是否消失 | 退出时序确认 | 关闭流程 M3 出口判据 |
| S7 | 宿主进程内可用 WMI 取 `node.exe` 命令行 | 在宿主半插件里跑一次进程扫描（不要用受限会话试，那里 WMI 被禁） | 版本识别可行性 | 其他实例自检可行性 |
| S8 | 宿主进程内写 ACL 的可行性与失败面 | 用模块 API 对一个 100 对象实验目录跑擦除 + 校验（复用既有实验方法） | 失败模式清单 | R5/R7 |
| S9 | 本地插件的安装/禁用/回滚路径 | 用插件侧栏 "Add plugin" 装入本地路径的 hello-world，观察 `cordis.patch.yml` 变化，再禁用/卸载 | 安装与回滚手册 | 交付流程 |

## 2. 工具链准备

- **TypeScript + 打包器**：客户端半需要产出单文件 `lib/client.js`；宿主半产出 `lib/index.js`。
- **类型来源**：`versions\0.1.7-rc.2\node_modules\.pnpm\@deepseek-ai+dsh-client-ui-slots\…\lib\types\index.d.ts`（51 KB，槽位 API 的权威签名）与各 `dsh-client-ui-*` 的 `.d.ts`；**以其为准，不靠猜**。
- **冻结基线**：把 0.1.7-rc.2 的相关 `.d.ts` 复制进 `types/vendor/` 并记录来源版本，避免升级后静默漂移。
- **实验目录约定**：所有实验产物放 `.sandbox/sweep-<时间戳>/`，用后清理（本目录 `AGENT.md` §4 的约定）。

## 3. 安装与回滚（Spike S9 定稿，先按此预案）

1. 构建 → 确认 `lib/client.js` 存在（缺失会导致插件激活失败并报错）。
2. WebUI 侧栏 **插件 → Add plugin → 绝对本地路径** 安装。
3. 启用后刷新页面；按钮应立即出现在新会话按钮上方。
4. **回滚**：插件页禁用该 bundle（写入 profile 的 `cordis.patch.yml`）→ 或卸载 → 必要时手工移除该行并重启实例。
5. **不假设**：安装/卸载是否会重启实例、是否影响正在运行的会话，必须在 S9 里实测记录。

## 4. 合规约束（本目录 `AGENT.md`）

- 写入限制在 `.sandbox/`（本企划目录为显式例外：用户指示在根目录建项目文件夹）。
- 删除一律走回收站；禁止对 `homes/`、`versions/`、`profiles/`、`sessions/`、`storages/` 等做递归删除。
- 不读取/修改 `.credentials.yaml`，不读取/删除 `webview/`。
- **不结束 / 不重启 DSH 相关进程**——因此"强制终止对话""关闭实例"等动作在开发期只能在**专门的测试实例**上做，且需用户在场批准。
- 插件安装/卸载、跨版本 home 操作等属"先呈报后执行"，需用户批准。

## 5. 开工前检查清单

- [ ] S1 有结论，D1 已定（座位 + 排序方式）
- [ ] S2 有结论，hello-world 客户端插件可在本机 WebUI 渲染
- [ ] S3 有模板，客户端能调用宿主自定义方法
- [ ] S4/S5 的口径表落地到 `shared/types.ts`
- [ ] S6 的退出时序经一次实测验证（temp 目录消失 + `exit code: Some(0)`）
- [ ] S7/S8 的可行性结论写入 `docs/01-facts.md`
- [ ] 测试实例就绪（**不要在生产实例上做关闭/擦除实验**）
- [ ] 回滚手册可执行（能在 2 分钟内让按钮消失且不留配置残留）
