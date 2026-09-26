# AGENT.md · 给 agent 的上手说明（dsh-sandbox-sweep）

> 面向：**要读、改、修这个插件的 agent**（含本机其他 DSH 实例里的 agent）。
> 用户向自述在 [`README.md`](README.md)；证据与实测记录在 [`docs/`](docs/)；**本机专属路径与实例信息**在 `SOURCE.local.md`（**不随 Git 追踪**，见文末）。
> 文档里一律用 `$DSH_HOME`、`%APPDATA%`、`<源码目录>` 这类占位符；**不要把本机绝对路径写进被追踪的文件**。

## 1. 30 秒看懂

- **这是什么**：一个 **DSH 原生插件包**（宿主半 Node + 客户端半浏览器），在 WebUI 侧栏脚部加两个按钮：
  **「清理沙箱痕迹」**（撤销 Windows 沙箱留在工作区上的"三件套"）与 **「关闭DSH」**（优雅关闭本实例）。
- **不做外挂**：无用户脚本、无书签、无 DOM 注入、不改 DSH 源码；只以插件包形式安装（支持本地绝对路径安装）。
- **界面在哪**：侧栏座位 `sidebar.footer.action`（list 型）。**不是**"新会话按钮上方"——那个按钮由外壳硬编码、上方没有可用座位。
- **什么时候真的会动东西**：工作区**本来就没有痕迹**时「清理」是**空操作**（只弹气泡）；有痕迹才走"终止工作 → 权限回收（会话切只读）→ 擦除 → 校验"。
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
| `README.md` / `AGENT.md` / `docs/01..07` / `PLAN.md` | 自述 / 上手 / 规格 / 事实 / 证据 / 企划 | ✅ 改完同步 |
| `src/**` | **早期 TypeScript 骨架**（只有类型与 TODO） | ❌ **不是运行时实现，别改** |
| `package.json` | `type: module`、`main: lib/index.js`、`exports {".","./client","./package.json"}`、`dsh.client.platform="web"`、`files:["lib","assets"]` | ⚠️ 小心 |
| `SOURCE.local.md` | **本机专属**源码定位（绝对路径、安装链接、红线） | 🚫 **不追踪、不外发** |

> ⚠️ `.gitignore` 里**曾经**忽略 `lib/`（那时它是构建产物）。现在 `lib/` 是手写源码，已被移出忽略列表——别再加回去。

## 3. 核心契约（改代码前先记住）

| 主题 | 约定 |
|---|---|
| 宿主↔客户端通信 | `ctx.connection.fetch.register({ path, methods, requestBody, fetch })`；**path 必须带 `/api` 前缀**（`endpointFromPath` 要求 `startsWith('/api/')`），否则注册报 `invalid exact Fetch route` |
| 路由 | `POST /api/sandbox-sweep/{probe,erase,revoke,stop-sessions,close}`；关闭开始后一律 409 |
| 报告契约版本 | 宿主 `PROBE_VERSION` ↔ 客户端 `PROBE_MIN`：**改字段结构就两边同步 +1**，不匹配时客户端按风险弹窗 |
| 客户端 bundle | 手写、无打包器：`window.__ModuleLoader__.load({ id, factory })`；只能 `require` 平台模块表里的 9 个 id（`react`、`react/jsx-runtime`、`react-dom`…） |
| 擦除配方（顺序不可换） | ① `AclWriteGrant.create(workspaceWriteSid(root)).add(root,false).dispose()`（撤能力 ACE + 清低标签）→ ② `icacls <root> /remove:d *S-1-1-0`（去 world 删除拒绝）→ ③ 回读校验 `residue=[]`；**全部根级、不加 `/T`** |
| 明确无效的做法 | `icacls /remove:g "*S-1-4-…"` 撤能力 ACE（实测 `processed 0 files`） |
| 跨实例判定 | 租约 `$DSH_HOME/sandbox-sweep/instance.json`（60 s 心跳）＋各 home 的 `storages/workspace.json`；探查范围 = `homes/<版本>` 兄弟 home ∪ **默认 `~/.dsh`**；租约只认进程存活 |
| 状态与台账 | `$DSH_HOME/sandbox-sweep/ledger.json`（逐根结果 + `pending` 待擦）；**启动 3 s 后自动补擦 pending** |

## 4. 交互规则（用户定的，别改回去）

1. **无风险不弹窗**：成功只弹居中的 3 秒气泡，**失败才弹窗**贴报告。
2. **有风险才弹窗**，弹窗里**没有任何勾选**——**再点一次**「清理」/「关闭DSH」即视为接受；关闭窗 = Esc / 点遮罩 / 右上角 ×。
3. **空操作**：工作区三项全 false → 只弹「无需清理」气泡，**不切只读、不终止会话**。
4. **看不懂就问**：报告结构不认识 / 宿主版本更旧 / 自检自带错误项 / 一个工作区都没列出来 / 判定抛错 → **一律弹窗**（`noop` 强制 false），并在弹窗底部给「原始自检报告（点开可复制）」。

## 5. 改完必跑（离线，不碰任何工作区）

```powershell
node --check lib/index.js ; node --check lib/client.js
node .smoke/risks-test.mjs     # 期望 ALL OK        —— 21 例风险/兜底判定
node .smoke/labels-test.mjs    # 期望 LABELS OK     —— 全量文案键中英齐全
node .smoke/boot-test.mjs      # 期望 DIALOG OK / BOOT OK —— bundle 装载 + 弹窗真渲染
$env:DSH_HOME="<某个 home>" ; node .smoke/probe-offline.mjs "<你的工作区根>"   # 期望 PROBE OK
```

- 这些脚本**只读**（`probe-offline` 会在 `.smoke\` 下造一个假 home 再删掉），可以随手跑。
- 改完**必须重启被改的实例**才生效（客户端 bundle 与宿主模块都在启动时装载）。见 §7。

## 6. 红线

1. 撤能力 ACE 只能走**模块 API**，不要用 `icacls /remove:g`；顺序必须"先撤 ACE/标签，再去 world 拒绝"（反了会被 `add()` 整组写回）。
2. **不要拿"正在被当工作区用"的目录做实验**：擦除后该实例受限写入会失败，直到重启（授权缓存不重建）。
3. **只写自己的 home 与源码目录**；不要动别人的 home、不要改 `config.json`（启动器里的 `homes[]/instances[]` 改动不可逆）。
4. 报告字段变化 → `PROBE_VERSION` / `PROBE_MIN` 同步 +1。
5. 需要重跑界面验证时**让用户重启实例**；客户端改动刷新页面无效。
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
| `README.md` | 用户向自述：按钮做什么、安装即知悉的影响、什么时候会/不会打扰你 |
| `AGENT.md` | 本文件：agent 上手、契约速查、自检与红线 |
| `PLAN.md` | 企划与里程碑（含决策表 D1–D5） |
| `docs/01-facts.md` | 事实基线：三件套机制、能力边界、启动器行为、插件机制（**本机实测**） |
| `docs/02-ux-and-flows.md` | UI 规格与状态机（**注意文首"实施现状"横幅：交互已由 M6.1/M6.3 取代**） |
| `docs/03-architecture.md` | 技术方案：宿主/客户端分工、擦除配方、关闭时序、跨实例协调 |
| `docs/04-risks-and-acceptance.md` | 风险清单、测试矩阵、**验收现状** |
| `docs/05-preflight-spikes.md` | 开发前 Spike 与环境准备（依赖、安装、回滚） |
| `docs/06-lab-inventory.md` | 实验环境登记（本机各实例/版本） |
| `docs/07-spike-results.md` | **证据日志**：S1–S9、M0–M7、实测数字、回归与修正（最长、最有用） |

> `docs/01,05,06,07` 是**本机实验记录**（含绝对路径、PID、端口、版本目录），分享前请按 §6.6 脱敏；`README.md`、`AGENT.md`、`PLAN.md`、`docs/02–04` 不含个人信息。

## 9. 找不到源码时

1. 先看**本实例 home** 里的 `sandbox-sweep/SOURCE.md`（插件每次启动自动写入，含源码目录与安装位置）；
2. 再看源码目录里的 `SOURCE.local.md`（完整版）；
3. 还可从 `<home>\profiles\<profile>\cordis.patch.yml` 找到插件包名 `dsh-sandbox-sweep`，顺藤摸到 `node_modules` 下的符号链接；
4. 本机所有自建插件都在**会话工作区根**的 `plugins\` 下（见 §1.5）。
