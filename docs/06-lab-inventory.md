# 06 · 实验环境登记（2026-09-26 19:05 核对）

> ⚠️ **本文件是本机实验记录**：含绝对路径 / PID / 端口 / 版本目录等本机环境细节。
> 分享或发布前请按 `AGENT.md` §6 脱敏；本机专属的完整信息在未追踪的 `SOURCE.local.md` 与各 home 的 `sandbox-sweep/SOURCE.md`。


## 1. 启动器托管的实例

| 实例 id | 名称 | home | 状态 |
|---|---|---|---|
| `i-0e98ee89-…` | 0.1.5-rc.3 | `homes\0.1.5-rc.3` | **运行中** —— 当前 GUI `http://127.0.0.1:56778` |
| `i-16bfaf0e-…` | 0.1.7-rc.1 | `homes\0.1.7-rc.1` | 未运行 |
| **`i-8352a98d-…`** | **0.1.7-rc.2** | `homes\0.1.7-rc.2` | 19:02:22 拉起（:55785 就绪）→ **19:02:45 已停止（exit code: Some(1)）** |

> ⚠️ **本企划的会话当前运行在 0.1.5-rc.3 实例内**（`DSH_HOME = homes\0.1.5-rc.3`，GUI :56778）。
> 开发与实测必须在 **0.1.7-rc.2 实例**内进行：跨实例没有进程内 API，我只能核对磁盘与登记状态。

## 2. rc.2 实验实例的就位情况（已核对）

| 项 | 值 |
|---|---|
| 版本目录 | `versions\0.1.7-rc.2`，含 `@deepseek-ai/dsh-sandbox-windows-acl` **v0.1.7-rc.2** |
| home | `homes\0.1.7-rc.2` —— **全新**：仅 profiles / sessions / storages / .anonymous-user-id / .credentials.yaml（无 skills、无 attachments） |
| 第三方插件 | **未安装任何插件**；实例日志仅 83 字节（只有 `dsh web` 的 URL 行） |
| 已建会话 | `session-25e10265-…`（`session.v4.jsonl.zstd`，19:02） |
| 登记工作区 | `%USERPROFILE%\Documents\deepseek-harness\default-workspace` |
| 工作区状态 | **空目录（0 子项）且干净**：无 Low 标签、无 `(DENY)`、无能力 ACE |
| 结论 | 该实例**尚未触发过任何 workspace-write 授权**，因此没有任何三件套残留 —— 理想的实验起点 |

## 3. 与 rc.1 的差异（影响本项目）

- 客户端包 **58 → 60**：新增 `@deepseek-ai/dsh-client-shortcuts` 与 `@deepseek-ai/dsh-client-ui-shortcuts`（rc.2 的快捷键功能），其余不变。
- **开发参考路径改为** `versions\0.1.7-rc.2\node_modules\.pnpm\…`（Spike S1/S2 的类型与 bundle 一律取这一份）。
- rc.2 的会话格式为 `session.v4`（rc.1 / 0.1.5 的 home 为 v3 系列）：迁移话题与本项目无关，但注意不要混用 home。

## 4. 下一步（必须在 rc.2 实例内完成）

1. 从启动器启动 **0.1.7-rc.2** 实例并打开其 GUI（端口与 :56778 不同）。
2. 在该实例内安装 hello-world 客户端插件（Spike S2），确认按钮能渲染。
3. 用最小彩色块实测 `sidebar.workspaces` 的 kind 与渲染顺序（Spike S1）。
4. 记录 rc.2 实例**第一条**受限 workspace-write 命令的时刻——那一刻 `default-workspace` 会被写入三件套，可作为"授权时机"的现场验证。

## 5. 旁证：当前 0.1.5-rc.3 会话侧（非本项目目标）

- 本会话工作区根 = 启动器数据目录，其 ACL 至今只有能力 ACE `S-1-4-459936238-1058691224:(OI)(CI)(W,D,DC)`，**无 Low、无 DENY** → 再次印证 0.1.5 只写 ACE。
- 该实例 19:02:50 重启后，provider 于 19:04:36 新建私有 temp `dsh-sNSZk7`（首次受限命令触发授权）。
