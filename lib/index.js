/**
 * dsh-sandbox-sweep · 宿主半（M2：只读自检 + 擦除三件套）
 *
 * 桥接：ctx.connection.fetch.register({ path, methods, requestBody, fetch })
 *   path 必须带 /api 前缀（endpointFromPath 要求 startsWith('/api/')）。
 *
 * 端点：
 *   POST /api/sandbox-sweep/probe   —— 只读自检（M1）
 *   POST /api/sandbox-sweep/erase   —— 擦除三件套（M2）；body { dryRun, roots }
 *
 * 擦除配方（顺序不可颠倒，皆为根级一次调用；见 docs/03-architecture.md）：
 *   ① 模块 API 撤销能力 ACE 并清除低标签       —— AclWriteGrant.create(sid).add(root,false).dispose()
 *      （必须最先做：三件精确在位时 add() 跳过、0 传播；不用 icacls /remove:g——能力 SID 未映射，实测 processed 0 files）
 *   ② icacls <root> /remove:d *S-1-1-0        —— 去掉 world 删除拒绝
 *   ③ 回读校验：根上不得再有 Low / (DENY) / S-1-4-
 * 台账写入 DSH_HOME/sandbox-sweep/ledger.json，供启动清扫兜底。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);

export const name = "sandbox-sweep";
export const inject = ["connection"];

/**
 * 自检报告的契约版本。客户端认识的最低版本写在 lib/client.js 的 PROBE_MIN。
 * 版本对不上时客户端**按风险处理并弹窗**（把原始报告摆给作者），绝不静默当成"没问题"。
 * 改动报告字段结构时同步 +1。
 */
const PROBE_VERSION = 9;   // v9：无 terminals 服务的宿主上「关闭常驻终端」记 na（不再误报 fail）；v8：报告加宿主能力（host.trioHost）—— < 0.1.7-alpha.1 的宿主只提供优雅退出（见 docs/07 M16/M17）
const ROUTE_PROBE = "/api/sandbox-sweep/probe";
const ROUTE_ERASE = "/api/sandbox-sweep/erase";
const ROUTE_CLOSE = "/api/sandbox-sweep/close";
const ROUTE_REVOKE = "/api/sandbox-sweep/revoke";
const ROUTE_STOP = "/api/sandbox-sweep/stop-sessions";
const ROUTE_CAPABILITY = "/api/sandbox-sweep/capability";
const DENY_SID = "*S-1-1-0";

/**
 * 解码子进程输出。icacls / Windows PowerShell 5.1 走控制台代码页（简体中文为 GBK/936），
 * 直接按 UTF-8 解码会出现乱码（实测 "�Ѵ������ļ�"）。先用 UTF-8 试，出现替换字符再按 GBK 解。
 */
function decodeOut(raw) {
	const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw === null || raw === undefined ? "" : raw), "utf8");
	const utf8 = buf.toString("utf8");
	if (utf8.indexOf("\uFFFD") === -1) return utf8;
	try {
		return new TextDecoder("gbk").decode(buf);
	} catch (error) {
		return utf8;
	}
}

/** 取多行输出的最后一行非空内容并截断，避免把整段 icacls 输出塞进界面。 */
function lastLine(text, limit) {
	const lines = String(text || "").split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });
	const line = lines.length > 0 ? lines[lines.length - 1].trim() : "";
	return line.slice(0, limit || 120);
}

function msg(error) {
	return String((error && error.message) || error);
}

/** 给 promise 加超时，避免 dispose 之类的调用把关闭流程卡死。 */
function withTimeout(promise, ms, label) {
	return Promise.race([
		promise,
		new Promise(function (resolve) { setTimeout(function () { resolve(label + ": 超时 " + ms + "ms"); }, ms); }),
	]);
}

function json(data, status) {
	return new Response(JSON.stringify(data), {
		status: status || 200,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

function detectVersion() {
	const argv = process.argv.join(" ");
	const m = argv.match(/versions[\\/]([^\\/]+)[\\/]/);
	return m ? m[1] : null;
}

function trioRisk(version) {
	if (version === null || version === undefined) return "unknown";
	// 三件套自 0.1.7-alpha.1 起写入
	if (/^0\.1\.7-alpha\.[1-9]/.test(version)) return "yes";
	if (/^0\.1\.7-rc\./.test(version)) return "yes";
	if (/^0\.1\.7$/.test(version)) return "yes";
	const m = version.match(/^(\d+)\.(\d+)\./);
	if (m) {
		const major = Number(m[1]);
		const minor = Number(m[2]);
		if (major > 0) return "yes";
		if (major === 0 && minor >= 7) return "yes";
		return "no";
	}
	return "unknown";
}

/** 三件套从哪个版本开始写。 */
const TRIO_SINCE = "0.1.7-alpha.1";

/**
 * 本宿主能做什么（v8）。界面与关闭链都按它分流：
 *   - **会写三件套的宿主**（≥ 0.1.7-alpha.1）：提供「清理沙箱痕迹」+「关闭DSH」，关闭链按需擦除；
 *   - **更早的宿主**（如 0.1.5-rc.x）：它的沙箱只写能力 ACE，而能力 ACE 按 v7 口径是平台的复用缓存、
 *     一律不擦 → 这里**只提供「优雅退出」**：不显示清理按钮、不做任何 ACL 操作、不扫别人的根
 *     （作者 2026-09-27 定的行为；低版本要清 0.1.7 的残留请用技能 low-integrity-repair）。
 */
function hostCaps() {
	const version = detectVersion();
	const trio = trioRisk(version) === "yes";
	return {
		hostVersion: version,
		trioHost: trio,
		trioSince: TRIO_SINCE,
		sweep: trio,
		close: true,
		note: trio
			? "宿主会写三件套（≥ " + TRIO_SINCE + "）：提供「清理沙箱痕迹」+「关闭DSH」"
			: "宿主 " + (version || "?") + " < " + TRIO_SINCE + "（不写三件套）：只提供「关闭DSH」，不做 ACL 操作",
	};
}

/** 读一个根的 ACL 三件套状态（null = 读不到，未知）。 */
async function probeRoot(root) {
	const out = { root: root, ace: null, deny: null, lowLabel: null, error: null };
	try {
		const r = await run("icacls", [root], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: "buffer" });
		const text = decodeOut(r.stdout);
		out.ace = /S-1-4-\d+-\d+/.test(text);
		out.deny = /\(DENY\)/.test(text);
		out.lowLabel = /Low Mandatory Level/.test(text);
	} catch (error) {
		out.error = String((error && error.message) || error);
	}
	return out;
}

/** 并发跑一批任务（默认 8 路）：上百个 icacls 串行要 ~2 s，并发后 ~0.3 s。 */
async function mapPool(items, limit, worker) {
	const out = new Array(items.length);
	let next = 0;
	const runOne = async function () {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await worker(items[i], i);
		}
	};
	const runners = [];
	for (let k = 0; k < Math.min(limit || 4, items.length); k++) runners.push(runOne());
	await Promise.all(runners);
	return out;
}

/* ------------------------- 跨实例租约（同工作区判定） ------------------------- */

function leasePathOf(homeDir) {
	return join(homeDir, "sandbox-sweep", "instance.json");
}

/** 规范化路径用于比较（统一分隔符 + 去尾斜杠 + NFC + 小写，Windows 大小写不敏感）。 */
function canonPath(p) {
	return String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").normalize("NFC").toLowerCase();
}

/** 进程是否还活着（Windows 上 signal 0 的探测行为与 POSIX 一致：不存在则抛）。 */
function pidAlive(pid) {
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch (error) {
		return false;
	}
}

/**
 * 在本实例 home 里写一份"源码在哪"的说明（`$DSH_HOME/sandbox-sweep/SOURCE.md`）。
 * 目的：本机其他实例（或后来接手的人/agent）在按钮出问题时，能从这个文件一路找到源码与自检方法。
 * 内容是本机专属信息，**只写 home，不写进被 Git 追踪的仓库文件**；完整版见源码目录里的 `SOURCE.local.md`。
 */
async function publishSourceNote(ctx) {
	try {
		const home = process.env.DSH_HOME;
		if (!home) return null;
		const sourceDir = dirname(fileURLToPath(import.meta.url));   // <源码>/lib
		const repoDir = dirname(sourceDir);                          // <源码>
		const installs = [];
		try {
			for (const profile of await readdir(join(home, "profiles"), { withFileTypes: true })) {
				if (!profile.isDirectory()) continue;
				const candidate = join(home, "profiles", profile.name, "node_modules", "dsh-sandbox-sweep");
				try {
					await access(candidate);   // 只列真的存在的那一个
					installs.push(candidate);
				} catch (error) {
					/* 该 profile 没装 */
				}
			}
		} catch (error) {
			/* 没有 profiles 目录就算了 */
		}
		const lines = [
			"# dsh-sandbox-sweep · 源码定位（本实例启动时自动写入，可覆盖）",
			"",
			"> 侧栏「清理沙箱痕迹」/「关闭DSH」这两个按钮出问题、或需要改这个插件时，看这里。",
			"> 本文件是本机专属信息，**不要提交到任何仓库、不要外发**。",
			"",
			"| 项 | 值 |",
			"|---|---|",
			"| 写入时间 | " + new Date().toISOString() + " |",
			"| 插件版本/实例 | " + String(detectVersion() || "?") + " |",
			"| 本实例 home | " + home + " |",
			"| **源码目录** | " + repoDir + " |",
			"| 宿主半 | " + join(repoDir, "lib", "index.js") + " |",
			"| 客户端半 | " + join(repoDir, "lib", "client.js") + " |",
			"| 说明文档 | " + join(repoDir, "SOURCE.local.md") + "（完整版）、README.md、AGENTS.md、docs/ |",
			"| 本实例的安装位置 | " + (installs.length ? installs.join(" ; ") : "（未找到 node_modules 下的安装链接）") + " |",
			"",
			"## 改完怎么生效",
			"",
			"改源码 → **重启本实例**（客户端 bundle 与宿主模块都在启动时装载，刷新页面不够）。",
			"",
			"## 改完先跑这四套离线自检（不碰工作区）",
			"",
			"```powershell",
			"cd " + repoDir,
			"node --check lib/index.js ; node --check lib/client.js",
			"node .smoke/risks-test.mjs ; node .smoke/labels-test.mjs ; node .smoke/boot-test.mjs",
			"$env:DSH_HOME=\"" + home + "\" ; node .smoke/probe-offline.mjs \"<你的工作区根>\"",
			"```",
			"",
			"## 红线",
			"",
			"1. **不要撤能力 ACE**（`S-1-4-x-y`）：它是平台的跨会话复用缓存 —— 撤了会让正在用这个根的其他实例写不进去（2026-09-27 实测），且下一次授权要付整树重传播；`icacls /remove:g` 也撤不掉它（实测 processed 0 files）。",
			"2. 擦除只用 `icacls` 两步：`/remove:d *S-1-1-0`（去删除拒绝）→ `/setintegritylevel Medium`（复位标签）；**根级一次足够，不要加 `/T`**；两步都只在「该项真的存在」时才执行。",
			"3. **版本分流（v8）**：宿主 < `0.1.7-alpha.1` 不写三件套 → 只提供「关闭DSH」（不显示清理按钮、不做任何 ACL 操作）。",
			"4. 报告字段结构 / 判定语义改动时，同步 +1：宿主 `PROBE_VERSION` ↔ 客户端 `PROBE_MIN`。",
			"",
		];
		const file = join(home, "sandbox-sweep", "SOURCE.md");
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, lines.join("\n"), "utf8");
		return file;
	} catch (error) {
		return null;
	}
}

/** 广播本实例的"身份 + 我占用的工作区"，供同机其他实例判定是否共享工作区。 */
async function writeLease(ctx) {
	try {
		const home = process.env.DSH_HOME;
		if (!home) return null;
		const payload = {
			pid: process.pid,
			version: detectVersion(),
			home: home,
			workspaces: parseRoots({}, ctx),
			// v7：**声明**本实例自己的 temp 根（精确取自 sandbox provider）。
			// 别的实例据此跳过"有人在用"的根 —— 不再靠"闲置时长"猜。
			// 实测事故（2026-09-27）：靠猜会把活实例的根当垃圾删掉，直接打瘫对方的沙箱后端。
			tempRoots: providerTempDirs(ctx),
			heartbeatAt: new Date().toISOString(),
		};
		const file = leasePathOf(home);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(payload, null, 2), "utf8");
		return file;
	} catch (error) {
		return null;
	}
}

/**
 * 同机可能需要探查的其他 DSH home：
 *   ① 启动器布局 `$DSH_HOME` 的兄弟目录（homes/<版本>）；
 *   ② **默认 home `~/.dsh`**——DSH 未设 `$DSH_HOME` 时的 home（`@deepseek-ai/dsh-home-paths` 的
 *      `defaultDshHome() = join(homedir(), ".dsh")`；优先级：显式配置 > `$DSH_HOME` > `~/.dsh`）。
 * 自己所在的 home 永远排除。
 */
async function peerHomes() {
	const home = process.env.DSH_HOME;
	let own = home;
	try { own = home || join(homedir(), ".dsh"); } catch (error) { /* 取不到 HOME 就不排除 */ }
	const out = [];
	const seen = new Set();
	const push = function (dir) {
		if (!dir) return;
		const key = canonPath(dir);
		if (seen.has(key)) return;
		if (own && key === canonPath(own)) return;
		seen.add(key);
		out.push(dir);
	};
	if (home) {
		try {
			for (const entry of await readdir(dirname(home), { withFileTypes: true })) {
				if (entry.isDirectory()) push(join(dirname(home), entry.name));
			}
		} catch (error) {
			/* 没有兄弟 home */
		}
	}
	try { push(join(homedir(), ".dsh")); } catch (error) { /* 取不到 HOME 就跳过 */ }
	return out;
}

/** 读取同机其他 DSH home 下的租约（只认"心跳新鲜 + 进程还活着"的）。 */
async function readPeerLeases() {
	const out = [];
	for (const peerHome of await peerHomes()) {
		try {
			const lease = JSON.parse(await readFile(leasePathOf(peerHome), "utf8"));
			const fresh = lease.heartbeatAt ? Date.now() - Date.parse(lease.heartbeatAt) < 3 * 60 * 1000 : false;
			if (!fresh || !pidAlive(lease.pid)) continue;
			out.push(lease);
		} catch (error) {
			/* 该 home 没有租约（实例未安装本插件） */
		}
	}
	return out;
}

/**
 * 同机"其他 home 可能使用的工作区"全集：租约声明（装了本插件）∪ home 自己的 workspace 登记（任何版本都有）。
 * 用它来判断"别的实例到底有没有可能碰到我们的根"——比"只要有机上还有 dsh 进程就提示"精确得多。
 */
async function readPeerWorkspaceRoots() {
	const roots = new Set();
	for (const peerHome of await peerHomes()) {
		try {
			const lease = JSON.parse(await readFile(leasePathOf(peerHome), "utf8"));
			// 只认"进程还活着"的租约：进程都没了就不可能再用我们的根，不必拿它打扰作者
			if (pidAlive(lease.pid)) {
				for (const w of lease.workspaces || []) roots.add(canonPath(w));
			}
		} catch (error) {
			/* 该 home 没有租约 */
		}
		try {
			const registry = JSON.parse(await readFile(join(peerHome, "storages", "workspace.json"), "utf8"));
			const table = registry && registry.tables && registry.tables.workspaces;
			for (const key of Object.keys(table || {})) {
				const path = table[key] && table[key].path;
				if (path) roots.add(canonPath(path));
			}
		} catch (error) {
			/* 该 home 没有登记表 */
		}
	}
	return roots;
}

async function probeInstances(ctx) {
	const self = process.pid;
	const list = [];
	const errors = [];
	let scanned = false;
	try {
		const ps =
			"Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
		const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
			windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
		});
		/* 走到这里说明 powershell 正常退出（非零退出会被 execFile 直接抛错） */
		scanned = true;
		const raw = decodeOut(r.stdout).trim();
		const parsed = raw ? JSON.parse(raw) : [];
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		for (const row of rows) {
			const cmd = String(row.CommandLine || "");
			if (cmd.indexOf("dsh") === -1) continue;
			if (row.ProcessId === self) continue;
			const m = cmd.match(/versions[\\/]([^\\/]+)[\\/]/);
			const version = m ? m[1] : null;
			list.push({ pid: row.ProcessId, version: version, home: null, port: null, workspaces: [], risk: trioRisk(version), source: "process-scan" });
		}
	} catch (error) {
		errors.push("实例扫描失败: " + String((error && error.message) || error));
	}

	// 合并租约：能读到租约的实例，才知道它占用了哪些工作区；读不到的只能标"未确认"
	try {
		const mine = parseRoots({}, ctx).map(canonPath);
		for (const lease of await readPeerLeases()) {
			const shares = (lease.workspaces || []).map(canonPath).some(function (w) { return mine.indexOf(w) !== -1; });
			const hit = list.filter(function (x) { return x.pid === lease.pid; })[0];
			if (hit) {
				hit.home = lease.home;
				hit.workspaces = lease.workspaces || [];
				hit.sharesWorkspace = shares;
				hit.verified = true;
				hit.source = "process-scan+lease";
			} else {
				list.push({
					pid: lease.pid,
					version: lease.version || null,
					home: lease.home || null,
					port: null,
					workspaces: lease.workspaces || [],
					sharesWorkspace: shares,
					verified: true,
					risk: trioRisk(lease.version || null),
					source: "lease",
				});
			}
		}
	} catch (error) {
		errors.push("租约合并失败: " + msg(error));
	}
	// 没有租约的实例：用"兄弟 home 的工作区登记"判断它有没有可能碰到我们的根。
	// 没人登记过我们的根 → 判为不共享（不打扰作者）；有人登记过 → 仍标 null（无法归属到具体进程，按风险提示）。
	let anyPeerMentionsMine = false;
	try {
		const mine = parseRoots({}, ctx).map(canonPath);
		const peerRoots = await readPeerWorkspaceRoots();
		anyPeerMentionsMine = mine.some(function (w) { return peerRoots.has(w); });
	} catch (error) {
		errors.push("同机工作区登记读取失败: " + msg(error));
		anyPeerMentionsMine = true;   // 读不到就保守处理
	}
	for (const item of list) {
		if (item.verified === undefined) {
			item.verified = false;
			item.sharesWorkspace = anyPeerMentionsMine ? null : false;
		}
	}
	return { list: list, errors: errors, scanned: scanned };
}

function agentId(agent) {
	try {
		if (!agent) return null;
		if (typeof agent.sessionId === "string") return agent.sessionId;
		if (agent.session && typeof agent.session.id === "string") return agent.session.id;
		if (typeof agent.id === "string") return agent.id;
	} catch (error) {
		return null;
	}
	return null;
}

async function collect(ctx) {
	const errors = [];
	const services = {};
	const report = {
		probeVersion: PROBE_VERSION,
		host: hostCaps(),
		collectedAt: new Date().toISOString(),
		host: {
			version: detectVersion(),
			home: process.env.DSH_HOME || null,
			platform: process.platform,
			node: process.versions.node,
			webUrl: process.env.DSH_WEB_URL || webUrlOf(ctx),
			pid: process.pid,
		},
		sessions: [], terminals: [], jobs: [], workspaces: [], otherInstances: [],
		services: services, errors: errors,
	};

	const agents = ctx.get("agents");
	services.agents = Boolean(agents);
	if (agents && typeof agents.list === "function") {
		try {
			for (const agent of agents.list()) {
				const id = agentId(agent);
				const row = { id: id, turn: "unknown", terminals: 0, jobs: 0, schedules: 0, activity: [] };
				try {
					const activity = await ctx.waterfall("workspace/session-activity", { sessionId: id }, function () { return Promise.resolve([]); });
					row.activity = (activity || []).map(function (a) {
						return String(a && a.kind) + (a && a.items && a.items.length ? "×" + a.items.length : "");
					});
				} catch (error) {
					/* 活动查询不可用不影响主体报告 */
				}
				const terminals = ctx.get("terminals");
				if (terminals && typeof terminals.list === "function" && agent) {
					try {
						const sessions = terminals.list(agent) || [];
						row.terminals = sessions.length;
						for (const s of sessions) report.terminals.push({ session: id, name: s && s.name, status: s && s.status });
					} catch (error) {
						errors.push("终端枚举失败(" + id + "): " + String((error && error.message) || error));
					}
				}
				report.sessions.push(row);
			}
		} catch (error) {
			errors.push("会话枚举失败: " + String((error && error.message) || error));
		}
	}

	const jobs = ctx.get("jobs");
	services.jobs = Boolean(jobs);
	if (jobs && typeof jobs.list === "function") {
		try {
			for (const job of jobs.list() || []) report.jobs.push({ id: job && job.id, kind: job && job.kind, status: job && job.status });
		} catch (error) {
			errors.push("作业枚举失败: " + String((error && error.message) || error));
		}
	}

	const registry = ctx.get("workspaceRegistry");
	services.workspaceRegistry = Boolean(registry);
	const roots = [];
	if (registry && typeof registry.list === "function") {
		try {
			for (const ws of registry.list() || []) {
				const path = ws && (ws.path || ws.root);
				if (path && roots.indexOf(path) === -1) roots.push(path);
			}
		} catch (error) {
			errors.push("工作区枚举失败: " + String((error && error.message) || error));
		}
	}
	services.sandboxPolicy = Boolean(ctx.get("sandboxPolicy"));
	for (const root of roots) report.workspaces.push(await probeRoot(root));

	const others = await probeInstances(ctx);
	report.otherInstances = others.list;
	report.instancesScanned = others.scanned;
	for (const e of others.errors) errors.push(e);

	// 实例 temp 根（v6）：报当前清单——"能清几个 / 几个还占着"，界面据此显示；清理本身在启动/关闭/点按钮时做
	try {
		const inv = await scanTempRoots(false);
		const baseline = await readTempBaseline();
		const known = {};
		for (const b of baseline) known[canonPath(b)] = true;
		let idle = 0, locked = 0, fresh = 0, selfLifetime = 0;
		for (const r of inv.roots) {
			if (!known[canonPath(r.root)]) selfLifetime += 1;
			if (r.locks > 0) locked += 1;
			else if (r.idle) idle += 1;
			else fresh += 1;
		}
		const lastInstance = others.scanned === true && others.list.length === 0;
		report.tempRoots = {
			parents: inv.parents, scanned: inv.scanned, selfLifetime: selfLifetime,
			idle: idle, locked: locked, fresh: fresh,
			deletable: idle + (lastInstance ? locked + fresh : 0),
			othersScanned: others.scanned === true, othersCount: others.list.length, lastInstance: lastInstance,
			sample: inv.roots.slice(0, 8).map(function (r) {
				return { root: r.root, idle: r.idle, locks: r.locks, deny: r.deny, lowLabel: r.lowLabel, entries: r.entries };
			}),
		};
	} catch (error) {
		report.tempRoots = null;
		errors.push("temp 目录扫描失败: " + msg(error));
	}
	return report;
}

function webUrlOf(ctx) {
	try {
		const ws = ctx.get("webServer");
		if (!ws) return null;
		const srv = ws.server || ws.httpServer;
		const addr = srv && typeof srv.address === "function" ? srv.address() : null;
		if (addr && typeof addr === "object") return "http://127.0.0.1:" + addr.port + "/";
	} catch (error) {
		return null;
	}
	return null;
}

/* ------------------------------- 擦除（M2） ------------------------------- */

/**
 * 动态载入沙箱模块（版本无关）。
 * 我们的插件不在 DSH 安装树内，裸导入解析不到；而 pnpm 布局下包也不在顶层 node_modules。
 * 依次尝试：① 以 dsh 包为锚点 require.resolve ② 扫 .pnpm 里的 dsh-sandbox-wi* 目录 ③ 裸导入。
 */
const dshModuleCache = new Map();

/** 从给定的这些命令行串里推断 DSH 安装目录（取其 /node_modules 之前的部分）。 */
function versionDirsFrom(sources) {
	const dirs = [];
	for (const raw of sources) {
		const norm = String(raw || "").replace(/\\/g, "/");
		const idx = norm.indexOf("/node_modules/");
		if (idx < 0) continue;
		const dir = norm.slice(0, idx);
		if (dirs.indexOf(dir) === -1) dirs.push(dir);
	}
	return dirs;
}

/**
 * 按包名从 DSH 安装目录解析并动态载入（带缓存）。
 * 我们的插件不在安装树内，裸导入解析不到；pnpm 布局下包也不在顶层 node_modules。
 */
async function loadDshModule(packageName, entry, binPathOverride) {
	const key = packageName + "|" + (entry || ".");
	if (dshModuleCache.has(key)) return dshModuleCache.get(key);
	const sources = [];
	if (binPathOverride) sources.push(binPathOverride);
	for (const arg of process.argv) sources.push(arg);
	const suffix = entry ? "/" + entry : "";
	const attempts = [];
	for (const versionDir of versionDirsFrom(sources)) {
		try {
			const req = createRequire(versionDir + "/node_modules/@deepseek-ai/dsh/package.json");
			attempts.push(pathToFileURL(req.resolve(packageName + suffix)).href);
		} catch (error) {
			/* fallthrough */
		}
		try {
			// pnpm 的目录名把包名截断到 ~13 字符再加哈希（如 @deepseek-ai+dsh-sandbox-wi_c077bf…），
			// 所以只能按“作用域 + 包名前 8 字符”前缀匹配，再用 access 校验真实路径存在。
			const pnpmDir = versionDir + "/node_modules/.pnpm";
			const entries = await readdir(pnpmDir);
			const scoped = packageName.charAt(0) === "@";
			const scope = scoped ? packageName.slice(1).split("/")[0] : null;
			const bare = scoped ? packageName.split("/")[1] : packageName;
			const needle = (scoped ? "@" + scope + "+" : "") + bare.slice(0, 8);
			for (const name of entries) {
				if (name.indexOf(needle) !== 0) continue;
				const base = pnpmDir + "/" + name + "/node_modules/" + packageName;
				const target = entry ? base + "/" + entry : base + "/lib/index.js";
				try {
					await access(target);
					attempts.push(pathToFileURL(target).href);
					break;
				} catch (error) {
					/* 不是这个包，继续找 */
				}
			}
		} catch (error) {
			/* fallthrough */
		}
	}
	attempts.push(packageName + suffix);
	let lastError = null;
	for (const spec of attempts) {
		try {
			const mod = await import(spec);
			dshModuleCache.set(key, mod);
			return mod;
		} catch (error) {
			lastError = error;
		}
	}
	const tried = attempts.map(function (a) { return a.length > 110 ? a.slice(0, 110) + "…" : a; }).join(" ; ");
	throw new Error("无法载入 " + packageName + "（尝试 " + attempts.length + " 个来源: " + tried + "）: " + msg(lastError));
}

/** 兼容旧调用点。 */
async function loadSandboxModule(binPathOverride) {
	if (dshModuleCache.has("sandbox")) return dshModuleCache.get("sandbox");
	const mod = await loadDshModule("@deepseek-ai/dsh-sandbox-windows-acl", null, binPathOverride);
	dshModuleCache.set("sandbox", mod);
	return mod;
}

async function removeDeny(root) {
	const r = await run("icacls", [root, "/remove:d", DENY_SID], { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" });
	return lastLine(decodeOut(r.stdout) + "\n" + decodeOut(r.stderr));
}

/**
 * 复位完整性标签为 Medium（根级一次即可：标签 ACE 带 (OI)(CI)，会传播到整棵树）。
 * **不加 /T**：加了会在每个对象上留显式 Medium 记录、破坏继承语义（实测同树 1892 ms vs 根级 494 ms）。
 */
async function resetIntegrity(root) {
	const r = await run("icacls", [root, "/setintegritylevel", "Medium"], { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" });
	return lastLine(decodeOut(r.stdout) + "\n" + decodeOut(r.stderr));
}
/**
 * 撤销能力 ACE —— **v7 起擦除路径不再调用它**（能力 ACE 是平台的跨会话复用缓存：撤了会打瘫正在用这个根的其他实例，
 * 且下一次授权要付一次整树重传播，实测 47.9 s）。保留此函数，是因为它是唯一能撤掉 S-1-4-x-y 的通道
 * （icacls /remove:g 对不可解析 SID 无效，实测 processed 0 files）；将来若要做显式「深度清理」档再用。
 */
async function revokeCapability(root) {
	const mod = await loadSandboxModule();
	const sid = mod.workspaceWriteSid(root);
	const grant = mod.AclWriteGrant.create(sid);
	try {
		grant.add(root, false);
	} finally {
		grant.dispose();
	}
	return sid;
}

async function ledgerPath() {
	const home = process.env.DSH_HOME || process.cwd();
	return join(home, "sandbox-sweep", "ledger.json");
}

async function readLedger() {
	try {
		const text = await readFile(await ledgerPath(), "utf8");
		const parsed = JSON.parse(text);
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		return [];
	}
}

async function appendLedger(entry) {
	const path = await ledgerPath();
	const rows = await readLedger();
	rows.push(entry);
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(rows.slice(-100), null, 2), "utf8");
		return path;
	} catch (error) {
		return "台账写入失败: " + String((error && error.message) || error);
	}
}

/**
 * 擦除一批根。dryRun=true 时只回报「将要做什么」（含当前痕迹状态），不做任何写操作。
 *
 * 擦除口径（v7 定型，见 docs/07 M15）——**只擦会伤到用户的两件**：
 *   ① Everyone:(CI)(DENY)(DC)：让「删子文件夹」被拒；
 *   ② Low 完整性标签：跨等级移动被拦 / 「这些文件可能有害」 / 图标与预览异常。
 * **能力 ACE（S-1-4-x-y）一律保留**，因为它本来就不是「残留」：
 *   - 平台自己把它当跨会话复用缓存（AclWriteGrant.dispose() 明确跳过 standing 路径）；
 *   - 0.1.5 只写它、0.1.7 复用它（两版本的 SID 公式与 ACE mask 完全相同）；
 *   - 撤掉它 = 正在用这个根的其他实例立刻写不进去（2026-09-27 实测事故），
 *     且下一次授权要付一次整树重传播（实测 47.9 s；模块源码注释：大工作区 minutes 级）。
 *   保留后的状态 = 「只有 0.1.5 沙箱跑过」的痕迹 —— 无用户可见影响。
 * 两条动作都只在**该项真的存在**时才执行（干净项上跑 icacls 会白付一次全树传播：实测 36.5 s）。
 * 全部走 icacls，不加载 windows-acl 模块 → 行为不随宿主版本变化，也免掉模块载入失败面。
 */
async function eraseRoots(ctx, roots, dryRun, trigger) {
	const startedAt = new Date().toISOString();
	const results = [];
	for (const root of roots) {
		const before = await probeRoot(root);
		const result = { root: root, before: before, steps: [], verified: null, residue: [], keptAce: null, error: null };
		if (dryRun) {
			result.steps.push({ name: "dry-run", ok: true, detail: "未写入任何 ACL" });
			results.push(result);
			continue;
		}
		try {
			const t0 = Date.now();
			if (before.deny) {
				const denyOut = await removeDeny(root);
				result.steps.push({ name: "去 world 删除拒绝", ok: true, ms: Date.now() - t0, detail: denyOut });
			} else {
				result.steps.push({ name: "去 world 删除拒绝", ok: true, ms: 0, detail: "本来就没有（跳过）" });
			}

			const t1 = Date.now();
			if (before.lowLabel) {
				const labelOut = await resetIntegrity(root);
				result.steps.push({ name: "复位完整性标签（Medium）", ok: true, ms: Date.now() - t1, detail: labelOut });
			} else {
				result.steps.push({ name: "复位完整性标签（Medium）", ok: true, ms: 0, detail: "本来就不是 Low（跳过）" });
			}

			const after = await probeRoot(root);
			result.keptAce = after.ace === true;
			result.verified = after.deny === false && after.lowLabel === false && after.error === null;
			if (after.deny) result.residue.push("delete deny");
			if (after.lowLabel) result.residue.push("low label");
			if (after.error) result.residue.push("读取失败: " + after.error);
			result.after = after;
		} catch (error) {
			result.error = String((error && error.message) || error);
		}
		results.push(result);
	}
	const outcome = { startedAt: startedAt, dryRun: Boolean(dryRun), trigger: trigger || "user", results: results, pending: results.filter((r) => r.verified === false).map((r) => r.root) };
	if (!dryRun) outcome.ledger = await appendLedger(outcome);
	return outcome;
}

function parseRoots(body, ctx) {
	if (body && Array.isArray(body.roots) && body.roots.length > 0) return body.roots.filter((r) => typeof r === "string");
	const registry = ctx.get("workspaceRegistry");
	const roots = [];
	if (registry && typeof registry.list === "function") {
		try {
			for (const ws of registry.list() || []) {
				const path = ws && (ws.path || ws.root);
				if (path && roots.indexOf(path) === -1) roots.push(path);
			}
		} catch (error) {
			/* 交由调用方看 errors */
		}
	}
	return roots;
}

/* --------------------- 强制终止会话工作（S4 / 门禁的 F 类） --------------------- */

/**
 * 让每个会话停止正在跑的工作。
 * 用的是 DSH 自己的取消路径（与界面"停止并归档"同源）：
 *   - ctx.waterfall('workspace/session-activity', { sessionId }) 先问"还在跑什么"
 *   - ctx.parallel('workspace/session-stop',     { sessionId }) 再让各 provider 停自己的那一摊
 *     （回合、子智能体、后台作业、定时提醒都由各自 provider 取消）
 * 注意：这只停工作，不写归档集合，因此不会改动会话的归档状态。
 */
async function stopSessions(ctx) {
	const out = { total: 0, stopped: 0, failed: 0, sessions: [], errors: [] };
	const sessions = ctx.get("sessions");
	if (!sessions || typeof sessions.list !== "function") {
		out.errors.push("sessions 服务不可用");
		return out;
	}
	let list = [];
	try {
		list = sessions.list() || [];
	} catch (error) {
		out.errors.push("枚举会话失败: " + msg(error));
		return out;
	}
	out.total = list.length;
	for (const session of list) {
		const id = session && session.id;
		const row = { session: String(id), activity: [], stopped: false, detail: null };
		try {
			try {
				const activity = await ctx.waterfall("workspace/session-activity", { sessionId: id }, function () { return Promise.resolve([]); });
				row.activity = (activity || []).map(function (a) {
					return String(a && a.kind) + (a && a.items && a.items.length ? "×" + a.items.length : "");
				});
			} catch (error) {
				row.detail = "活动查询失败: " + msg(error);
			}
			await ctx.parallel("workspace/session-stop", { sessionId: id });
			row.stopped = true;
			out.stopped += 1;
		} catch (error) {
			row.detail = (row.detail ? row.detail + " | " : "") + msg(error);
			out.failed += 1;
		}
		out.sessions.push(row);
	}
	return out;
}

/* ------------------------- 权限回收：会话切只读（M2.5） ------------------------- */

/**
 * 把本实例所有会话的沙箱模式切到 read-only。
 * 关键点：终端占用会让模式切换被围栏拒绝，所以先关该会话的终端。
 * 注意：切换只阻止"新的授权"，不打断已在运行的进程——真正让写入停下的是随后的擦除。
 */
async function revokeSessions(ctx) {
	const out = { total: 0, changed: 0, alreadyReadOnly: 0, failed: 0, results: [], errors: [] };
	const sessions = ctx.get("sessions");
	const agents = ctx.get("agents");
	const terminals = ctx.get("terminals");
	const policy = ctx.get("sandboxPolicy");
	if (!sessions || typeof sessions.list !== "function") {
		out.errors.push("sessions 服务不可用");
		return out;
	}
	let setMode = null;
	try {
		const mod = await loadDshModule("@deepseek-ai/dsh-sandbox-policy");
		setMode = mod && mod.setSandboxMode ? mod.setSandboxMode : null;
	} catch (error) {
		out.errors.push("载入 setSandboxMode 失败: " + msg(error));
	}
	let list = [];
	try {
		list = sessions.list() || [];
	} catch (error) {
		out.errors.push("枚举会话失败: " + msg(error));
		return out;
	}
	out.total = list.length;
	for (const session of list) {
		const row = { session: String(session && session.id), status: "ok", modeBefore: null, detail: null, terminalsClosed: 0 };
		try {
			let mode = null;
			try {
				// resolve() 给的是"该会话下一次受限调用真正生效的完整策略"，比 overrideOf()（只读会话覆盖）更准
				if (policy && typeof policy.resolve === "function") {
					const resolved = policy.resolve({ session: session });
					if (resolved && typeof resolved.mode === "string") mode = resolved.mode;
				}
				if (mode === null && policy && typeof policy.overrideOf === "function") mode = policy.overrideOf(session);
			} catch (error) {
				/* 取不到就当未知，继续尝试切换 */
			}
			row.modeBefore = mode;
			if (mode === "read-only") {
				row.status = "already-read-only";
				out.alreadyReadOnly += 1;
				out.results.push(row);
				continue;
			}
			const agent = agents && typeof agents.get === "function" ? agents.get(row.session) : undefined;
			if (agent && terminals && typeof terminals.list === "function") {
				let tl = [];
				try {
					tl = terminals.list(agent) || [];
				} catch (error) {
					out.errors.push("列出终端失败（" + row.session + "）: " + msg(error));
				}
				for (const t of tl) {
					try {
						if (await terminals.kill(agent, t.id, "sandbox-sweep: revoke to read-only")) row.terminalsClosed += 1;
					} catch (error) {
						out.errors.push("关闭终端失败（" + row.session + "）: " + msg(error));
					}
				}
			}
			if (!setMode) throw new Error("setSandboxMode 不可用");
			setMode(session, "read-only");
			row.status = "changed";
			out.changed += 1;
			revokedSessions.set(String(row.session), { at: new Date().toISOString() });
		} catch (error) {
			row.status = "failed";
			row.detail = msg(error);
			out.failed += 1;
		}
		out.results.push(row);
	}
	if (out.changed > 0) {
		out.revokedSessions = [];
		for (const row of out.results) {
			if (row.status === "changed") out.revokedSessions.push({ id: row.session, at: new Date().toISOString() });
		}
		try {
			out.ledger = await appendLedger({ kind: "revoke", startedAt: new Date().toISOString(), revokedSessions: out.revokedSessions });
		} catch (error) {
			out.errors.push("台账写入失败: " + msg(error));
		}
	}
	return out;
}

/* ------------------- 被回收会话的状态 + 模型可见性（本轮新增） ------------------- */

/**
 * 被本插件切过只读的会话：sessionId -> { at }。
 * 用途：给模型贡献一行"这是有意为之、勿提权"的运行时上下文；启动时可由台账恢复。
 */
const revokedSessions = new Map();

/** 组装给模型的提示行；只有"确实仍为只读"时才输出，避免说谎。 */
function sweepStateLine(ctx, session) {
	let id = null;
	try {
		id = session && (session.id || session.sessionId);
	} catch (error) {
		return "";
	}
	if (!id) return "";
	const rec = revokedSessions.get(String(id));
	if (!rec) return "";
	let mode = null;
	try {
		const policy = ctx.get("sandboxPolicy");
		if (policy && typeof policy.resolve === "function") {
			const resolved = policy.resolve({ session: session });
			if (resolved && typeof resolved.mode === "string") mode = resolved.mode;
		}
	} catch (error) {
		/* 取不到就按登记状态输出 */
	}
	if (mode !== null && mode !== "read-only") return "";
	return (
		"sandbox-sweep: 本会话已被插件切为只读（" + rec.at + "），目的是执行沙箱痕迹擦除。这是有意为之。" +
		"若你看到 [sandbox: file access denied under read-only mode] 或 [sandbox: escalation available …]，" +
		"**不要**照它去申请 danger-full-access / 改写沙箱策略，先向作者确认。台账见 $DSH_HOME/sandbox-sweep/ledger.json。"
	);
}

/* --------------------------- 随包分发的技能（skill） --------------------------- */

/** 与 @deepseek-ai/dsh-skill 的 BUNDLED_SKILL_RANK 同值（包已打包技能的标准优先级）。 */
const BUNDLED_SKILL_RANK = 600;
const SKILL_NAME = "sandbox-sweep";
const SKILL_BODY_PATH = fileURLToPath(new URL("../assets/sandbox-sweep.md", import.meta.url));
const SKILL_RESOURCE_BASE = { kind: "directory", path: fileURLToPath(new URL("../assets/", import.meta.url)) };

const SKILL_CANDIDATE = {
	name: SKILL_NAME,
	description:
		"判断并应对 dsh-sandbox-sweep 插件留下的沙箱痕迹与权限变化。当出现这些症状时使用：" +
		"写入或删除被沙箱拒绝（file access denied under read-only mode）、PowerShell 掉进受限语言模式" +
		"（无法创建类型。此语言模式仅支持核心类型。）、后台任务被突然终止（killed before exit）、" +
		"作业记录消失（unknown job）、工作区目录删不掉或移动/复制被拦。",
	invocation: { modelInvocable: true, userInvocable: true },
	provider: SKILL_NAME,
	source: "bundled",
	resourceBase: SKILL_RESOURCE_BASE,
	rank: BUNDLED_SKILL_RANK,
	locator: SKILL_BODY_PATH,
};

function sandboxSweepSkillProvider() {
	return {
		name: SKILL_NAME,
		list: function () { return Promise.resolve([SKILL_CANDIDATE]); },
		get: async function () {
			return {
				name: SKILL_CANDIDATE.name,
				description: SKILL_CANDIDATE.description,
				invocation: SKILL_CANDIDATE.invocation,
				provider: SKILL_CANDIDATE.provider,
				source: SKILL_CANDIDATE.source,
				resourceBase: SKILL_RESOURCE_BASE,
				content: await readFile(SKILL_BODY_PATH, "utf8"),
			};
		},
	};
}

/** 启动时从台账恢复"被回收过只读"的会话，使提示跨实例重启仍然成立。 */
async function restoreRevokedFromLedger() {
	try {
		const rows = await readLedger();
		for (const row of rows) {
			for (const session of (row && row.revokedSessions) || []) {
				if (session && session.id) revokedSessions.set(String(session.id), { at: session.at || row.startedAt || "" });
			}
		}
	} catch (error) {
		/* 台账不可读不影响主流程 */
	}
}


/** 路径是否还存在（跳过台账里已消失的待擦根，避免刷出无意义的错误行）。 */
async function pathExists(p) {
	try { await access(p); return true; } catch (error) { return false; }
}

/* ------------------- 实例 temp 根（v6：分层直接删除） ------------------- */

/**
 * 实例 temp 根的命名来源：`dsh-sandbox-local` 用 `mkdtempSync(join(tmpdir(), "dsh-"))` 建目录
 * → `dsh-` + 6 位随机串。它是**按「会话 × 工作区」惰性创建**的，正常 dispose 时 DSH 自己会
 * `rmSync`；**硬杀 / 崩溃 / dispose 失败**留下的才是本插件要收的。
 */
const TEMP_DIR_RE = /^dsh-[A-Za-z0-9]{6}$/;

/**
 * 闲置门槛 —— **唯一可靠的"没人在用"判据**。
 * 实测（2026-09-26）：活着的 temp 根会被不停碰（每次工具调用都写），而 `.lock` 是**临时的**
 * （同一个活根几分钟前有 2 个 `.lock`、再看是 0 个）→ `.lock` 只能当**跳过信号**，
 * **不能**当"没人用"的证据。
 */
const TEMP_IDLE_MS = 10 * 60 * 1000;

let tempScanCache = { at: 0, value: null };

/**
 * 候选父目录。本机实测 `os.tmpdir()` 会被 OneDrive 重定向（`%USERPROFILE%\OneDrive`），
 * 所以把常见几处都列上：去重、只留真实存在的。
 */
async function tempParents() {
	const cands = [];
	const push = function (p) {
		if (p && typeof p === "string" && cands.indexOf(p) === -1) cands.push(p);
	};
	try { push(tmpdir()); } catch (error) { /* ignore */ }
	push(process.env.TEMP);
	push(process.env.TMP);
	if (process.env.LOCALAPPDATA) push(join(process.env.LOCALAPPDATA, "Temp"));
	if (process.env.USERPROFILE) push(join(process.env.USERPROFILE, "OneDrive"));
	const out = [];
	for (const c of cands) {
		try { await access(c); out.push(c); } catch (error) { /* 不存在 */ }
	}
	return out;
}

/** 基线：本实例启动时**已经存在**的 temp 根 → 之后新出现的就算"本实例生命周期内的"。 */
async function tempBaselinePath() {
	const home = process.env.DSH_HOME || process.cwd();
	return join(home, "sandbox-sweep", "temp-baseline.json");
}

async function readTempBaseline() {
	try {
		const parsed = JSON.parse(await readFile(await tempBaselinePath(), "utf8"));
		return Array.isArray(parsed && parsed.roots) ? parsed.roots : [];
	} catch (error) {
		return [];
	}
}

async function writeTempBaseline(roots) {
	try {
		const path = await tempBaselinePath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify({ at: new Date().toISOString(), roots: roots }, null, 2), "utf8");
		return true;
	} catch (error) {
		return false;
	}
}

/**
 * 扫一遍候选 temp 根：**只认**「名字匹配 `dsh-<6位>`」的目录（`dsh-spill-*` / `dsh-subprocess-*` /
 * `dsh-ssh-uploads` 是别的命名空间，一律不碰 —— 删 spill 等于让历史会话的"完整输出"链接失效）。
 * 30 秒缓存：探针与清理常常连着走。
 */
async function scanTempRoots(force) {
	const now = Date.now();
	if (!force && tempScanCache.value && now - tempScanCache.at < 30000) return tempScanCache.value;
	const parents = await tempParents();
	const dirs = [];
	for (const parent of parents) {
		let listing = [];
		try { listing = await readdir(parent, { withFileTypes: true }); } catch (error) { continue; }
		for (const e of listing) if (e.isDirectory() && TEMP_DIR_RE.test(e.name)) dirs.push(join(parent, e.name));
	}
	const probed = await mapPool(dirs, 8, async function (dir) {
		const st = await probeRoot(dir);
		let locks = 0;
		let fileCount = null;
		try {
			const list = await readdir(dir, { withFileTypes: true });
			fileCount = list.length;
			for (const e of list) if (e.isFile() && e.name.toLowerCase().endsWith(".lock")) locks += 1;
		} catch (error) { /* 读不到就不算 lock */ }
		let mtimeMs = null;
		try { mtimeMs = (await stat(dir)).mtimeMs; } catch (error) { mtimeMs = null; }
		return {
			root: dir, deny: st.deny, lowLabel: st.lowLabel, error: st.error,
			locks: locks, entries: fileCount, mtimeMs: mtimeMs,
			// mtime 读不到时**不**当闲置（宁可跳过）
			idle: mtimeMs === null ? false : (now - mtimeMs >= TEMP_IDLE_MS),
		};
	});
	const value = { parents: parents, scanned: probed.length, roots: probed, at: now };
	tempScanCache = { at: now, value: value };
	return value;
}

/**
 * 删掉一个 temp 根：有删除拒绝（`Everyone:(DENY)(DC)`）先去掉（**不加 `/T`**），再整目录递归删。
 * 遇到占用 / 权限错误**立即放弃**（不做部分强删、不重试）—— 那是"还有人在用"的信号。
 */
async function deleteTempRoot(r) {
	const rec = {
		root: r.root, entries: r.entries, idle: r.idle, locks: r.locks,
		selfLifetime: Boolean(r.selfLifetime), own: Boolean(r.own), ok: false, inUse: false, detail: null,
	};
	try {
		if (r.deny) {
			await removeDeny(r.root);
			rec.detail = "已先去掉删除拒绝";
		}
		await rm(r.root, { recursive: true, force: true, maxRetries: 0 });
		rec.ok = true;
		return rec;
	} catch (error) {
		const code = String((error && error.code) || "");
		rec.inUse = code === "EBUSY" || code === "EPERM" || code === "EACCES";
		rec.detail = (rec.detail ? rec.detail + "；" : "") + (code ? code + ": " : "") + msg(error);
		return rec;
	}
}


/**
 * 本实例自己的 temp 根 —— **精确**取自本进程的 sandbox provider：
 * `dsh-sandbox-local` 注册为 `ctx.sandbox`，其 `tempCapabilities` 是**公开字段**的 Map
 * （key = `[sessionId, workspaceRoot]` → `{dir, sid, grant}`）。这个 provider 属于本进程，
 * 所以它里面的 dir **就是我们的**。拿不到（版本变了 / 服务没注册）返回空数组，交给启发式。
 */
function providerTempDirs(ctx) {
	const out = [];
	try {
		const sandbox = ctx && typeof ctx.get === "function" ? ctx.get("sandbox") : null;
		const map = sandbox && sandbox.tempCapabilities;
		if (map && typeof map.values === "function") {
			for (const cap of map.values()) {
				const dir = cap && cap.dir;
				if (typeof dir === "string" && dir.length > 0 && out.indexOf(dir) === -1) out.push(dir);
			}
		}
	} catch (error) { /* 拿不到就算了 */ }
	return out;
}

/**
 * 纯函数：这一轮删哪些 temp 根、跳过哪些（抽出来是为了能离线自检）。
 *
 *   **own** —— 本实例自己的根（见 {@link providerTempDirs}；拿不到时退回基线启发式：
 *              启动后新出现 ∧ 无 `.lock`）。**只在关闭阶段删**：点「清理」时删它，
 *              等于把当前会话的 `TEMP` 从脚下抽走（之后的临时写入会开始失败）。
 *   **低风险** —— 无 `.lock` ∧ 闲置 ≥10 分钟 → 任何阶段都删。
 *   **lastInstance** —— 实例扫描**成功**且为 0：此时**只放宽 `.lock` 一项**，
 *                       **仍然要求闲置 ≥10 分钟**（v7 收紧；见下）。
 *   **peerDeclared** —— 被同机**活租约**声明为"自己的 temp 根"的一律不碰（v7 新增）。
 *
 * ⚠️ v7 收紧"最后一个实例"这条规则的原因（2026-09-27 实测事故）：
 *   实例扫描可能**"成功但少报"**。当时关闭方把自己判成"本机最后一个实例"，于是删掉了
 *   **另一个活实例正在用的 temp 根**；那个实例的沙箱 ACL runner 随即起不来
 *   （`--temp is not an existing directory`），**对方所有命令都被沙箱拒绝**。
 *   现在：① 任何情况下都要求"闲置 ≥10 分钟"；② 活实例还能在租约里**声明**自己的根，声明即免疫。
 */
function planTempSweep(roots, opts) {
	const phase = opts.phase;
	const known = opts.known || {};
	const ownSet = opts.ownSet || {};
	const ownFallback = Boolean(opts.ownFallback);
	const peerTemp = opts.peerTempRoots || {};
	const targets = [];
	const skipped = [];
	for (const r of roots) {
		const key = canonPath(r.root);
		r.selfLifetime = !known[key];
		r.own = Boolean(ownSet[key]) || (ownFallback && r.selfLifetime && r.locks === 0);
		r.peerDeclared = Boolean(peerTemp[key]);
		if (r.peerDeclared) {
			skipped.push({ root: r.root, reason: "别的实例在租约里声明了它", idle: r.idle, locks: r.locks, own: r.own, peerDeclared: true });
			continue;
		}
		if (r.own && phase !== "close") {
			skipped.push({ root: r.root, reason: "本实例自己在用（只在关闭时清）", idle: r.idle, locks: r.locks, own: true });
			continue;
		}
		const lowRisk = r.locks === 0 && r.idle;
		const lastInstanceEligible = opts.lastInstance === true && r.idle === true;
		// ownOnly（v8）：不写三件套的宿主只清自己的 temp 根，别人的一律不碰
		if (opts.ownOnly === true && !r.own) {
			skipped.push({ root: r.root, reason: "宿主不写三件套（< " + TRIO_SINCE + "）：只清自己的 temp 根", idle: r.idle, locks: r.locks, own: false, peerDeclared: false });
			continue;
		}
		if (lowRisk || r.own || lastInstanceEligible) targets.push(r);
		else skipped.push({
			root: r.root,
			reason: r.locks > 0 ? "有 .lock" : "最近仍被碰过（即使本机只剩自己也不删）",
			idle: r.idle, locks: r.locks, own: false, peerDeclared: false,
		});
	}
	return { targets: targets, skipped: skipped, own: roots.filter(function (r) { return r.own; }) };
}

/**
 * 分层清理 temp 根（v6）。阶段：boot（启动，**静默**）/ close（关闭，报告排第一、执行放最后）/ user（点「清理」）。
 *
 * 判据（按 2026-09-26 实测重写）：
 *   **低风险** = 严格命名 ∧ **无 `.lock`** ∧ **闲置 ≥10 分钟** → 任何阶段都删；
 *   **可能被占用** = 有 `.lock` 或最近仍被碰过 → **仅当"自己是最后一个实例"**（实例扫描**成功**且为 0）才删；
 *   扫描失败 / 不确定 ⇒ **绝不**当成"没有其它实例"，只按低风险处理。
 *
 * 执行顺序：自己的根（本实例启动后新出现的）排**最后** —— 本实例的关闭链自己还要用 TEMP。
 */
async function sweepTempRoots(ctx, phase, opts) {
	const out = { phase: phase, scanned: null, others: null, lastInstance: null, deleted: [], skipped: [], errors: [] };
	let inv = null;
	try {
		inv = await scanTempRoots(true);
	} catch (error) {
		out.errors.push("temp 扫描失败: " + msg(error));
		return out;
	}
	out.scanned = inv.scanned;
	const baseline = await readTempBaseline();
	const known = {};
	for (const r of baseline) known[canonPath(r)] = true;
	if (phase === "boot") await writeTempBaseline(inv.roots.map(function (r) { return r.root; }));

	let scanned = false;
	let count = null;
	try {
		const others = await probeInstances(ctx);
		scanned = others.scanned === true;
		count = others.list.length;
	} catch (error) {
		out.errors.push("实例扫描失败: " + msg(error));
	}
	out.others = { scanned: scanned, count: count };
	out.lastInstance = scanned && count === 0;

	const ownDirs = providerTempDirs(ctx);
	const ownSet = {};
	for (const d of ownDirs) ownSet[canonPath(d)] = true;
	// 活租约声明的 temp 根（别的实例）：一律不碰 —— 这是 v7 的"声明免疫"，
	// 用来替代"靠闲置时长猜有没有人在用"（后者已被实测证明会误删活实例的根）。
	const peerTemp = {};
	try {
		for (const lease of await readPeerLeases()) {
			for (const dir of (lease && lease.tempRoots) || []) {
				if (typeof dir === "string" && dir.length > 0) peerTemp[canonPath(dir)] = true;
			}
		}
	} catch (error) { /* 读不到租约就按空处理：保守性由"必须闲置 ≥10 分钟"兜底 */ }
	out.peerDeclared = Object.keys(peerTemp).length;
	const plan = planTempSweep(inv.roots, {
		phase: phase, lastInstance: out.lastInstance, known: known,
		ownSet: ownSet, ownFallback: ownDirs.length === 0, peerTempRoots: peerTemp,
		ownOnly: Boolean(opts && opts.ownOnly),
	});
	out.skipped = plan.skipped;
	out.own = plan.own.map(function (r) { return r.root; });
	const targets = plan.targets;
	// 甲：自己的根"报告排第一、执行放最后"
	targets.sort(function (a, b) { return (a.own ? 1 : 0) - (b.own ? 1 : 0); });
	for (const r of targets) out.deleted.push(await deleteTempRoot(r));
	out.ok = out.errors.length === 0 && out.deleted.every(function (d) { return d.ok; });
	try {
		await appendLedger({
			startedAt: new Date().toISOString(), dryRun: false, trigger: "temp-" + phase,
			results: [], pending: [],
			temp: {
				scanned: out.scanned, others: out.others, lastInstance: out.lastInstance,
				deleted: out.deleted.map(function (d) {
					return { root: d.root, ok: d.ok, inUse: d.inUse, entries: d.entries, idle: d.idle, locks: d.locks, self: d.selfLifetime, own: d.own, detail: d.detail };
				}),
				skipped: out.skipped, errors: out.errors,
			},
		});
	} catch (error) { /* 台账失败不影响清理 */ }
	return out;
}

/* ---------------------------- 启动清扫（兜底） ---------------------------- */

/**
 * 启动清扫（三类）：
 *   ① **硬杀/崩溃遗留**：本进程刚起、**还没授权过任何根**，此时注册工作区根若仍带三件套，
 *      一定是上一轮留下的（正常退出会被擦掉）→ 直接擦。这是"任务管理器强杀 / 断电"路径的兜底。
 *   ② **台账 pending**：上一轮擦过但没通过校验的根 → 补擦。
 * 全部成功/失败都记进台账（trigger="boot"）。
 */
async function startupSweep(ctx) {
	const summary = { checked: 0, pending: 0, bootResidue: [], bootSkipped: [], results: [], errors: [], error: null };
	// v8：< 0.1.7-alpha.1 的宿主不写三件套 → 启动清扫（擦别人的根 / 补擦台账 / 删别人的 temp）整块跳过
	const caps = hostCaps();
	if (!caps.sweep) {
		summary.skipped = "宿主 " + (caps.hostVersion || "?") + " < " + TRIO_SINCE + "（不写三件套）";
		try { console.log("[sandbox-sweep] 启动清扫: 跳过（宿主 " + (caps.hostVersion || "?") + " < " + TRIO_SINCE + "，不写三件套 → 不做多余操作）"); } catch (error) { /* ignore */ }
		return summary;
	}
	try {
		const rows = await readLedger();
		summary.checked = rows.length;
		const seen = {};
		const roots = [];
		const add = function (root) {
			if (typeof root !== "string" || root.length === 0) return;
			const key = canonPath(root);
			if (seen[key]) return;
			seen[key] = true;
			roots.push(root);
		};
		for (const row of rows) for (const root of (row && row.pending) || []) { if (await pathExists(root)) add(root); }
		summary.pending = roots.length;

		// ① 硬杀遗留：**只有"没有别的活实例可能拥有它"时才擦**（v7 收紧）。
		// 事故背景（2026-09-27 实测）：启动清扫曾把**别的实例正在当工作区用**的根上三件套擦掉，
		// 使对方实例的授权缓存失效（表现为"看起来正常、实际写不进去"）。
		// "本进程还没授权过任何根"这个前提对**别的实例**并不成立 —— 所以必须先问一句。
		// 第二道结构性护栏（v7）：残留判据只算「删除拒绝 / 低标签」，**能力 ACE 不算残留** ——
		// 别的实例（尤其 0.1.5）正用着的根因此天然不会被判成「脏」，实例扫描失灵时也不会误擦。
		try {
			const mine = parseRoots({}, ctx);
			const claimed = {};
			let scanned = false;
			try {
				const others = await probeInstances(ctx);
				scanned = others.scanned === true;
				for (const i of others.list) for (const w of (i.workspaces || [])) { if (w) claimed[canonPath(w)] = true; }
				summary.others = { scanned: scanned, count: others.list.length, claimedRoots: Object.keys(claimed).length };
			} catch (error) {
				summary.errors.push("实例扫描失败: " + msg(error));
			}
			const probed = await mapPool(mine, 4, async function (root) {
				const st = await probeRoot(root);
				return { root: root, dirty: st.error === null && Boolean(st.deny || st.lowLabel) };
			});
			for (const p of probed) {
				if (!p.dirty) continue;
				summary.bootResidue.push(p.root);
				const why = claimed[canonPath(p.root)] ? "同机活实例登记了它（不动别人的工作区）"
					: (scanned ? null : "实例扫描未成功（保守起见不自动擦）");
				if (why) {
					summary.bootSkipped = summary.bootSkipped || [];
					summary.bootSkipped.push({ root: p.root, reason: why });
					continue;
				}
				add(p.root);
			}
		} catch (error) {
			summary.errors.push("启动残留探测失败: " + msg(error));
		}

		// ③ 实例 temp 根：分层**直接删除**（v6）。启动时静默 —— 只写台账与日志，不弹窗。
		try {
			const t = await sweepTempRoots(ctx, "boot");
			summary.temp = {
				scanned: t.scanned, others: t.others, lastInstance: t.lastInstance,
				deleted: t.deleted.filter(function (d) { return d.ok; }).length,
				failed: t.deleted.filter(function (d) { return !d.ok; }).length,
				skipped: t.skipped.length, errors: t.errors,
			};
		} catch (error) {
			summary.errors.push("temp 清理失败: " + msg(error));
		}

		if (roots.length > 0) {
			const outcome = await eraseRoots(ctx, roots, false, "boot");
			summary.results = (outcome.results || []).map(function (r) {
				return { root: r.root, verified: r.verified, residue: r.residue, error: r.error };
			});
		}
		// 总是打这一行：v6 起 temp 是第三类，**没有工作区残留要擦时也要能看到 temp 的结果**
		try {
			console.log("[sandbox-sweep] 启动清扫: " + JSON.stringify(summary));
		} catch (error) { /* ignore */ }
	} catch (error) {
		summary.error = msg(error);
		try { console.log("[sandbox-sweep] 启动清扫失败: " + summary.error); } catch (inner) { /* ignore */ }
	}
	return summary;
}

/* ------------------------------- 关闭（M3） ------------------------------- */

/** 关闭闸门：置位后拒绝新的自检/擦除请求。 */
let closing = false;

/** QUIESCE：关闭本实例所有 agent 的常驻终端（沙箱模式围栏要求"无终端"才能切模式）。 */
async function quiesceTerminals(ctx) {
	const out = { killed: 0, sessions: 0, errors: [], na: false, reason: null };
	const terminals = ctx.get("terminals");
	const agents = ctx.get("agents");
	if (!terminals || !agents || typeof agents.list !== "function" || typeof terminals.list !== "function") {
		// 服务不存在 ≠ 失败（v9）：0.1.5-rc.3 这类宿主没有 terminals 服务，关闭链无法、也不需要关常驻终端
		//（v7 起关闭链已不再切沙箱模式，这一步当初是为那次切换准备的）。按「不适用」记账，不要报 fail。
		out.na = true;
		out.reason = "本宿主" + (terminals ? "" : "无 terminals 服务") + (!terminals && !agents ? "、" : "") + (agents ? "" : "无 agents 服务");
		return out;
	}
	let list = [];
	try {
		list = agents.list() || [];
	} catch (error) {
		out.errors.push("枚举 agent 失败: " + msg(error));
		return out;
	}
	for (const agent of list) {
		let sessions = [];
		try {
			sessions = terminals.list(agent) || [];
		} catch (error) {
			out.errors.push("列出终端失败: " + msg(error));
			continue;
		}
		for (const s of sessions) {
			out.sessions += 1;
			try {
				const ok = await terminals.kill(agent, s.id, "sandbox-sweep: instance closing");
				if (ok) out.killed += 1;
			} catch (error) {
				out.errors.push("关闭终端失败(" + String(s && s.id) + "): " + msg(error));
			}
		}
	}
	return out;
}

/** FLUSH：逐会话刷盘（append-only 日志 + durability barrier）。 */
async function flushSessions(ctx) {
	const out = { total: 0, flushed: 0, errors: [] };
	const sessions = ctx.get("sessions");
	if (!sessions || typeof sessions.list !== "function" || typeof sessions.flush !== "function") {
		out.errors.push("sessions 服务不可用");
		return out;
	}
	let list = [];
	try {
		list = sessions.list() || [];
	} catch (error) {
		out.errors.push("枚举会话失败: " + msg(error));
		return out;
	}
	out.total = list.length;
	for (const s of list) {
		try {
			const ok = await sessions.flush(s);
			if (ok !== false) out.flushed += 1;
			else out.errors.push("刷盘返回 false（会话 " + String(s && s.id) + "）");
		} catch (error) {
			out.errors.push("刷盘失败（会话 " + String(s && s.id) + "）: " + msg(error));
		}
	}
	return out;
}

/** DISPOSE → EXIT：走宿主自身 dispose 链（sandbox-local 的 temp 撤销注册在 ctx.effect 上），最后退出进程。 */
async function shutdownHost(ctx) {
	const attempts = [];
	// 每次属性访问单独兜底：cordis 下访问未注入的服务（如 ctx.scope）会直接抛
	// "cannot get property ... without inject"（本机实测踩到过，整条 dispose 链就此中断）。
	const tryDispose = async (label, getTarget) => {
		let target = null;
		try {
			target = getTarget();
		} catch (error) {
			attempts.push(label + ": 取不到（" + msg(error) + "）");
			return;
		}
		if (!target || typeof target.dispose !== "function") {
			attempts.push(label + ": 不可用");
			return;
		}
		let line = null;
		try {
			const result = await withTimeout(Promise.resolve(target.dispose()), 5000, label);
			line = label + (typeof result === "string" ? " " + result : " ok");
		} catch (error) {
			line = label + " 失败: " + msg(error);
		}
		attempts.push(line);
		// 逐步落日志：loader.dispose 可能让进程在下一步之前就自行退出，事后统一打印会丢证据
		try { console.log("[sandbox-sweep] dispose: " + line); } catch (error) { /* ignore */ }
	};
	await tryDispose("loader.dispose", function () { return ctx.get("loader"); });
	await tryDispose("root.dispose", function () { return ctx.root; });
	await tryDispose("fiber.dispose", function () { return ctx.get("fiber"); });
	await tryDispose("scope.dispose", function () { return ctx.get("scope"); });
	// 不在这里退出：调用方需要先把 attempts 打完日志再退（否则 process.exit 会吞掉 .then）
	return attempts;
}

/** 关闭流程：FENCE → QUIESCE → FLUSH → [ERASE] → 交给调用方随后 DISPOSE/EXIT。 */
async function closeInstance(ctx, body) {
	const report = { startedAt: new Date().toISOString(), steps: [], terminals: null, flush: null, erase: null, errors: [] };
	const t0 = Date.now();
	closing = true;
	report.steps.push({ name: "关门（拒绝新的自检/擦除请求）", ok: true });

	report.stop = await stopSessions(ctx);
	report.steps.push({
		name: "停止会话工作（回合/子智能体/作业/定时提醒）",
		ok: report.stop.failed === 0,
		detail: "已停 " + report.stop.stopped + "/" + report.stop.total,
	});

	report.terminals = await quiesceTerminals(ctx);
	report.steps.push({
		name: "关闭常驻终端",
		ok: report.terminals.errors.length === 0,
		na: report.terminals.na === true,
		detail: report.terminals.na
			? "不适用：" + report.terminals.reason
			: "终端 " + report.terminals.sessions + " 个 / 已关闭 " + report.terminals.killed + " 个",
	});

	report.flush = await flushSessions(ctx);
	report.steps.push({
		name: "会话刷盘",
		ok: report.flush.errors.length === 0,
		detail: "已刷盘 " + report.flush.flushed + "/" + report.flush.total,
	});

		// 关闭链不再「切只读」（v7）：进程随后就退出，令牌随进程消失，这一步没有独立价值；
		// 它原本的作用是给「擦除」让路，而现在的擦除只动删除拒绝与完整性标签、不碰会话的写授权。
		// 需要单独切只读时走 /api/sandbox-sweep/revoke；「清理」按钮仍会先切只读再擦。

	const caps = hostCaps();
	if (body && body.erase) {
		if (caps.sweep) {
			const roots = parseRoots({}, ctx);
			// trigger 用 "close"：与"作者点「清理」"(user) 区分开，否则台账里分不清是谁触发的擦除
			report.erase = await eraseRoots(ctx, roots, false, "close");
			report.steps.push({
				name: "擦除有害痕迹（删除拒绝 + 低标签）",
				ok: report.erase.pending.length === 0,
				detail: roots.length + " 个根 / 未通过 " + report.erase.pending.length + " 个",
			});
		} else {
			// v8：< 0.1.7-alpha.1 的宿主不写三件套 → 关闭链不做任何 ACL 操作
			report.erase = { skipped: true, reason: "宿主 " + (caps.hostVersion || "?") + " < " + TRIO_SINCE };
			report.steps.push({
				name: "擦除有害痕迹（删除拒绝 + 低标签）",
				ok: true,
				detail: "跳过：宿主 " + (caps.hostVersion || "?") + " 不写三件套（< " + TRIO_SINCE + "）",
			});
		}
	}

	// 最后一步：分层清理实例 temp 根（甲：报告里排第一、执行放最后——本实例的关闭链自己还要用 TEMP）
	try {
		// v8：不写三件套的宿主只清「自己的」temp 根（不扫、不删别人的）
		report.temp = await sweepTempRoots(ctx, "close", caps.sweep ? {} : { ownOnly: true });
		const done = report.temp.deleted.filter(function (d) { return d.ok; }).length;
		report.steps.push({
			name: "清理实例临时目录（先无风险，再可能被占用的）",
			ok: report.temp.errors.length === 0,
			detail: "已删 " + done + " / 跳过 " + report.temp.skipped.length
				+ (report.temp.lastInstance ? "（本机最后一个实例）" : "（仍有其它实例，只清无风险的）"),
		});
	} catch (error) {
		report.temp = { errors: [msg(error)] };
		report.steps.push({ name: "清理实例临时目录", ok: false, detail: msg(error) });
	}
	// 关闭全过程留痕：诊断"卡在哪一步"（本次实测关闭链要 100+ 秒，没有这行就只能靠猜）
	try {
		console.log("[sandbox-sweep] close 用时 " + (Date.now() - t0) + "ms："
			+ report.steps.map(function (s) { return s.name + "=" + (s.na ? "na" : s.ok ? "ok" : "fail"); }).join(" | "));
	} catch (error) { /* ignore */ }
	return report;
}

async function readJson(request) {
	try {
		const text = await request.text();
		return text ? JSON.parse(text) : {};
	} catch (error) {
		return {};
	}
}

export function apply(ctx) {
	// 启动清扫：等应用起来后跑一次（只处理台账里 pending 的根）
	setTimeout(function () {
		void startupSweep(ctx);
	}, 3000);

	// 跨重启恢复"被回收只读"的会话登记（供下面的上下文行使用）
	void restoreRevokedFromLedger();

	// 广播租约（身份 + 我占用的工作区），让同机其他实例能判定是否共享工作区；心跳 60s
	setTimeout(function () { void writeLease(ctx); }, 2000);
	setInterval(function () { void writeLease(ctx); }, 60000);

	// 写一份"源码在哪"到 $DSH_HOME/sandbox-sweep/SOURCE.md（本机专属信息只落 home，不进仓库）
	setTimeout(function () { void publishSourceNote(ctx); }, 2500);

	// 运行时上下文：把"这是有意的只读、勿提权"贴在沙箱策略那一行之后
	ctx.inject(["systemPrompt"], function (scope) {
		scope.systemPrompt.context({
			name: "sandbox-sweep:state",
			order: scope.systemPrompt.getContextOrder("SANDBOX_POLICY") + 1,
			text: function (context) {
				try {
					const session = context && context.agent && context.agent.session;
					return session ? sweepStateLine(scope, session) : "";
				} catch (error) {
					return "";
				}
			},
		});
	});

	// 随包分发的技能：让模型在遇到相应症状时能查到"这是什么、该怎么办"
	ctx.inject(["skills"], function (scope) {
		scope.skills.registerProvider(function () { return sandboxSweepSkillProvider(); });
	});

	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: ROUTE_PROBE,
				methods: ["GET", "POST"],
				requestBody: "buffered",
				fetch: async () => {
					if (closing) return json({ error: "实例正在关闭" }, 409);
					try {
						return json(await collect(ctx), 200);
					} catch (error) {
						return json({ error: String((error && error.message) || error) }, 500);
					}
				},
			}),
		"sandbox-sweep: probe route",
	);

	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: ROUTE_ERASE,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					if (closing) return json({ error: "实例正在关闭" }, 409);
					try {
						const body = await readJson(request);
						const dryRun = Boolean(body.dryRun);
						const roots = parseRoots(body, ctx);
						if (roots.length === 0) return json({ error: "没有可擦除的工作区根" }, 400);
						const outcome = await eraseRoots(ctx, roots, dryRun, "user");
						if (!dryRun) {
							try { outcome.temp = await sweepTempRoots(ctx, "user"); } catch (error) { outcome.temp = { errors: [msg(error)] }; }
						}
						return json(outcome, 200);
					} catch (error) {
						return json({ error: String((error && error.message) || error) }, 500);
					}
				},
			}),
		"sandbox-sweep: erase route",
	);

	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: ROUTE_CLOSE,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					if (closing) return json({ error: "实例正在关闭" }, 409);
					let report = null;
					try {
						const body = await readJson(request);
						report = await closeInstance(ctx, body);
					} catch (error) {
						return json({ error: msg(error) }, 500);
					}
					// 先把报告回给浏览器，再走 dispose → exit（否则响应发不出去）
					setTimeout(function () {
						void shutdownHost(ctx)
							.then(function (attempts) {
								// 落到实例 stdout（logs/i-<id>.log），作为"是否走到 dispose"的现场证据
								try { console.log("[sandbox-sweep] shutdown: " + attempts.join(" | ")); } catch (error) { /* ignore */ }
							})
							.catch(function (error) {
								try { console.log("[sandbox-sweep] shutdown 异常: " + msg(error)); } catch (inner) { /* ignore */ }
							})
							.finally(function () {
								try { console.log("[sandbox-sweep] 退出进程"); } catch (inner) { /* ignore */ }
								try { process.exit(0); } catch (inner) { /* ignore */ }
							});
						// v7：600 ms 太短 —— 本次实测关闭链自身要 100+ 秒，报告较大时浏览器可能还没渲染完
						// 进程就没了（表现为界面"卡住"、看不到报告）。放宽到 2.5 s 再退出。
					}, 2500);
					return json(report, 200);
				},
			}),
		"sandbox-sweep: close route",
	);

	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: ROUTE_REVOKE,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async () => {
					if (closing) return json({ error: "实例正在关闭" }, 409);
					try {
						return json(await revokeSessions(ctx), 200);
					} catch (error) {
						return json({ error: msg(error) }, 500);
					}
				},
			}),
		"sandbox-sweep: revoke route",
	);

	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: ROUTE_STOP,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async () => {
					if (closing) return json({ error: "实例正在关闭" }, 409);
					try {
						return json(await stopSessions(ctx), 200);
					} catch (error) {
						return json({ error: msg(error) }, 500);
					}
				},
			}),
		"sandbox-sweep: stop route",
	);

	// v8：能力路由 —— 客户端挂载时问一句"这个宿主能做什么"，据此决定显示哪些按钮（毫秒级，不碰 ACL）
	ctx.effect(
		() =>
			ctx.connection.fetch.register({
				path: ROUTE_CAPABILITY,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async () => json(Object.assign({ probeVersion: PROBE_VERSION }, hostCaps()), 200),
			}),
		"sandbox-sweep: capability route",
	);
}

/** 供离线冒烟测试使用（cordis 只消费 apply / inject / name）。 */
export { detectVersion, probeRoot, probeInstances, trioRisk, hostCaps, TRIO_SINCE, eraseRoots, scanTempRoots, sweepTempRoots, planTempSweep, providerTempDirs, loadSandboxModule, loadDshModule, closeInstance, shutdownHost, quiesceTerminals, flushSessions, startupSweep, revokeSessions, stopSessions, sweepStateLine, sandboxSweepSkillProvider, revokedSessions, readPeerWorkspaceRoots, readPeerLeases, writeLease, peerHomes, publishSourceNote };
