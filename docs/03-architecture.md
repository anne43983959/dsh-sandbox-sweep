# 03 · 技术方案

## 1. 插件形态

一个包，两半：

```
dsh-sandbox-sweep/
├─ package.json          # 声明 dsh.client（platform: 'web'）+ 宿主入口 + 构建脚本
├─ lib/client.js         # 客户端半的构建产物（缺失会导致激活失败，CI 必须保证存在）
└─ src/
   ├─ host/              # 宿主半（Node，跑在 DSH 宿主进程内 = 不受沙箱限制）
   │  ├─ probe.ts        # 侦察：会话/终端/作业/实例/工作区/三件现状
   │  ├─ ps-scan.ts      # 进程扫描：node.exe 命令行 → 版本 / DSH_HOME / 端口
   │  ├─ lease.ts        # 跨实例租约目录（$DSH_HOME/.instances/<pid>.json）
   │  ├─ erase.ts        # 三步擦除 + 校验 + 台账
   │  ├─ stop.ts         # FENCE → QUIESCE → FLUSH → [ERASE] → DISPOSE → EXIT
   │  └─ rpc.ts          # 注册宿主 RPC：probe / sweepOnly / closeInstance
   ├─ client/            # 客户端半（浏览器）
   │  ├─ index.tsx       # 注册槽位与两个按钮
   │  ├─ buttons.tsx     # 按钮行（半宽、红框红字）
   │  └─ dialogs.tsx     # 自检报告 / 确认 / 进度 / 结果
   └─ shared/types.ts    # 两半共用的类型（PreflightReport 等）
```

**为什么必须两半**：擦除需要 ACL 写权限（受限会话做不到，宿主可以）；UI 按钮需要浏览器侧插件；两者的桥是宿主 RPC。

## 2. 宿主半

### 2.1 probe（只读）
| 数据 | 来源 |
|---|---|
| 本实例版本 / DSH_HOME | 宿主自身（`process.env.DSH_HOME`、包版本） |
| 活跃对话与工作类型 | `ctx.agents` 活跃注册表 + 会话投影（回合/子智能体/作业/定时提醒，口径对齐 workspace 插件） |
| 常驻终端 | `ctx.terminals` 会话清单 |
| 本实例工作区 | sandbox-policy 记录的会话工作区（去重） |
| 三件现状 | 读 ACL（宿主侧，无需提权） |
| 其他活跃实例 | 进程扫描（首选） + 租约目录（补充） |

**进程扫描**：WMI `Win32_Process` 取 `node.exe` 命令行 → 匹配 `versions\\<ver>\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js` → 得到 {pid, version}；再与租约/监听端口关联得到工作区与端口。**取不到版本时标 `unknown` 并按"有风险"处理**（保守）。

### 2.2 erase（三步 + 校验 + 台账）
```ts
// 顺序不可颠倒；每步幂等；每根一把锁（复用生态既有做法：每路径锁文件）
async function eraseRoot(root: string) {
  await revokeCapabilityAndLabel(root)     // ① 必须先做：三件精确在位时 add() 命中跳过（0 传播），dispose() 撤 ACE + 清标签
  await removeWorldDeleteChildDeny(root)   // ② 再去 world 删除拒绝（icacls；Everyone 有名字，可解）
  await sweepSpillAround(root)             // ③ 上层目录深度受限扫描孤儿标签
  return verify(root)                      // ④ 根 + 目录级全量 + 文件抽样（配额）
}
```
> 早期配方里还有一步「③ 删除本次创建的 `dsh-*` 私有 temp 目录」——**v5 起不再处理实例临时区**，该步已移除，见 `docs/07` 的 M11。

- ①实现：`AclWriteGrant.create(workspaceWriteSid(root)) → add(root, false) → dispose()`（实测可彻底移除 ACE 与标签；禁止 `icacls /remove:g`——能力 SID 未映射）。
- ⚠️ **顺序陷阱（本机实测踩到过）**：若先去掉拒绝，三件就不再精确匹配，`add()` 会把三件**重写一遍**（重新打 Low + 全树传播），
  随后 `dispose()` 只撤 ACE + 清标签、**拒绝留了下来**——实测 `verified=false / residue=["delete deny"]`。改回"先撤销、后去拒绝"后 `verified=true / residue=[]`。
- 多个历史能力 SID 需逐个撤销；还有别的能力 ACE 在时标签会被保留，最后一个撤销时才清。
- 代价：擦除 ≈ 0.16 ms/对象；**结果必须回读校验**，失败落台账。

### 2.3 stop（关闭时序）
```
FENCE    置"不再受理新的受限启动"（参照终端后端的模式围栏形状）
QUIESCE  cancel 各 agent → 关终端 → 取消作业 → 等待子进程（超时则强杀并记录）
FLUSH    逐会话 ctx.sessions.flush(session)
ERASE    按用户选择执行（失败按用户选择：中止 / 落台账继续）
DISPOSE  走宿主自身的 dispose 链（保证 sandbox-local 的 temp 撤销执行）
EXIT     最后退出进程
```
- **禁止** 在 DISPOSE 之前 `process.exit()`；
- 退出后启动器日志应出现 `exit code: Some(0)`（硬杀是 `Some(1)`），可作为"是否优雅退出"的判据。

### 2.4 跨实例协调
- **租约目录**：`$DSH_HOME/.instances/<pid>.json` = `{pid, version, port, home, workspaces[], startedAt, heartbeatAt}`；退出时删除；陈旧租约（心跳超时且进程不存在）由任何实例清理。
- **每工作区锁**：与 `sandbox-windows-acl` 相同的每路径锁文件思路，擦除前取锁。
- **共享工作区判定**：租约的 `workspaces[]` ∪ 进程扫描推断结果；命中即产生 X 类阻塞（默认拒绝擦除）。

## 3. 客户端半

- 注册：`ctx.slots.register({ key: 'sidebar.workspaces', priority, order, component })`（座位的 kind 与排序待 S1 确认）。
- 组件：一行两枚按钮（规格见 `docs/02-ux-and-flows.md`），点击后走对话框流程，通过宿主 RPC 取数据/下指令。
- 状态：全部放在插件自己的 `SnapshotStore`；不写全局。
- i18n：`ctx.locale.register('sandbox-sweep', { zh, en })`，中文为键集真源。

## 4. 权限与安全

| 面 | 措施 |
|---|---|
| RPC 鉴权 | 走 `client-connection` 的浏览器会话 + loopback 信任栅栏；破坏性动作额外要求一次性 nonce |
| CSRF | **只接受 POST + nonce**；GET 一律只读（`<img src>` 类请求打不动擦除） |
| 误触 | 风险驱动：无风险直接执行（成功只弹气泡）；有风险弹窗列出风险，**再点一次即视为接受**（弹窗内无勾选，见 07 的 M6.1/M6.3） |
| 越权 | 宿主半只处理"当前用户拥有且 ACL 可写"的目录；不满足即列为 X 类阻塞 |
| 审计 | 台账文件 + 宿主日志双写；记录谁（会话/用户）、何时、擦了哪些根、结果 |

## 5. 兜底（覆盖强杀路径）

- **台账**：`{roots, status: 'granted'|'erased'|'pending', updatedAt}`，写在插件数据目录（非工作区内）。
- **启动清扫**：插件在宿主启动时读取"pending"项并重跑 erase + verify。
- 该兜底是"最终无残留"的唯一保障——进程被 `TerminateProcess` 或断电时，任何退出钩子都不会执行。

## 6. 骨架与文档的对应关系

| 文档 | 对应代码 |
|---|---|
| 02 · 自检报告字段 | `src/shared/types.ts` 的 `PreflightReport` |
| 02 · 门禁二分类 | `src/host/probe.ts` 产出 `blockers`，`src/client/dialogs.tsx` 消费 |
| 03 · 擦除配方 | `src/host/erase.ts` |
| 03 · 关闭时序 | `src/host/stop.ts` |
