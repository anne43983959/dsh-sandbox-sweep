import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/* ---- 取出真实的 computeRisks 源码并求值（不是副本） ---- */
const start = src.indexOf("function computeRisks(r, action, eraseFlag) {");
if (start < 0) throw new Error("computeRisks not found");
const endMarker = "\n\t\t}\n";
const end = src.indexOf(endMarker, start) + endMarker.length;
const body = src.slice(start, end);
// computeRisks 里引用了 PROBE_MIN，一并取出来注入（保证测的是真源码，不是副本）
const minMatch = src.match(/const PROBE_MIN = (\d+);/);
if (!minMatch) throw new Error("PROBE_MIN not found");
const computeRisks = new Function("const PROBE_MIN = " + minMatch[1] + ";\n return " + body)();

/* ---- 取两份文案词典的键 ---- */
const keys = (block) => new Set([...block.matchAll(/^\t{3}([A-Za-z]+):/gm)].map((m) => m[1]));
const zhStart = src.indexOf("const zh = {");
const enStart = src.indexOf("const en = {");
if (zhStart < 0 || enStart < 0) throw new Error("dict not found");
const zh = keys(src.slice(zhStart, enStart));
const en = keys(src.slice(enStart, src.indexOf("const t =", enStart) > 0 ? src.indexOf("const t =", enStart) : undefined));

const clean = { root: "R", ace: false, deny: false, lowLabel: false, error: null };
const trio = { root: "R", ace: true, deny: true, lowLabel: true, error: null };
const base = { probeVersion: Number(minMatch[1]), instancesScanned: true, workspaces: [clean], otherInstances: [], sessions: [], errors: [] };
const peerUnknown = { pid: 3, version: "0.1.5-rc.3", sharesWorkspace: null, verified: false };
const peerShares = { pid: 2, version: "0.1.7-rc.2", sharesWorkspace: true, verified: true };
const peerOther = { pid: 4, version: "0.1.7-rc.1", sharesWorkspace: false, verified: false };
const live = { id: "s1", activity: ["turn"] };

const kinds = (v) => v.risks.map((r) => r.kind).join(",");
const cases = [
	["清理 · 全干净 → 空操作、不打扰", { ...base }, "sweep", true, (v) => v.noop === true && kinds(v) === ""],
	["清理 · 只剩 ACE → 有活可干、无风险", { ...base, workspaces: [trio] }, "sweep", true, (v) => v.noop === false && kinds(v) === ""],
	["清理 · 三件套 + 无法归属 → unknown", { ...base, workspaces: [trio], otherInstances: [peerUnknown] }, "sweep", true, (v) => kinds(v) === "unknown"],
	["清理 · 三件套 + 有人用别的工作区 → 不弹窗", { ...base, workspaces: [trio], otherInstances: [peerOther] }, "sweep", true, (v) => kinds(v) === ""],
	["清理 · 三件套 + 确认共享 → sharing", { ...base, workspaces: [trio], otherInstances: [peerShares] }, "sweep", true, (v) => kinds(v) === "sharing"],
	["清理 · 三件套 + 枚举失败 → scan", { ...base, workspaces: [trio], instancesScanned: false }, "sweep", true, (v) => kinds(v) === "scan"],
	["清理 · 三件套 + 有活 → work", { ...base, workspaces: [trio], sessions: [live] }, "sweep", true, (v) => kinds(v) === "work"],
	["清理 · ACL 读不到 → acl（优先）", { ...base, workspaces: [{ root: "R", error: "denied" }] }, "sweep", true, (v) => kinds(v) === "acl"],
	["关闭 · 全干净 + 有活 → work（修好的那条）", { ...base, sessions: [live] }, "close", true, (v) => v.noop === true && kinds(v) === "work"],
	["关闭 · 全干净 + 无法归属 → 不列 sharing/unknown", { ...base, otherInstances: [peerUnknown] }, "close", true, (v) => kinds(v) === ""],
	["关闭 · 三件套 + 无法归属 + 要擦 → unknown", { ...base, workspaces: [trio], otherInstances: [peerUnknown] }, "close", true, (v) => kinds(v) === "unknown"],
	["关闭 · 三件套 + 无法归属 + 不擦 → 无风险", { ...base, workspaces: [trio], otherInstances: [peerUnknown] }, "close", false, (v) => kinds(v) === ""],
	["关闭 · 三件套 + 确认共享 + 要擦 → sharing", { ...base, workspaces: [trio], otherInstances: [peerShares] }, "close", true, (v) => kinds(v) === "sharing"],

	/* ---- 兜底：没枚举到 / 报告不完整的情况，一律弹窗，绝不静默 ---- */
	["兜底 · 响应不是对象 → shape", null, "sweep", true, (v) => v.noop === false && kinds(v) === "shape"],
	["兜底 · workspaces 缺字段（列表也能空）→ shape，且不空操作", { probeVersion: Number(minMatch[1]), instancesScanned: true, sessions: [], otherInstances: [], errors: [] }, "sweep", true, (v) => v.noop === false && kinds(v) === "shape"],
	["兜底 · workspaces 不是数组 → shape", { ...base, workspaces: "oops" }, "sweep", true, (v) => v.noop === false && kinds(v) === "shape"],
	["兜底 · 一个工作区都没有 → noroot（不许说「无需清理」）", { ...base, workspaces: [] }, "sweep", true, (v) => v.noop === false && kinds(v) === "noroot"],
	["兜底 · 宿主报告版本更旧 → stale", { ...base, probeVersion: 1 }, "sweep", true, (v) => v.noop === false && kinds(v) === "stale"],
	["兜底 · 报告无版本号（多半没重启）→ stale", { ...base, probeVersion: undefined }, "sweep", true, (v) => v.noop === false && kinds(v) === "stale"],
	["兜底 · 报告自带错误项 → diag", { ...base, errors: ["会话枚举失败: x"] }, "sweep", true, (v) => v.noop === false && kinds(v) === "diag"],
	["兜底 · sessions 缺字段 → shape", { probeVersion: Number(minMatch[1]), workspaces: [clean], otherInstances: [], errors: [] }, "close", true, (v) => v.noop === false && kinds(v) === "shape"],
];

let bad = 0;
for (const [name, input, action, erase, ok] of cases) {
	const out = computeRisks(input, action, erase);
	const pass = ok(out);
	if (!pass) bad++;
	console.log((pass ? "PASS " : "FAIL ") + name + "  ->  [" + kinds(out) + "] noop=" + out.noop);
}

const used = new Set([...body.matchAll(/"(risk[A-Za-z]+)"/g)].map((m) => m[1]));
for (const k of used) {
	if (!zh.has(k) || !en.has(k)) { bad++; console.log("FAIL 文案缺失 " + k + " zh=" + zh.has(k) + " en=" + en.has(k)); }
}
console.log("文案键 " + [...used].join(",") + " · zh=" + zh.size + " en=" + en.size);
console.log(bad === 0 ? "ALL OK" : bad + " FAILURES");
process.exitCode = bad === 0 ? 0 : 1;
