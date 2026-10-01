import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detectVersion, hostCaps, peerHomes, planTempSweep, probeInstances, publishSourceNote, readPeerLeases, readPeerWorkspaceRoots, scanTempRoots } from "../lib/index.js";

const mine = process.argv[2];
const ctx = { get: (name) => (name === "workspaceRegistry" ? { list: () => [{ path: mine }] } : undefined) };

const canon = (p) => String(p || "").replace(/[\\/]+$/, "").normalize("NFC").toLowerCase();
let bad = 0;
const check = (name, cond, extra) => { if (!cond) bad++; console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  · " + extra : "")); };

console.log("DSH_HOME = " + process.env.DSH_HOME);
console.log("homedir  = " + homedir());

/* ---------- A：真实环境（默认 ~/.dsh 不存在） ---------- */
{
	const homes = await peerHomes();
	console.log("A peerHomes = " + JSON.stringify(homes));
	const roots = [...(await readPeerWorkspaceRoots())];
	console.log("A peer roots = " + JSON.stringify(roots));
	check("A 排除自己所在的 home", !homes.some((h) => canon(h) === canon(process.env.DSH_HOME)));
	check("A 收录默认 home ~/.dsh", homes.some((h) => canon(h) === canon(join(homedir(), ".dsh"))));
	// 兄弟 home 的**数量与名字随本机布局变化**（当前 3 份）：按实际目录动态断言，别写死版本名。
	// 说明：本用例曾在 0.1.5-rc.3 被移出 home 列表后误报——那是环境变了，不是代码坏了。
	const homeDir = dirname(process.env.DSH_HOME);
	const siblings = readdirSync(homeDir, { withFileTypes: true }).filter((e) => e.isDirectory() && canon(join(homeDir, e.name)) !== canon(process.env.DSH_HOME));
	check("A 收录全部兄弟 home（动态）", siblings.every((e) => homes.some((h) => canon(h) === canon(join(homeDir, e.name)))), siblings.length + " 个兄弟");
	check("A 读得到别人登记的根", roots.length >= 1, JSON.stringify(roots.slice(0, 2)));
	// 下面两条取决于"本机还有谁用过这个目录"，只报告、不计失败
	console.log("A 提到我们根的条数 = " + (roots.includes(canon(mine)) ? 1 : 0) + "（仅信息：别人登记了我们的根，风险层会据此提示）");
	console.log("A peer 租约数 = " + (await readPeerLeases()).length + "（仅信息）");
}

/* ---------- B：默认 home 里真有一个实例在用我们的工作区 ---------- */
{
	const fakeUser = new URL("./fakehome/", import.meta.url).pathname.replace(/^\//, "");
	rmSync(fakeUser, { recursive: true, force: true });
	const fakeHome = join(fakeUser, ".dsh");
	mkdirSync(join(fakeHome, "sandbox-sweep"), { recursive: true });
	mkdirSync(join(fakeHome, "storages"), { recursive: true });
	writeFileSync(join(fakeHome, "sandbox-sweep", "instance.json"), JSON.stringify({
		pid: process.pid, version: "0.1.7-rc.2", home: fakeHome, workspaces: [mine], heartbeatAt: new Date().toISOString(),
	}));
	writeFileSync(join(fakeHome, "storages", "workspace.json"), JSON.stringify({ tables: { workspaces: { x: { path: mine } } } }));
	process.env.USERPROFILE = fakeUser;
	process.env.HOME = fakeUser;

	const homes = await peerHomes();
	console.log("B homedir   = " + homedir());
	console.log("B peerHomes = " + JSON.stringify(homes));
	check("B homedir 跟随 USERPROFILE", canon(homedir()) === canon(fakeUser));
	check("B 收录默认 home（伪造的 ~/.dsh）", homes.some((h) => canon(h) === canon(fakeHome)));

	const roots = [...(await readPeerWorkspaceRoots())];
	check("B 从登记表认出有人用过我们的根", roots.includes(canon(mine)));
	const leases = await readPeerLeases();
	check("B 认出默认 home 里的存活租约", leases.length === 1 && canon(leases[0].workspaces[0]) === canon(mine));

	const out = await probeInstances(ctx);
	const entry = out.list.find((i) => i.verified);
	check("B 合并为确认共享的实例条目", Boolean(entry) && entry.sharesWorkspace === true, JSON.stringify(entry && { pid: entry.pid, shares: entry.sharesWorkspace, source: entry.source }));

	writeFileSync(join(fakeHome, "sandbox-sweep", "instance.json"), JSON.stringify({ pid: 999999, version: "0.1.7-rc.2", workspaces: [mine], heartbeatAt: new Date().toISOString() }));
	const leases2 = await readPeerLeases();
	const roots2 = [...(await readPeerWorkspaceRoots())];
	check("B 进程死后租约作废、登记表仍算数", leases2.length === 0 && roots2.includes(canon(mine)));
	rmSync(fakeUser, { recursive: true, force: true });
}

/* ---------- C：启动时写的"源码定位"笔记（给本机其他实例用） ---------- */
{
	const fakeHome = join(new URL("./fakehome/", import.meta.url).pathname.replace(/^\//, ""), "note-home");
	rmSync(fakeHome, { recursive: true, force: true });
	process.env.DSH_HOME = fakeHome;
	const file = await publishSourceNote({});
	check("C 写出了 SOURCE.md", typeof file === "string" && existsSync(file), file || "(null)");
	const text = file && existsSync(file) ? readFileSync(file, "utf8") : "";
	check("C 里面写明了源码目录", text.includes("lib") && text.includes("SOURCE.local.md"));
	check("C 提醒不要提交/外发", text.includes("不要提交") || text.includes("不要外发"));
	check("C 列了四条红线", (text.match(/^\d\. /gm) || []).length >= 4);
	rmSync(join(fakeHome, ".."), { recursive: true, force: true });
}

/* ---------- D：实例 temp 根扫描（把 TEMP/LOCALAPPDATA/USERPROFILE 重定向到假目录；只读，不碰真实临时区） ---------- */
{
	const fakeRoot = new URL("./faketemp/", import.meta.url).pathname.replace(/^\//, "");
	rmSync(fakeRoot, { recursive: true, force: true });
	const fakeTemp = join(fakeRoot, "tmp");
	mkdirSync(join(fakeTemp, "dsh-abc123"), { recursive: true });
	mkdirSync(join(fakeTemp, "dsh-DEF456"), { recursive: true });
	writeFileSync(join(fakeTemp, "dsh-DEF456", "aa.lock"), "x");
	mkdirSync(join(fakeTemp, "dsh-spill-zzz"), { recursive: true });
	mkdirSync(join(fakeTemp, "dsh-subprocess-zz"), { recursive: true });
	mkdirSync(join(fakeTemp, "not-a-dsh-dir"), { recursive: true });
	mkdirSync(join(fakeTemp, "dsh-toolong-name"), { recursive: true });
	process.env.TEMP = fakeTemp;
	process.env.TMP = fakeTemp;
	process.env.LOCALAPPDATA = join(fakeRoot, "local");
	process.env.USERPROFILE = join(fakeRoot, "user");
	mkdirSync(process.env.USERPROFILE, { recursive: true });

	const inv = await scanTempRoots(true);
	check("D 候选父目录跟随 TEMP", inv.parents.some((p) => canon(p) === canon(fakeTemp)), JSON.stringify(inv.parents));
	check("D 只认 dsh-<6位>（spill / subprocess / 过长名都不碰）", inv.scanned === 2, "scanned=" + inv.scanned);
	const locked = inv.roots.find((r) => r.root.endsWith("dsh-DEF456"));
	check("D 认出 .lock（占用信号）", Boolean(locked) && locked.locks === 1, JSON.stringify(locked && locked.locks));
	check("D 刚建的目录不算闲置", inv.roots.every((r) => r.idle === false));
	const fresh = inv.roots.find((r) => r.root.endsWith("dsh-abc123"));
	const past = new Date(Date.now() - 20 * 60 * 1000);
	utimesSync(fresh.root, past, past);
	rmSync(join(fakeTemp, "dsh-DEF456", "aa.lock"));
	const inv2 = await scanTempRoots(true);
	const aged = inv2.roots.find((r) => r.root.endsWith("dsh-abc123"));
	check("D 闲置 ≥10 分钟 → idle（分层清理的依据）", Boolean(aged) && aged.idle === true, JSON.stringify(aged && { idle: aged.idle }));
	rmSync(fakeRoot, { recursive: true, force: true });
}

/* ---------- E：temp 分层判据（纯函数 planTempSweep，不碰真实临时区） ---------- */
{
	const mkRoot = (letter, locks, idle) => ({ root: "C:\\Temp\\dsh-" + letter.repeat(6), locks, idle, deny: false });
	const ownRoot = mkRoot("A", 0, false);
	const ownSet = {};
	ownSet[canon(ownRoot.root)] = true;
	const mk = (phase, lastInstance) =>
		planTempSweep([{ ...ownRoot }, mkRoot("B", 0, true), mkRoot("C", 1, false)], {
			phase, lastInstance, known: {}, ownSet, ownFallback: false,
		});
	const closePlan = mk("close", false);
	check("E 关闭：自己的根即使刚被碰过也删（机上有别的实例也照删）", closePlan.targets.some((r) => r.root === ownRoot.root) && closePlan.own.length === 1);
	check("E 关闭：别人的、刚被碰过且带 .lock 的根不删", closePlan.skipped.some((r) => r.root.endsWith("CCCCCC")));
	const userPlan = mk("user", false);
	check("E 点清理：自己的根一律跳过（删它=抽掉当前会话的 TEMP）", !userPlan.targets.some((r) => r.own) && userPlan.skipped.some((r) => r.own === true));
	check("E 点清理：闲置且无 .lock 的根照删", userPlan.targets.some((r) => r.root.endsWith("BBBBBB")));
	const bootLast = mk("boot", true);
	// v7：即便"本机仅此实例"，也**只放宽 .lock**；"刚被碰过"的仍不删（防止误删活实例的根）
	check("E 启动且本机仅此实例：只删闲置的（刚被碰过的仍不删）", bootLast.targets.length === 1 && bootLast.targets[0].root.endsWith("BBBBBB"));
	const bootBusy = mk("boot", false);
	check("E 启动且有别的实例：只删闲置无锁的", bootBusy.targets.length === 1 && bootBusy.targets[0].root.endsWith("BBBBBB"));

	/* ---- v7 回归：2026-09-27 实测事故（删掉活实例的 temp 根） ---- */
	const fresh = mkRoot("D", 0, false);
	const planFresh = planTempSweep([{ ...fresh }], {
		phase: "close", lastInstance: true, known: {}, ownSet: {}, ownFallback: false, peerTempRoots: {},
	});
	check("E v7：即便判定为「本机仅此实例」，也不删刚被碰过的根", planFresh.targets.length === 0 && planFresh.skipped.some((r) => /最近仍被碰过/.test(r.reason)), JSON.stringify(planFresh.skipped.map((r) => r.reason)));

	const lockIdle = mkRoot("E", 1, true);
	const planLock = planTempSweep([{ ...lockIdle }], {
		phase: "close", lastInstance: true, known: {}, ownSet: {}, ownFallback: false, peerTempRoots: {},
	});
	check("E v7：仅此实例时只放宽 .lock（有 .lock 但闲置 → 可删）", planLock.targets.length === 1 && planLock.targets[0].root === lockIdle.root);

	const peerRoot = mkRoot("F", 0, true);
	const peerSet = {};
	peerSet[canon(peerRoot.root)] = true;
	const planPeer = planTempSweep([{ ...peerRoot }], {
		phase: "close", lastInstance: true, known: {}, ownSet: {}, ownFallback: false, peerTempRoots: peerSet,
	});
	check("E v7：活租约声明过的根一律不碰（声明免疫）", planPeer.targets.length === 0 && planPeer.skipped.some((r) => r.peerDeclared === true), JSON.stringify(planPeer.skipped.map((r) => r.reason)));
}

/* ---------- F：宿主能力分流的前置条件 —— 沙箱被 dsh-sandbox-legacy-acl 接管（v10） ---------- */
{
	const fakeHome = join(new URL("./fakehome/", import.meta.url).pathname.replace(/^\//, ""), "caps-home");
	rmSync(fakeHome, { recursive: true, force: true });
	mkdirSync(fakeHome, { recursive: true });
	const savedHome = process.env.DSH_HOME;
	// 让 detectVersion() 从命令行解析出 0.1.7-rc.2（= 本机那份会被 legacy-acl 接管的实例）
	const savedArgv = process.argv.slice();
	process.argv.length = 0;
	process.argv.push(savedArgv[0] || "node", "C:\\x\\versions\\0.1.7-rc.2\\node_modules\\@deepseek-ai\\dsh-web-app\\bin.js");
	process.env.DSH_HOME = fakeHome;
	const reportFile = join(fakeHome, "sandbox-legacy-acl", "report.json");
	console.log("F 版本 = " + JSON.stringify(detectVersion()) + " · report = " + reportFile);

	// (a) 已接管：status=installed 且 enabled=true → 按早期宿主（0.1.5 那一档）处理：只有关闭
	mkdirSync(dirname(reportFile), { recursive: true });
	writeFileSync(reportFile, JSON.stringify({ plugin: "dsh-sandbox-legacy-acl", enabled: true, status: "installed", reason: "x" }));
	const taken = hostCaps();
	check("F(a) legacy-acl 接管 → 只有关闭这一档（sweep=false / tier=legacy / source=legacy-acl-plugin）",
		taken.sweep === false && taken.close === true && taken.tier === "legacy" && taken.source === "legacy-acl-plugin"
			&& taken.trioHost === true && taken.legacyAcl.detected === true && taken.legacyAcl.status === "installed" && taken.legacyAcl.enabled === true,
		JSON.stringify({ sweep: taken.sweep, tier: taken.tier, source: taken.source, trioHost: taken.trioHost, status: taken.legacyAcl.status, enabled: taken.legacyAcl.enabled }));

	// (b) 文件不存在 → 保守回到按宿主版本判（0.1.7-rc.2 会写三件套 → sweep=true）
	rmSync(reportFile, { force: true });
	const absent = hostCaps();
	check("F(b) report.json 不存在 → 回原逻辑（按宿主版本判：sweep=true / source=host-version）",
		absent.sweep === true && absent.tier === "trio" && absent.source === "host-version" && absent.trioHost === true
			&& absent.legacyAcl.present === false && absent.legacyAcl.detected === false && absent.legacyAcl.error === null,
		JSON.stringify({ sweep: absent.sweep, tier: absent.tier, source: absent.source, present: absent.legacyAcl.present, error: absent.legacyAcl.error }));

	// (c) 损坏（非法 JSON）→ 保守回原逻辑，且**不抛错**
	writeFileSync(reportFile, '{ "status": "installed", "enabled": tru');
	let broken = null;
	let threw = null;
	try { broken = hostCaps(); } catch (error) { threw = String((error && error.message) || error); }
	check("F(c) report.json 损坏 → 保守回原逻辑且不抛错",
		threw === null && Boolean(broken) && broken.sweep === true && broken.source === "host-version"
			&& broken.legacyAcl.present === true && /解析失败/.test(String(broken.legacyAcl.error)),
		JSON.stringify({ threw: threw, sweep: broken && broken.sweep, source: broken && broken.source, error: broken && broken.legacyAcl.error }));

	// (c2) 不是 JSON、而是任意二进制/空文件：同样回原逻辑
	writeFileSync(reportFile, "");
	let blank = null;
	let threw2 = null;
	try { blank = hostCaps(); } catch (error) { threw2 = String((error && error.message) || error); }
	check("F(c2) report.json 为空文件 → 保守回原逻辑且不抛错",
		threw2 === null && Boolean(blank) && blank.sweep === true && blank.source === "host-version",
		JSON.stringify({ threw: threw2, sweep: blank && blank.sweep, error: blank && blank.legacyAcl.error }));

	// (d) status/enabled 差一点（installed 但 enabled=false；enabled=true 但 status=uninstalled）→ 也回原逻辑
	writeFileSync(reportFile, JSON.stringify({ enabled: false, status: "installed" }));
	const d1 = hostCaps();
	writeFileSync(reportFile, JSON.stringify({ enabled: true, status: "uninstalled" }));
	const d2 = hostCaps();
	check("F(d) 只差一个字段 → 也回原逻辑（判据严格等价于 status=installed ∧ enabled=true）",
		d1.sweep === true && d1.source === "host-version" && d2.sweep === true && d2.source === "host-version",
		JSON.stringify({ d1: [d1.sweep, d1.legacyAcl.status, d1.legacyAcl.enabled], d2: [d2.sweep, d2.legacyAcl.status, d2.legacyAcl.enabled] }));

	process.argv.length = 0;
	for (const a of savedArgv) process.argv.push(a);
	process.env.DSH_HOME = savedHome;
	rmSync(join(fakeHome, ".."), { recursive: true, force: true });
}

console.log(bad === 0 ? "PROBE OK" : bad + " FAILURES");
process.exitCode = bad === 0 ? 0 : 1;
