# AGENTS.md · 给 agent 的上手说明（dsh-sandbox-sweep）

> 面向：**要读、改、修这个插件的 agent**（含本机其他 DSH 实例里的 agent）。
> **面向使用者的自述**在 [`README.md`](README.md)：按开源惯例排序（值主张 / 功能 / 兼容性 / 安装 / 使用在前，「为什么需要（三件套）」「工作原理」「验证状态」在后）；证据与实测记录在 [`docs/`](docs/)；**本机专属路径与实例信息**在 `SOURCE.local.md`（**不随 Git 追踪**，见文末）。
> 文档里一律用 `$DSH_HOME`、`%APPDATA%`、`<源码目录>` 这类占位符；**不要把本机绝对路径写进被追踪的文件**。

## 1. 30 秒看懂

- **这是什么**：一个 **DSH 原生插件包**（宿主半 Node + 客户端半浏览器），在 WebUI 侧栏脚部加两个按钮：
  **「清理沙箱痕迹」**（擦掉 Windows 沙箱留在工作区上的有害痕迹：删除拒绝 + 低标签）与 **「关闭DSH」**（优雅关闭本实例）。
- **不做外挂**：无用户脚本、无书签、无 DOM 注入、不改 DSH 源码；只以插件包形式安装（支持本地绝对路径安装）。
- **界面在哪**：侧栏座位 `sidebar.footer.action`（list 型）。**不是**"新会话按钮上方"——那个按钮由外壳硬编码、上方没有可用座位。
- **什么时候真的会动东西**：「清理」只在**有要擦的两件**（删除拒绝 / 低标签）时才动手：终止工作 → 权限回收（会话切只读）→ 擦除 → 校验；**只剩能力 ACE 时是空操作**（只弹气泡，v7 口径）。关闭链 v7 起不再切只读（进程随即退出，令牌随进程消失）。**宿主 < `0.1.7-alpha.1` 时整个「清理」按钮都不显示**（v8：那种版本不写三件套，只保留优雅退出）；**v10 起**，宿主版本够、但沙箱已被 `dsh-sandbox-legacy-acl` 接管时同样如此（见 §3「宿主能力分流」）。
- **还会顺手清临时区**：DSH 给每个「会话 × 工作区」在 `%TEMP%` 下建一个 `dsh-<6位>` 临时根（`dsh-sandbox-local` 的 `mkdtempSync`）。**它自己的 dispose 链会删，但本插件的关闭路径拿不到 dispose 入口**（日志实测四个目标全"不可用"）→ 所以**关闭与启动时由插件直接删除**（分层规则见 §3，**不走回收站**）；硬杀 / 崩溃遗留靠启动清扫收。
- **有风险才弹窗**；没枚举到的情况一律**按风险弹窗**，并在弹窗底部给出**可复制的原始自检报告**（详见 §4）。

## 1.5 目录约定（本机）

**所有自建插件一律放在会话工作区根目录下的 `plugins\<包名>\`**（例如 `<工作区根>\plugins\dsh-sandbox-sweep`）。
这样它们永远位于会话工作区内：任何会话都能直接读写，**不需要跨工作区提权**。
本机的绝对路径、安装链接与实例布局见未追踪的 `SOURCE.local.md`（不要写进本文件）。

## 2. 目录与"哪些才是真源码"

| 路径 | 是什么 | 改它？ |
|---|---|---|
| `lib/index.js` | **宿主半（真源码）**：Fetch 路由、自检 `collect()`、擦除 `eraseRoots()`、会话 `revoke/stop`、关闭 `closeInstance/shutdownHost`、跨实例租约与判定、台账与启动清扫、运行时上下文行、随包技能 provider | ✅ 主战场 |
| `lib/client.js` | **客户端半（真源码）**：手写 bundle（`window.__ModuleLoader__.load` 契约）、两个按钮、风险判定 `computeRisks`、弹窗 / 气泡 / 原始报告块 | ✅ 主战场 |
| `assets/sandbox-sweep.md` | 随包分发的**技能**（给模型看的症状→处置说明） | ✅ 可改 |
| `.smoke/*.mjs` | **离线自检**（4 套，见 §5）；开发用，不随包发布 | ✅ 加用例 |
| `README.md` / `AGENTS.md` / `docs/01..07` / `PLAN.md` | 自述 / 上手 / 规格 / 事实 / 证据 / 企划 | ✅ 改完同步 |
| `src/**` | **早期 TypeScript 骨架**（只有类型与 TODO） | ❌ **不是运行时实现，别改** |
| `package.json` | `type: module`、`main: lib/index.js`、`exports {".","./client","./package.json"}`、`dsh.client.platform="web"`、`files:["lib","assets"]` | ⚠️ 小心 |
| `SOURCE.local.md` | **本机专属**源码定位（绝对路径、安装链接、红线） | 🚫 **不追踪、不外发** |

> ⚠️ `.gitignore` 里**曾经**忽略 `lib/`（那时它是构建产物）。现在 `lib/` 是手写源码，已被移出忽略列表——别再加回去。

## 3. 核心契约（改代码前先记住）

| 主题 | 约定 |
|---|---|
| 宿主↔客户端通信 | `ctx.connection.fetch.register({ path, methods, requestBody, fetch })`；**path 必须带 `/api` 前缀**（`endpointFromPath` 要求 `startsWith('/api/')`），否则注册报 `invalid exact Fetch route` |
| 路由 | `POST /api/sandbox-sweep/{probe,capability,erase,revoke,stop-sessions,close}`；关闭开始后一律 409。`capability` 是 v8 新增的**毫秒级**能力探测（只读自己的版本号，不碰 ACL），客户端挂载时问一次 |
| 报告契约版本 | 宿主 `PROBE_VERSION`（**当前 10**）↔ 客户端 `PROBE_MIN`（**当前 10**）：**改动报告字段或判定语义就两边同步 +1**（v4 加 `tempRoots` → v5 撤掉 → v6 以"分层删除清单"的语义加回 → v7 擦除口径定型 → **v8 报告加 `host`（宿主能力）** → **v9 步骤可带 `na`** → **v10 `host` 加 `source` / `tier` / `legacyAcl`（分流依据），并把判定依据写进台账**，见 docs/07 M11/M12/M15/M16/M17/M18），不匹配时客户端按风险弹窗 |
| 客户端 bundle | 手写、无打包器：`window.__ModuleLoader__.load({ id, factory })`；只能 `require` 平台模块表里的 9 个 id（`react`、`react/jsx-runtime`、`react-dom`…） |
| 擦除配方（v7 定型，**只对注册工作区根**） | ① `icacls <root> /remove:d *S-1-1-0`（去 world 删除拒绝）→ ② `icacls <root> /setintegritylevel Medium`（复位完整性标签）→ ③ 回读校验 `deny=false && lowLabel=false`（`residue=[]`）；**两条都只在"该项真的存在"时才执行**（干净项上跑 icacls 会白付一次全树传播：实测 36.5 s）；**全部根级、不加 `/T`**。⚠️ **能力 ACE（`S-1-4-x-y`）一律保留**：它是平台的跨会话复用缓存，撤它会打瘫正在用这个根的其他实例（2026-09-27 实测），且下一次授权要付整树重传播（实测 47.9 s，见 docs/07 M15） |
| 明确无效的做法（历史 / 深度清理备注） | `icacls /remove:g "*S-1-4-…"` 撤能力 ACE **无效**（实测 `processed 0 files`）；唯一通道是模块 API —— 但 v7 起擦除路径**故意不撤**它 |
| 宿主能力分流（v8，**v10 加前置条件**） | `hostCaps()`：**真的会写三件套的宿主**才提供「清理沙箱痕迹」；否则**只提供「关闭DSH」**——不显示清理按钮、关闭链跳过擦除、启动清扫整块跳过、temp 只清自己的根（`sweep=false` 一个口径管三处）。判据 = ① `trioRisk(detectVersion())`（解析 `process.argv` 里的 `versions/<v>/`，本机实测两份 home 分别得 `0.1.5-rc.3` / `0.1.7-rc.2`）**且** ② **沙箱未被 `dsh-sandbox-legacy-acl` 接管**：读 `<DSH_HOME>/sandbox-legacy-acl/report.json`，`status === "installed" && enabled === true` → 判为已接管，**按早期宿主（0.1.5 那一档）处理**；文件不存在 / 读不到 / 解析失败 / 其它 status → **保守回退**到只按宿主版本判。返回里带判定依据：`source`（`legacy-acl-plugin` 或 `host-version`）、`tier`（`legacy` / `trio`）、`legacyAcl:{detected,present,status,enabled,path,error}`，并进自检报告（`report.host`）与台账（条目里的 `host`，由 `hostTag()` 生成） |
| 跨实例判定 | 租约 `$DSH_HOME/sandbox-sweep/instance.json`（60 s 心跳）＋各 home 的 `storages/workspace.json`；探查范围 = `homes/<版本>` 兄弟 home ∪ **默认 `~/.dsh`**；租约只认进程存活 |
| 擦除范围 | **只有注册工作区根**；擦的只有**会害人的两件**（`Everyone:(CI)(DENY)(DC)` 与 Low 标签）。能力 ACE 不在擦除范围（0.1.5 只写它、0.1.7 复用它，两版本的 SID 公式与 ACE mask 相同）→ 擦完的状态 = 「只有 0.1.5 沙箱跑过」的痕迹，无用户可见影响 |
| temp 清理（v7，**删除而非擦除**） | 只碰严格 `^dsh-[A-Za-z0-9]{6}$`（`dsh-spill-*`/`dsh-subprocess-*`/`dsh-ssh-uploads` 一律不碰）。**低风险** = 无 `.lock` ∧ 闲置 ≥10 分钟 → 任何阶段都删；判定为「本机最后一个实例」时**只放宽 `.lock` 一项、仍要求闲置 ≥10 分钟**（v7 收紧，见 docs/07 M14）；扫描失败 ⇒ 只按低风险处理。**直接删除、不走回收站** |
| temp 根的「声明免疫」（v7） | 每个实例启动后在自己的租约 `instance.json` 写 **`tempRoots: [...]`**（精确取自 `ctx.sandbox.tempCapabilities`），别的实例清扫时据此跳过 —— **不再靠「闲置时长」猜有人在用**。2026-09-27 实测事故：靠猜把活实例的根删了，对方沙箱 ACL runner 直接起不来（`--temp is not an existing directory`），该实例随后所有命令被沙箱拒绝 |
| 启动清扫不得动别人的工作区（v7） | ① 硬杀遗留那一步先问 `probeInstances()`：**被同机活实例登记为工作区的根一律不擦**（「本进程还没授权过」这个前提对别的实例并不成立）；② **实例扫描未成功时保守不擦**（只报告）。事故背景见 docs/07 M14 |
| 状态与台账 | `$DSH_HOME/sandbox-sweep/ledger.json`（逐根结果 + `keptAce`（能力 ACE 是否保留）+ `pending` 待擦 + `trigger`；**擦除**条目 trigger = `boot`/`close`/`user`，**temp** 条目 trigger = `temp-boot`/`temp-close`/`temp-user`——关闭流程的擦除曾误用 `user`，已改 `close`）＋ `sandbox-sweep/temp-baseline.json`（本实例启动时已存在的 temp 根 → 用来认"本实例生命周期内新出现的"）；**启动 3 s 后跑启动清扫**：① 硬杀遗留（本进程还没授权过、却仍带**有害两件**的根 —— **能力 ACE 不算残留**，这是第二道结构性护栏；**且不被同机活实例登记**）② 台账 `pending` 补擦（**路径已不存在的条目跳过**）③ **temp 分层删除（静默：只写台账与日志）**；关闭链每步都往实例日志打一行 `close 用时 Nms：…`（诊断「卡在哪一步」） |
| 删除动作 | 插件**会删目录，但只删实例 temp 根**（严格命名 + 分层判据），从不碰工作区里的任何文件；关闭链里 `closeInstance` 的 temp 步骤排在**最后**（甲：报告里排第一、执行放最后——本实例的关闭链自己还要用 TEMP）。删除失败即放弃（`EBUSY`/`EPERM`/`EACCES` = 还有人在用），不做部分强删 |

## 4. 交互规则（作者定的，别改回去）

1. **无风险不弹窗**：成功只弹居中的 3 秒气泡，**失败才弹窗**贴报告。
2. **有风险才弹窗**，弹窗里**没有任何勾选**——**再点一次**「清理」/「关闭DSH」即视为接受；关闭窗 = Esc / 点遮罩 / 右上角 ×。
3. **空操作**：工作区**没有要擦的两项**（删除拒绝 / 低标签；只剩能力 ACE 也算）→ 只弹「无需清理」气泡，**不切只读、不终止会话**。
4. **看不懂就问**：报告结构不认识 / 宿主版本更旧 / 自检自带错误项 / 一个工作区都没列出来 / 判定抛错 → **一律弹窗**（`noop` 强制 false），并在弹窗底部给「原始自检报告（点开可复制）」。

## 5. 改完必跑（离线，不碰任何工作区）

```powershell
node --check lib/index.js ; node --check lib/client.js
node .smoke/risks-test.mjs     # 期望 ALL OK        —— 25 例风险/兜底判定
node .smoke/labels-test.mjs    # 期望 LABELS OK     —— 全量文案键中英齐全
node .smoke/boot-test.mjs      # 期望 DIALOG OK / BOOT OK —— bundle 装载 + 弹窗真渲染
$env:DSH_HOME="<某个 home>" ; node .smoke/probe-offline.mjs "<你的工作区根>"   # 期望 PROBE OK
```

- **用 pwsh 直接跑**：不要在 node 脚本里 `execFileSync(..., { stdio: "pipe" })`——沙箱下会 `spawnSync … EPERM`。
- 这些脚本**只读**（`probe-offline` 会在 `.smoke\` 下造一个假 home 再删掉），可以随手跑。
- ⚠️ `probe-offline.mjs` 的 **B 段依赖「本机没有别的活实例租约」**：同机还有活实例时会报 3 条 `FAIL`，**与代码改动无关**（2026-09-30 实测：同一时刻跑 `HEAD`（v9）基线同样 3 条，见 docs/07 M18）。**F 段（宿主能力分流的前置条件）与环境无关，必须全 PASS**。
- `probe-offline.mjs` 的 **F 段**会临时改写 `process.argv`（伪造 `versions/0.1.7-rc.2` 的命令行）与 `DSH_HOME`（在 `.smoke\fakehome\caps-home` 下造 `sandbox-legacy-acl/report.json`），跑完恢复并删除。
- 改完**必须重启被改的实例**才生效（客户端 bundle 与宿主模块都在启动时装载）。见 §7。

## 6. 红线

1. **不要撤能力 ACE**：它是平台的跨会话复用缓存，撤了会打瘫正在用该根的其它实例（2026-09-27 实测），且下一次授权要付整树重传播。擦除只用 `icacls` 两步（去删除拒绝 / 复位标签），两步之间无顺序依赖。`icacls /remove:g` 撤不掉能力 SID（实测 `processed 0 files`），唯一通道是模块 API —— 留给将来的显式"深度清理"档。
2. **不要拿"正在被当工作区用"的目录做实验**：擦除后该实例受限写入会失败，直到重启（授权缓存不重建）。
3. **只写自己的 home 与源码目录**；不要动别人的 home、不要改 `config.json`（启动器里的 `homes[]/instances[]` 改动不可逆）。
4. 报告字段变化 → `PROBE_VERSION` / `PROBE_MIN` 同步 +1。
5. 需要重跑界面验证时**让作者重启实例**；客户端改动刷新页面无效。
6. 被追踪的文档里**只写占位符**（`%APPDATA%`、`$DSH_HOME`、`<源码目录>`），本机绝对路径只允许出现在 `SOURCE.local.md` 与 home 里的 `sandbox-sweep/SOURCE.md`。

## 7. 安装 / 生效 / 卸载

- **安装**（DSH 插件侧栏"本地绝对路径"安装，或手工两件事）：
  ① 在 `<home>\profiles\<profile>\node_modules\` 下建**符号链接**指向源码目录；
  ② 在该 profile 的 `cordis.patch.yml` 里加：
  ```yaml
  - insert:
      - id: sandbox-sweep
        name: dsh-sandbox-sweep
  ```
- **生效**：重启该实例（宿主与客户端都在启动时装载）。
- **卸载**：删符号链接 + 删 `cordis.patch.yml` 里那条；插件不写注册表、不留服务。
- 本机的**具体安装位置**见 `SOURCE.local.md` §2（其他地方不写）。
- 源码目录约定：`<工作区根>\plugins\<包名>`（见 §1.5）。

## 8. 文档地图

| 文件 | 用途 |
|---|---|
| `README.md` | 面向使用者的自述（按开源惯例排序）：值主张/徽章 → 功能 → 兼容性 → 安装 → 使用 → **安全说明** → 为什么需要（三件套） → 工作原理 → 验证状态 → 设计原则 → 开发背景 → 许可证 |
| `AGENTS.md` | 本文件：agent 上手、契约速查、自检与红线 |
| `PLAN.md` | 企划与里程碑（含决策表 D1–D5） |
| `docs/01-facts.md` | 事实基线：三件套机制、能力边界、启动器行为、插件机制（**本机实测**） |
| `docs/02-ux-and-flows.md` | UI 规格与状态机（**注意文首"实施现状"横幅：交互已由 M6.1/M6.3 取代**） |
| `docs/03-architecture.md` | 技术方案：宿主/客户端分工、擦除配方、关闭时序、跨实例协调 |
| `docs/04-risks-and-acceptance.md` | 风险清单、测试矩阵、**验收现状** |
| `docs/05-preflight-spikes.md` | 开发前 Spike 与环境准备（依赖、安装、回滚） |
| `docs/06-lab-inventory.md` | 实验环境登记（本机各实例/版本） |
| `docs/07-spike-results.md` | **证据日志**：S1–S9、M0–M7、实测数字、回归与修正（最长、最有用） |

> `docs/01,05,06,07` 是**本机实验记录**（含绝对路径、PID、端口、版本目录），分享前请按 §6.6 脱敏；`README.md`、`AGENTS.md`、`PLAN.md`、`docs/02–04` 不含个人信息。

## 9. 找不到源码时

1. 先看**本实例 home** 里的 `sandbox-sweep/SOURCE.md`（插件每次启动自动写入，含源码目录与安装位置）；
2. 再看源码目录里的 `SOURCE.local.md`（完整版）；
3. 还可从 `<home>\profiles\<profile>\cordis.patch.yml` 找到插件包名 `dsh-sandbox-sweep`，顺藤摸到 `node_modules` 下的符号链接；
4. 本机所有自建插件都在**会话工作区根**的 `plugins\` 下（见 §1.5）。
