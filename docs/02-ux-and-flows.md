# 02 · UI 规格与流程状态机

> **实施现状（2026-09-26，以此为准）**：座位最终落在 **`sidebar.footer.action`**（`sidebar.workspaces` 是 single 型，且"新会话"按钮硬编码在它上方，没有可用座位）；按钮文案 zh 为「**清理沙箱痕迹**」/「**关闭DSH**」（收起态上下排列、带图标）。
> 交互模型已由 **M6.1 + M6.3** 取代本文早期的"勾选 + 二次确认"：**无风险不弹窗**（成功只弹居中的 3 秒气泡，失败才弹窗贴报告）；**有风险才弹窗**，弹窗内**没有任何勾选**——再点一次即视为接受；工作区**本来就没有痕迹**时清理是空操作（不切只读、不终止会话）。
> 本文档下面出现的"勾选/门禁/两步确认"描述只作**设计历史**保留；判定矩阵与实测见 `07-spike-results.md` 的 M6.1 / M6.3。

## 1. 按钮规格

| 项 | 规格 |
|---|---|
| 位置 | **新会话按钮上方**，与工作区列表同宽 |
| 布局 | 一行两枚：容器 `display:flex; gap:8px; width:100%`；每枚 `flex:1 1 0` → 各占新会话按钮宽度的 **1/2** |
| 风格 | 复用按钮原语（`@deepseek-ai/dsh-client-ui-primitives`），高度/圆角/字号/内边距沿用新会话按钮的 token |
| 配色 | **红色外框 + 红色文字**；取主题的 danger 语义变量（禁止硬编码色值，需在浅色/深色两套主题下校验对比度） |
| 文案（zh） | 左：**清理沙箱痕迹**　右：**关闭 DeepSeek Harness** |
| 文案（en） | Left: *Sweep sandbox traces*　Right: *Close DeepSeek Harness* |
| 禁用态 | 宿主不满足前置条件（非 Windows / 权限不足 / 插件宿主半未就绪）→ 置灰 + tooltip 说明原因 |
| 可访问性 | `aria-label` 同文案；危险动作用例需二次确认 |

**座位（待 Spike S1 定稿）**
- 首选：注册进 `sidebar.workspaces`，以更高 `priority`/`order` 排在 workspace occupant 之前 → 视觉上位于工作区列表（含新会话按钮）上方。
- 备选 A：若该槽位是 single 型 → 改注册到 `sidebar.brand.name` 下方最近的既有座位（位置会略高）。
- 备选 B：向上游申请新座位（如 `sidebar.primaryActions`），本项目先以本地 patch 兜住。

## 2. 两个按钮的共同纪律

1. **只读先行**：任何写动作之前先出报告，报告未展示给用户之前不执行任何变更。
2. **阻塞项二分类**（决定用户能否"强制继续"）：
   - **F 类 · 可强制消除**：进行中的回合、运行中的子智能体、后台任务、定时提醒、可关闭的常驻终端。
   - **X 类 · 不可强制消除**：其他活跃实例与本次目标共享工作区；工作区不属于当前用户（ACL 不可写）；ACL 读取失败；目标根不存在或不可访问。
3. **判定规则**：
   - 目标含擦除动作时：**X 类必须为空**，且（F 类为空 **或** 用户显式选择"强制终止"）→ 才允许进入权限回收/擦除。
   - 否则：只能执行"不擦除"的动作（仅关闭），或**终止本次尝试**并给出处置建议。
4. **不满足即终止**：任何门禁不通过，界面必须明确写出"本次尝试已终止 + 原因 + 如何消除"。
5. **每一步可回退**：擦除前的所有步骤都可取消；擦除一旦开始，只能前进（失败则落台账 + 告警）。

## 3. 关闭按钮

### 3.1 状态机
```
IDLE
 └─click→ PRECHECK ──(宿主不可达/非Windows)→ ABORT(告知)
            ├──报告就绪→ CONFIRM
            │        ├─取消→ ABORT(无变更)
            │        ├─选择"仅关闭，不擦除"→ CONFIRM_STOP
            │        └─勾选"一并擦除"→ 门禁判定
            │                 ├─通过→ CONFIRM_STOP
            │                 └─不通过→ BLOCKED(列出 X/F 类 + 处置建议 + 重新检查)
            ├─ CONFIRM_STOP → FENCE → QUIESCE → FLUSH → [ERASE] → DISPOSE → EXIT
            └─ 任一步失败 → FAILED(告知 + 落台账；不静默继续)
```

### 3.2 自检报告字段（PRECHECK 产出）
```ts
interface PreflightReport {
  host: { version: string; home: string; platform: string; canWriteAcl: boolean }
  sessions: Array<{
    id: string; title: string
    turn: 'running' | 'idle' | 'waiting-user'
    subagents: number; jobs: number; schedules: number
    terminals: number            // 常驻终端数
    sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  }>
  workspaces: Array<{
    root: string; objectCountEstimate: number
    trio: { ace: boolean; deny: boolean; lowLabel: boolean }
    ownedByMe: boolean; readable: boolean
    eraseEstimateMs: number       // ≈ objectCount × 0.16 ms
  }>
  otherInstances: Array<{
    pid: number; version: string | null; home: string | null
    port: number | null; workspaces: string[]
    sharesWorkspace: boolean
    hasTrioRisk: boolean          // version >= 0.1.7-alpha.1
    source: 'process-scan' | 'lease' | 'launcher-config'
  }>
  blockers: Array<{ kind: 'F' | 'X'; code: string; detail: string; remedy: string }>
}
```

### 3.3 提示对话框（CONFIRM）
- 标题：**关闭 DeepSeek Harness**
- 顶部（若 F 类非空）：⚠️ *将停止本实例的全部活跃对话*，并逐条列出（回合 / 子智能体 / 后台任务 / 定时提醒 / 常驻终端），与工作区插件"停止并归档"的口径保持一致。
- 中部（若 otherInstances 非空）：列出**全部其他活跃实例**（PID、版本、DSH_HOME、端口、工作区）；对 **≥0.1.7-alpha.1** 的实例加"存在标签残留风险"标记；对**与本实例共享工作区**的实例加红色高亮。
- 底部：复选框 **☑ 本次关闭时一并擦除沙箱痕迹**
  - 默认勾选；存在 X 类阻塞时**自动取消勾选并禁用**。
  - 勾选时显示代价预估："擦除 ≈ 1.2 s（3 个工作区，约 7 600 个对象）；下次启动首条写入命令将重新建立授权（≈0.6 s）"。
- 按钮：`取消` / `关闭但不擦除` / `关闭并擦除`（后者仅在门禁通过时可用）
- 若存在 F 类而未获授权：出现第三选项 **`强制终止对话并关闭`**，点了即视为用户明确授权强制停止。

### 3.4 执行阶段的进度与失败
- 进度分段回报：`关门 → 停止对话 → 等待子进程 → 会话刷盘 → 擦除(逐根) → 校验 → 退出`。
- 每段可显示耗时；失败必须显式呈现（不允许"静默继续"）。
- 由于宿主即将退出，RPC 响应可能收不到：宿主**先回 "accepted"**，客户端切换到"正在关闭…"并在连接断开时结束展示。

## 4. 清理按钮

### 4.1 状态机
```
IDLE
 └─click→ CHECK ──(X 类非空)→ ABORT(告知原因 + 处置建议)
            └─(仅 F 类)→ ASK("是否强制终止这些活跃对话？")
                   ├─否→ ABORT(本次尝试终止)
                   └─是→ REVOKE → [全部成功] → ERASE → DONE(建议重启)
                                      └─[部分失败] → ASK_FAILED(列出失败会话 + 继续/终止)
```

### 4.2 权限回收（REVOKE）
- 目标：把**本实例所有会话**的沙箱模式切到 `read-only`。
- 顺序：先关闭常驻终端（否则会撞上"模式围栏"被拒），再逐会话写 `sandbox/mode`。
- **必须记录每个会话的结果**：`ok | rejected-by-terminal | rejected-other`。
- 有任一失败时：不自动继续；弹出选择 —— `终止本次尝试`（默认）或 `仍然继续擦除`（并明确告知：未切只读的会话在擦除后可能出现写入失败，建议随后重启）。
- 说明（写进对话框的帮助文本）：模式切换**只阻止新的授权**，不打断已在运行的进程；真正让写入停止的是随后的擦除。

### 4.3 擦除（ERASE）
对每个工作区根，**顺序不可颠倒**：
1. 撤销能力 ACE 并清除低标签（走模块 API 或 Win32；**不要用 `icacls /remove:g`**）；
2. 去掉 world 的 `FILE_DELETE_CHILD` 拒绝；
3. 外溢兜底：对每个根的上层目录做深度受限的低标签扫描，发现孤儿就地复位。
4. 校验：根上无 `Low Mandatory Level` / 无 `(DENY)` / 无 `S-1-4-`；目录级全量 + 文件抽样（按配额）。
5. 台账：`{root, startedAt, steps[], verified, failures[]}`；失败项标记 "pending"，供下次启动清扫。

> ⚠️ 上面第 1、2 步的顺序**曾写反**（曾：先去 world 拒绝 → 再撤能力 ACE）。实测反了会踩顺序陷阱：三件套不再精确匹配，`add()` 把它们**整组写回**（重新打 Low），随后 `dispose()` 只撤 ACE 与标签、**拒绝留了下来**——实测 `verified=false / residue=["delete deny"]`。以「**先撤销、后去拒绝**」为准，实测依据见 `docs/03` §2.2。

> 早期规格的第 3 步是「删除本次创建的 `dsh-*` 私有 temp 目录」——**v5 起不再处理实例临时区**，该步已移除，见 `docs/07` 的 M11。

### 4.4 收尾（本方案新增，不可省略）
擦除成功后：
- 将本实例标记为"授权已失效"，**禁止再以 workspace-write 运行**（否则会命中 R1：缓存陈旧 → 静默写失败）；
- 弹出结果面板：擦了什么、校验结果、耗时；
- 提供主按钮 **`立即重启（关闭本实例）`**（跳转到关闭流程）与次按钮 `稍后`（并持续显示"建议重启"横幅）。

## 5. 文案与错误码（草案）

| 场景 | 文案 |
|---|---|
| X 类之一 | `另一个活跃实例（PID 12345，版本 0.1.7-rc.2）正在使用同一工作区 …，擦除会让它的写入开始失败。请先关闭它，然后重新检查。` |
| F 类之一 | `有 2 个对话正在进行工作：…。继续将强制停止这些工作，未完成的步骤不会自动继续。` |
| 门禁不通过 | `本次擦除已终止：存在 1 项无法自动消除的阻塞（见上）。` |
| 权限回收部分失败 | `3 个会话已切换为只读；1 个因常驻终端未能切换。是否仍然继续擦除？` |
| 擦除失败 | `擦除未完成：工作区 … 的校验未通过（残留项：低标签 ×2）。已记录为待清理，将在下次启动时重试。` |
