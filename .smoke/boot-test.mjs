import { readFileSync } from "node:fs";

/* ---------- 极简 React 桩：够跑一遍渲染路径，发现"一渲染就抛"的问题 ---------- */
let rendering = null;
const hookSlots = new Map();
let cursor = 0;
const hookKey = () => rendering + "#" + cursor++;

const effectQueue = [];
const React = {
	Fragment: Symbol("Fragment"),
	createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length ? (children.length === 1 ? children[0] : children) : (props || {}).children } }),
	useState(initial) {
		const k = hookKey();
		if (!hookSlots.has(k)) hookSlots.set(k, typeof initial === "function" ? initial() : initial);
		return [hookSlots.get(k), (v) => { hookSlots.set(k, typeof v === "function" ? v(hookSlots.get(k)) : v); }];
	},
	useRef(initial) { const k = hookKey(); if (!hookSlots.has(k)) hookSlots.set(k, { current: initial }); return hookSlots.get(k); },
	useEffect(fn) { hookQueue.push(fn); },
	useMemo(fn) { return fn(); },
	useCallback(fn) { return fn; },
};
const hookQueue = [];

const jsxRuntime = {
	Fragment: React.Fragment,
	jsx: (type, props, key) => ({ type, props: props || {}, key }),
	jsxs: (type, props, key) => ({ type, props: props || {}, key }),
};
const reactDom = { createPortal: (node, container) => ({ type: "portal", props: { node, container } }) };

const modules = { react: React, "react/jsx-runtime": jsxRuntime, "react-dom": reactDom };

/* ---------- 装载 bundle（与 DSH 客户端 loader 同形） ---------- */
let definition = null;
globalThis.window = {
	__ModuleLoader__: { load: (def) => { definition = def; } },
	addEventListener: () => {}, removeEventListener: () => {},
};
new Function("require", readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"))((id) => {
	if (!(id in modules)) throw new Error("unexpected module: " + id);
	return modules[id];
});
if (!definition) throw new Error("bundle did not call __ModuleLoader__.load");
const exported = definition.factory((id) => {
	if (!(id in modules)) throw new Error("unexpected module: " + id);
	return modules[id];
});
console.log("id=" + definition.id + " exports=" + Object.keys(exported).join(",") + " inject=" + JSON.stringify(exported.inject));

/* ---------- apply + 渲染整棵树 ---------- */
let seat = null;
const ctx = {
	slots: {
		inject: (name, cb) => { const d = cb(); seat = { name, spec: d && d.spec, component: (d && (d.component || d.Component)) || null }; return () => {}; },
		register: (spec, component) => ({ spec, component }),
	},
	locale: { register: () => () => {}, t: (ns, key) => key },
	effect: (fn) => { const d = fn(); return () => { if (typeof d === "function") d(); }; },
	get: () => undefined,
};
exported.apply(ctx);
if (!seat) throw new Error("no seat registered");
console.log("seat=" + seat.name + " spec=" + JSON.stringify(seat.spec) + " component=" + (seat.component && seat.component.name));

function walk(node, depth, path) {
	if (node === null || node === undefined || typeof node === "boolean") return 0;
	if (Array.isArray(node)) return node.reduce((n, child, i) => n + walk(child, depth, path + "." + i), 0);
	if (typeof node === "string" || typeof node === "number") return 1;
	if (typeof node.type === "function") {
		const name = node.type.name || "anon";
		const saved = rendering;
		rendering = path + "/" + name;
		cursor = 0;
		let out;
		try {
			out = node.type(node.props || {});
		} catch (error) {
			throw new Error("render " + name + " threw: " + (error && error.message));
		}
		rendering = saved;
		return walk(out, depth + 1, path + "/" + name);
	}
	return walk(node.props && node.props.children, depth + 1, path);
}

const Comp = seat.component || exported.SandboxSweepActions;
const tree = Comp({ wide: true });
const nodes = walk(tree, 0, "root");
console.log("渲染节点数=" + nodes + "，无异常");

/* ---------- 把弹窗（含原始报告块）也真渲染一遍 ---------- */
function textOf(node, out) {
	out = out || [];
	if (node === null || node === undefined || typeof node === "boolean") return out;
	if (Array.isArray(node)) { for (const c of node) textOf(c, out); return out; }
	if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
	if (typeof node.type === "function") { const saved = rendering; rendering = "t/" + (node.type.name || "anon"); cursor = 0; const r = node.type(node.props || {}); rendering = saved; textOf(r, out); return out; }
	textOf(node.props && node.props.children, out);
	return out;
}

const RAW = "{\n \"probeVersion\": 3,\n \"errors\": []\n}\n\n--- 错误 ---\nHTTP 500";
hookSlots.set("root/SandboxSweepActions#0", {
	dialog: "sweep",
	report: {
		probeVersion: 3, collectedAt: "x",
		host: { version: "0.1.7-rc.2", node: "22.23.2", pid: 1, home: "H", webUrl: "U" },
		sessions: [{ id: "s1", activity: ["turn"], terminals: 1 }], jobs: [{ id: "j1" }], terminals: [{ session: "s1", name: "t", status: "running" }],
		workspaces: [
			{ root: "C:\\a\\b", ace: true, deny: true, lowLabel: true, error: null },
			{ root: "C:\\c", ace: null, deny: null, lowLabel: null, error: "denied" },
		],
		otherInstances: [{ pid: 9, version: "0.1.5-rc.3", sharesWorkspace: null, verified: false, risk: "no" }],
		errors: ["会话枚举失败: x"], instancesScanned: false,
	},
	risks: [
		{ kind: "work", title: "riskWorkT", desc: "riskWorkD", detail: "turn" },
		{ kind: "shape", title: "riskShapeT", desc: "riskShapeD", detail: "缺字段: x" },
		{ kind: "calc", title: "riskCalcT", desc: "riskCalcD", detail: "boom" },
	],
	steps: [{ name: "权限回收（会话切只读）", ok: true, detail: "2/2" }, { name: "擦除三件套", ok: false, detail: "residue=[delete deny]" }],
	busy: false, pending: null, executing: false, error: "HTTP 500 · boom", erase: true, toast: null, raw: RAW,
});
// 直接调用组件时也要让 hook 键与种子状态对上（与 walk 里的算法一致）
rendering = "root/SandboxSweepActions";
cursor = 0;
const tree2 = Comp({ wide: false });
const nodes2 = walk(tree2, 0, "root");
const allText = textOf(tree2).join("\n");
const need = ["原始自检报告", "有正在跑的工作", "自检报告结构不认识", "风险判定本身出错", "residue=[delete deny]", "rawHint" in {} ? "" : RAW.slice(0, 12)];
let missing = need.filter((s) => s && allText.indexOf(s) === -1);
console.log("弹窗渲染节点数=" + nodes2 + " · 文本长度=" + allText.length);
console.log(missing.length === 0 ? "DIALOG OK（风险项、执行明细、原始报告块都在）" : "DIALOG MISSING: " + JSON.stringify(missing));
console.log("BOOT OK");
