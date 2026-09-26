import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { peerHomes, probeInstances, publishSourceNote, readPeerLeases, readPeerWorkspaceRoots } from "../lib/index.js";

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

console.log(bad === 0 ? "PROBE OK" : bad + " FAILURES");
process.exitCode = bad === 0 ? 0 : 1;
