/**
 * dsh-sandbox-sweep · 客户端半（M6：风险驱动交互）
 *
 * 交互模型（按作者要求）：
 *  - 点击按钮先静默自检；
 *  - **无风险** → 不弹窗，直接执行，成功只弹气泡；失败才弹窗贴错误报告；
 *  - **有风险** → 弹窗如实列出风险；作者在弹窗里**无需勾选**，再次点击「清理 / 关闭DSH」即视为接受风险；
 *  - 关窗方式：Esc / 点击遮罩 / 右上角 ×。
 *
 * 风险判定（不假设对方也装了本插件）：
 *  · 工作区 ACL 读不到（状态未知）
 *  · 其他实例**确认共享**本工作区
 *  · 其他实例**无法确认**是否共享（没装本插件、无租约）→ 按风险如实提示
 *  · 有正在跑的工作（回合 / 子智能体 / 后台作业 / 定时提醒）→ 会被终止
 */
window.__ModuleLoader__.load({
	id: "dsh-sandbox-sweep",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;
		const Fragment = jsxRuntime.Fragment;

		const NS = "sandboxSweep";
		const PROBE_URL = "/api/sandbox-sweep/probe";
		const CAP_URL = "/api/sandbox-sweep/capability";
		const STOP_URL = "/api/sandbox-sweep/stop-sessions";
		const REVOKE_URL = "/api/sandbox-sweep/revoke";
		const ERASE_URL = "/api/sandbox-sweep/erase";
		const CLOSE_URL = "/api/sandbox-sweep/close";
		const ICON_PX = 20;

		const zh = {
			sweep: "清理沙箱痕迹",
			close: "关闭DSH",
			sweepTitle: "清理沙箱痕迹 · 低完整性标签残留",
			closeTitle: "关闭 DeepSeek Harness 实例",
			stage: "M6 · 风险驱动：无风险直接执行，有风险先提示、再点一次即接受",
			probing: "正在自检…",
			probeFailed: "自检失败",
			closeX: "关闭",
			rawTitle: "原始自检报告（点开可复制）",
			rawHint: "看不懂结论时：点一下下面这段文字即全选，Ctrl+C 复制，直接问 DSH「这是什么意思、有没有风险」。",
			riskTitle: "本次操作存在以下风险",
			riskAccept: "在弹窗内再次点击下方按钮，即视为你已知悉并接受上述风险。",
			riskAclT: "工作区状态未知",
			riskAclD: "有工作区的 ACL 读不到，无法确认是否还残留三件套。",
			riskStaleT: "宿主半版本不认识",
			riskStaleD: "自检报告的版本比界面认识的旧（多半是只换了文件、没重启实例）。报告可能不完整，先重启实例再试更稳妥。",
			riskShapeT: "自检报告结构不认识",
			riskShapeD: "报告缺少本界面需要的关键字段，无法据此判断「能不能安全清理」。下面附了原始报告，可复制出来问一问。",
			riskDiagT: "自检过程中有步骤失败",
			riskDiagD: "报告里带了错误项，说明有些信息没查全（例如会话/工作区枚举失败），结论可能不完整。",
			riskNoRootT: "报告里没有任何工作区",
			riskNoRootD: "宿主没能列出本实例的工作区（服务缺失或枚举失败），因此「没有痕迹」这个结论不成立。",
			riskCalcT: "风险判定本身出错",
			riskCalcD: "界面在解读自检报告时抛了异常，无法判断风险；原始报告附在下面，可复制出来问一问。",
			riskScanT: "无法枚举同机实例",
			riskScanD: "进程枚举失败，无法确认本机是否还有其他 DSH 实例；若它们共用本工作区，清理会影响它们。",
			riskSharingT: "另一实例正在使用同一工作区",
			riskSharingD: "擦除会让它的受限写入开始失败。建议先关闭它。",
			riskUnknownT: "无法确认其他实例是否使用同一工作区",
			riskUnknownD: "该实例没有本插件的租约（多半未安装）；但同机某个 home 登记过本工作区，无法排除它正在使用——若共用，清理会影响它。",
			riskWorkT: "有正在跑的工作",
			riskWorkD: "清理与关闭都会**终止**本实例所有会话正在跑的工作（回合 / 子智能体 / 后台作业 / 定时提醒），排队中的输入会被丢弃。",
			runSweep: "清理",
			runClose: "关闭DSH",
			executing: "正在执行…",
			failed: "执行失败",
			toastSweepOk: "清理成功",
			toastNoop: "无需清理：没有会碍事的沙箱痕迹",
			toastClose: "已请求关闭，实例正在退出…",
			closeEraseToggle: "关闭时一并清理沙箱痕迹（默认开启）",
			hostNoSweep: "宿主 < 0.1.7-alpha.1（不写三件套）：只提供优雅退出，不做清理",
			secSessions: "活跃对话",
			secJobs: "后台作业",
			secInstances: "其他实例",
			secErrors: "采集告警",
			kTerminals: "终端",
			secTemp: "临时区",
			kIdle: "可清理",
			kLocked: "占用中",
			kFresh: "刚用过",
			kLast: "本机仅此实例",
			stopActivity: "在跑：",
			kAce: "能力ACE(缓存)",
			kDeny: "删除拒绝",
			kLow: "低标签",
			shareYes: "共享本工作区",
			shareUnknown: "工作区未确认",
			riskYes: "会写入三件套",
			riskNo: "无三件套写入",
			riskUnknown: "版本未知（按有风险处理）",
			verified: "校验通过",
			kAceKept: "能力ACE保留（复用缓存）",
			notVerified: "未通过（已记入台账，下次启动可重试）",
			ledger: "台账",
		};
		const en = {
			sweep: "Sweep sandbox traces",
			close: "Close DSH",
			sweepTitle: "Sweep sandbox traces · low-integrity label residue",
			closeTitle: "Close the DeepSeek Harness instance",
			stage: "M6 · risk-driven: no risk runs directly, risk asks first — a second click accepts",
			probing: "Self-checking…",
			probeFailed: "Self-check failed",
			closeX: "Close",
			rawTitle: "Raw self-check report (open to copy)",
			rawHint: "Not sure about the verdict above? Click the text below to select it all, copy with Ctrl+C, and ask DSH what it means.",
			riskTitle: "This action carries the following risks",
			riskAccept: "Clicking the button below again means you accept the risks above.",
			riskAclT: "Workspace state unknown",
			riskAclD: "A workspace ACL could not be read, so leftover trio state cannot be confirmed.",
			riskStaleT: "Host half version not recognised",
			riskStaleD: "The self-check report is older than this UI understands (usually files were replaced without restarting the instance). It may be incomplete.",
			riskShapeT: "Unrecognised report shape",
			riskShapeD: "The report is missing fields this UI needs, so it cannot tell whether sweeping is safe. The raw report is attached below for copying.",
			riskDiagT: "Some self-check steps failed",
			riskDiagD: "The report carries error entries, so parts of it (e.g. session/workspace enumeration) are incomplete.",
			riskNoRootT: "No workspace in the report",
			riskNoRootD: "The host listed no workspace for this instance (service missing or enumeration failed), so \"no traces\" cannot be concluded.",
			riskCalcT: "Risk assessment itself failed",
			riskCalcD: "The UI threw while reading the self-check report; the raw report is attached below for copying.",
			riskScanT: "Cannot enumerate instances on this machine",
			riskScanD: "Process enumeration failed, so other DSH instances cannot be ruled out; if they share this workspace, sweeping affects them.",
			riskSharingT: "Another instance is using this workspace",
			riskSharingD: "Erasing would break that instance's confined writes. Close it first if possible.",
			riskUnknownT: "Cannot tell whether another instance uses this workspace",
			riskUnknownD: "That instance has no lease from this plugin (likely not installed), but some home on this machine has this workspace registered, so its use cannot be ruled out; if shared, sweeping will affect it.",
			riskWorkT: "Work is running",
			riskWorkD: "Both sweep and close TERMINATE all running work in this instance (turns / subagents / jobs / schedules); queued input is discarded.",
			runSweep: "Sweep",
			runClose: "Close DSH",
			executing: "Running…",
			failed: "Failed",
			toastSweepOk: "Sweep finished",
			toastNoop: "Nothing to sweep: no sandbox traces in the workspace",
			toastClose: "Close requested; the instance is exiting…",
			closeEraseToggle: "Also sweep sandbox traces when closing (on by default)",
			hostNoSweep: "Host < 0.1.7-alpha.1 (writes no trio): graceful close only",
			secSessions: "Live conversations",
			secJobs: "Background jobs",
			secInstances: "Other instances",
			secErrors: "Collection warnings",
			kTerminals: "Terminals",
			secTemp: "Temp dirs",
			kIdle: "sweepable",
			kLocked: "in use",
			kFresh: "recently used",
			kLast: "last instance on this machine",
			stopActivity: "running: ",
			kAce: "capability ACE (cache) ",
			kDeny: "delete deny ",
			kLow: "low label ",
			shareYes: "shares this workspace",
			shareUnknown: "workspace unverified",
			riskYes: "writes the trio",
			riskNo: "no trio writes",
			riskUnknown: "unknown version (treated as risk)",
			verified: "verified",
			kAceKept: "capability ACE kept (reuse cache)",
			notVerified: "not verified (recorded in the ledger)",
			ledger: "Ledger",
		};

		function BroomIcon() {
			return jsxs("svg", {
				viewBox: "0 0 16 16", width: ICON_PX, height: ICON_PX, fill: "none", stroke: "currentColor",
				strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
				children: [
					jsx("path", { d: "M13.6 2.4 8.6 7.4" }),
					jsx("path", { d: "M7.8 6.6 9.4 8.2 7.5 12.2 3.8 8.5Z" }),
					jsx("path", { d: "M8.6 7.4 5.6 10.4" }),
				],
			});
		}

		function PowerIcon() {
			return jsxs("svg", {
				viewBox: "0 0 16 16", width: ICON_PX, height: ICON_PX, fill: "none", stroke: "currentColor",
				strokeWidth: 1.4, strokeLinecap: "round", "aria-hidden": "true",
				children: [
					jsx("path", { d: "M8 2.6v5" }),
					jsx("path", { d: "M5.4 4.4a4.4 4.4 0 1 0 5.2 0" }),
				],
			});
		}

		const CSS_ID = "dsh-sandbox-sweep-style";
		const CSS = [
			".dss-wrap{display:flex;box-sizing:border-box;flex:1 1 auto;min-width:0}",
			".dss-wrap.dss-wide{flex-direction:row;gap:8px;margin:0 2px 8px}",
			".dss-wrap.dss-rail{flex-direction:column;align-items:center;gap:6px;margin:0 0 8px;flex:none}",
			// 注意：0.1.5-rc.x 的主题里**没有** --dsw-* 这些 token（实测），var() 无回退值会被整条丢弃 → 按钮变方块。
			".dss-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.32));border-radius:var(--dsw-radius-md,10px);",
			"background:var(--dsw-alias-button-elevated-fill,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,inherit);cursor:pointer;font:inherit;",
			"font-size:14px;font-weight:500;line-height:22px;display:flex;align-items:center;justify-content:center;gap:6px;",
			"height:38px;padding:8px 12px;overflow:hidden;position:relative;min-width:0;flex:1 1 0}",
			".dss-btn:hover{background:var(--dsw-alias-button-floating-hover,rgba(127,127,127,.16))}",
			".dss-btn:disabled{opacity:.5;cursor:not-allowed}",
			".dss-btn>svg{flex:none}",
			".dss-btn .dss-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dss-btn.dss-danger{color:var(--dsw-alias-label-error,#e5484d);border-color:var(--dsw-alias-state-error-primary,#e5484d);background:var(--dsw-alias-state-error-tertiary,rgba(229,72,77,.10))}",
			".dss-btn.dss-danger:hover{background:var(--dsw-alias-state-error-secondary,rgba(229,72,77,.18))}",
			".dss-rail .dss-btn{flex:none;width:36px;height:36px;padding:0;gap:0;background:transparent;border-color:transparent;border-radius:var(--dsw-radius-md,10px)}",
			".dss-rail .dss-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dss-rail .dss-btn.dss-danger{border-color:transparent}",
			".dss-rail .dss-btn .dss-label{max-width:0;overflow:hidden}",
			".dss-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999}",
			".dss-card{position:relative;max-width:620px;width:min(94vw,620px);max-height:88vh;overflow:auto;background:var(--dsw-alias-bg-base,#fff);",
			"color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));",
			"border-radius:12px;padding:14px 16px;box-shadow:0 12px 40px rgba(0,0,0,.25)}",
			".dss-x{position:absolute;top:6px;right:8px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;",
			"background:transparent;border:none;color:inherit;opacity:.55;font-size:16px;line-height:1;cursor:pointer;border-radius:6px;padding:0}",
			".dss-x:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15))}",
			".dss-title{font-size:14px;font-weight:600;margin-bottom:2px;padding-right:26px}",
			".dss-stage{font-size:11px;opacity:.7;margin-bottom:6px}",
			".dss-line{font-size:12px;line-height:1.5;margin:3px 0}",
			".dss-dense{font-size:12px;line-height:1.5;margin:3px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dss-sec{margin:8px 0 3px;font-size:11px;font-weight:600;opacity:.85;border-top:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.25));padding-top:6px}",
			".dss-kv{display:flex;gap:8px;font-size:12px;line-height:1.6}",
			".dss-k{opacity:.6;min-width:92px;flex:none}",
			".dss-v{word-break:break-all;min-width:0}",
			".dss-bad{color:var(--dsw-alias-label-error,#e5484d)}",
			".dss-ok{color:var(--dsw-alias-state-success-primary,#2ea043)}",
			".dss-warn{color:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dss-note{font-size:11.5px;opacity:.85;margin:4px 0}",
			".dss-act{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}",
			".dss-act .dss-btn{flex:none;padding:5px 14px;height:32px;font-size:13px}",
			".dss-risk{margin:6px 0;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary,rgba(210,153,34,.5));",
			"background:var(--dsw-alias-state-warn-tertiary,rgba(210,153,34,.08))}",
			".dss-risk-t{font-size:12.5px;font-weight:600;margin-bottom:2px}",
			".dss-risk-d{font-size:12px;line-height:1.5;opacity:.9}",
			".dss-toast{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:10000;max-width:min(78vw,420px);",
			"padding:14px 22px;border-radius:12px;text-align:center;pointer-events:none;",
			"background:var(--dsw-alias-bg-elevated,#222);color:var(--dsw-alias-label-primary,#fff);font-size:13.5px;line-height:1.5;",
			"box-shadow:0 12px 32px rgba(0,0,0,.4);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));",
			"animation:dss-toast-life 3.4s ease forwards}",
			"@keyframes dss-toast-life{0%{opacity:0;transform:translate(-50%,-50%) scale(.96)}8%{opacity:1;transform:translate(-50%,-50%) scale(1)}",
			"88%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(.98)}}",
			".dss-raw{margin-top:8px;font-size:11px}",
			".dss-raw>summary{cursor:pointer;color:var(--dsw-alias-state-warn-primary,#d29922);outline:none}",
			".dss-raw-hint{margin:4px 0;opacity:.8;font-size:11px;line-height:1.45}",
			".dss-raw-pre{max-height:190px;overflow:auto;white-space:pre-wrap;word-break:break-all;user-select:text;cursor:text;",
			"background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));border-radius:6px;padding:6px 8px;margin:0;",
			"font-family:ui-monospace,Consolas,'Cascadia Mono',monospace;font-size:10.5px;line-height:1.35}",
		].join("");

		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(CSS_ID)) return;
			const el = document.createElement("style");
			el.id = CSS_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		function kv(label, value, cls) {
			return jsxs("div", {
				className: "dss-kv",
				children: [
					jsx("span", { className: "dss-k", children: label }),
					jsx("span", { className: cls ? "dss-v " + cls : "dss-v", children: value === null || value === undefined || value === "" ? "—" : String(value) }),
				],
			});
		}

		function section(title, children) {
			return jsxs("div", { children: [jsx("div", { className: "dss-sec", children: title }), children] });
		}

		function riskText(tt, risk) {
			if (risk === "yes") return tt("riskYes");
			if (risk === "no") return tt("riskNo");
			return tt("riskUnknown");
		}

		function riskClass(risk) {
			if (risk === "yes") return "dss-bad";
			if (risk === "no") return "dss-ok";
			return "dss-warn";
		}

		function shortPath(p) {
			const parts = String(p || "").split(/[\\/]/).filter(Boolean);
			return parts.length > 1 ? parts[parts.length - 2] + "/" + parts[parts.length - 1] : String(p || "");
		}

		/** 自检报告（纯渲染，不再自己发请求）。 */
		function ReportView(props) {
			const tt = props.t;
			const r = props.report || {};
			const host = r.host || {};
			const sessions = r.sessions || [];
			const jobs = r.jobs || [];
			const workspaces = r.workspaces || [];
			const others = r.otherInstances || [];
			const errors = r.errors || [];
			const busy = sessions.filter(function (s) { return s.activity && s.activity.length > 0; });
			const nodes = [];
			const hostTitle = [host.home ? "DSH_HOME: " + host.home : null, host.webUrl ? "GUI: " + host.webUrl : null].filter(Boolean).join(" | ");
			nodes.push(jsx("div", {
				className: "dss-line dss-dense",
				title: hostTitle,
				children: [host.version || "?", "Node " + (host.node || "?"), "PID " + (host.pid || "?")].join("  ·  "),
			}));
			const tcount = sessions.reduce(function (n, s) { return n + (s.terminals || 0); }, 0);
			const counts = [tt("secSessions") + " " + sessions.length];
			if (busy.length) counts.push(tt("stopActivity") + busy.length);
			if (jobs.length) counts.push(tt("secJobs") + " " + jobs.length);
			if (tcount) counts.push(tt("kTerminals") + " " + tcount);
			counts.push(tt("secInstances") + " " + others.length);
			nodes.push(jsx("div", { className: "dss-line dss-dense", children: counts.join("  ·  ") }));
			for (const s of busy) {
				nodes.push(jsx("div", {
					className: "dss-line dss-dense dss-warn",
					title: s.id || "",
					children: tt("stopActivity") + (s.id || "?") + "  ·  " + (s.activity || []).join(", "),
				}));
			}
			// 临时区（v7）：报告里排在最前（"报告第一、执行最后"）
			const temp = r.tempRoots;
			if (temp) {
				const bits = [tt("kIdle") + " " + temp.idle];
				if (temp.locked) bits.push(tt("kLocked") + " " + temp.locked);
				if (temp.fresh) bits.push(tt("kFresh") + " " + temp.fresh);
				nodes.push(jsx("div", {
					className: "dss-line dss-dense " + (temp.deletable > 0 ? "dss-warn" : "dss-ok"),
					title: (temp.parents || []).join(" | ") + (temp.lastInstance ? "  ·  " + tt("kLast") : "") + (temp.othersScanned ? "" : "  ·  (实例扫描不可用，只清无风险的)"),
					children: tt("secTemp") + " " + temp.scanned + " 个  ·  " + bits.join("  ·  "),
				}));
			}
			for (const w of workspaces) {
				const yn = function (v) { return v === null || v === undefined ? "?" : (v ? "有" : "无"); };
				const cls = w.error ? "dss-bad" : (w.lowLabel || w.deny ? "dss-warn" : "dss-ok");
				nodes.push(jsx("div", {
					className: "dss-line dss-dense " + cls,
					title: w.root + (w.error ? "  (" + w.error + ")" : ""),
					children: shortPath(w.root) + "  ·  " + tt("kAce") + yn(w.ace) + " " + tt("kDeny") + yn(w.deny) + " " + tt("kLow") + yn(w.lowLabel),
				}));
			}
			for (const o of others) {
				const mark = o.sharesWorkspace === true ? "  ·  " + tt("shareYes") : o.sharesWorkspace === null ? "  ·  " + tt("shareUnknown") : "";
				const cls = o.sharesWorkspace === true ? "dss-bad" : o.sharesWorkspace === null ? "dss-warn" : riskClass(o.risk);
				nodes.push(jsx("div", {
					className: "dss-line dss-dense " + cls,
					title: (o.workspaces || []).join(" | "),
					children: "PID " + o.pid + "  ·  " + (o.version || "?") + "  ·  " + riskText(tt, o.risk) + mark,
				}));
			}
			if (errors.length > 0) {
				nodes.push(jsx("div", {
					className: "dss-line dss-dense dss-warn",
					title: errors.join(" | "),
					children: tt("secErrors") + " " + errors.length + "  ·  " + String(errors[0]).slice(0, 60),
				}));
			}
			return jsx(Fragment, { children: nodes });
		}

		/** 风险清单：如实说明"是什么 + 会怎样"。 */
		function RiskList(props) {
			const tt = props.t;
			const risks = props.risks || [];
			if (risks.length === 0) return null;
			return jsxs("div", {
				children: [
					jsx("div", { className: "dss-sec", children: tt("riskTitle") }),
					jsx(Fragment, { children: risks.map(function (r) {
						return jsxs("div", {
							className: "dss-risk",
							children: [
								jsx("div", { className: "dss-risk-t dss-warn", children: tt(r.title) + (r.detail ? "：" + r.detail : "") }),
								jsx("div", { className: "dss-risk-d", children: tt(r.desc) }),
							],
						}, r.kind);
					}) }),
				],
			});
		}

		/**
		 * 本界面认识的自检报告最低版本（宿主半 collect() 里的 PROBE_VERSION）。
		 * 用途是兜底：报告版本对不上 / 结构看不懂 / 自带错误项 / 一个根都没有 —— 一律按"有风险"处理，
		 * 弹窗把原始报告摆给作者（可复制去问），**绝不静默当作"没问题"**。
		 */
		const PROBE_MIN = 9;   // v9：宿主报告里步骤可带 na（不适用）—— 与宿主 PROBE_VERSION 同步

		/** 风险判定。注意：不假设对方也装了本插件——无法确认共享即按风险提示。 */
		function computeRisks(r, action, eraseFlag) {
			const risks0 = [];
			const flag = function (kind, title, desc, detail) {
				risks0.push({ kind: kind, title: title, desc: desc, detail: detail || "" });
			};
			// ① 报告形状：认不出来的任何一点都按风险处理
			if (!r || typeof r !== "object") {
				flag("shape", "riskShapeT", "riskShapeD", "响应不是对象");
				return { risks: risks0, noop: false };
			}
			const workspaces = Array.isArray(r.workspaces) ? r.workspaces : null;
			const sessionsRaw = Array.isArray(r.sessions) ? r.sessions : null;
			const othersRaw = Array.isArray(r.otherInstances) ? r.otherInstances : null;
			const errs = Array.isArray(r.errors) ? r.errors : null;
			const otherInstances = othersRaw || [];
			const shapeBad = [];
			if (!workspaces) shapeBad.push("workspaces");
			if (!sessionsRaw) shapeBad.push("sessions");
			if (!othersRaw) shapeBad.push("otherInstances");
			if (!errs) shapeBad.push("errors");
			if (shapeBad.length > 0) flag("shape", "riskShapeT", "riskShapeD", "缺字段: " + shapeBad.join(", "));
			if (typeof r.probeVersion !== "number") flag("stale", "riskStaleT", "riskStaleD", "报告无版本号");
			else if (r.probeVersion < PROBE_MIN) flag("stale", "riskStaleT", "riskStaleD", "版本 " + r.probeVersion + " < " + PROBE_MIN);
			if (errs && errs.length > 0) flag("diag", "riskDiagT", "riskDiagD", errs.length + " 条 · " + String(errs[0]).slice(0, 70));
			if (workspaces && workspaces.length === 0) flag("noroot", "riskNoRootT", "riskNoRootD", "workspaces = []");
			if (!workspaces || !sessionsRaw || !othersRaw || !errs) return { risks: risks0, noop: false };

			const unknownAcl = workspaces.filter(function (w) { return Boolean(w.error); });
			// 「有痕迹」= 会伤到用户的两项（删除拒绝 / 低标签）。能力 ACE 是平台的跨会话复用缓存（v7 起不再擦），
			// 只有它时按「无需清理」处理 —— 口径见宿主 eraseRoots 的注释。
			const hasHarm = workspaces.some(function (w) { return !w.error && (w.lowLabel || w.deny); });
			// 空操作（不打扰）的前提：报告可解读、有根、全部根都读得到、且没有要擦的两项（删除拒绝 / 低标签）
			const understood = risks0.length === 0 && workspaces.length > 0;
			// 临时区里还有"能清掉的"就不算空操作：那一下点击确实会做清理（分层规则见宿主 sweepTempRoots）
			const tempDeletable = r.tempRoots && typeof r.tempRoots.deletable === "number" ? r.tempRoots.deletable : 0;
			const noop = understood && unknownAcl.length === 0 && !hasHarm && tempDeletable === 0;
			// 只有"确实会擦除"时，擦除的副作用（影响别的实例）才算本次操作的风险
			const willErase = !noop && (action !== "close" || eraseFlag !== false);

			if (unknownAcl.length > 0) flag("acl", "riskAclT", "riskAclD", "");
			if (willErase && r.instancesScanned === false) {
				flag("scan", "riskScanT", "riskScanD", otherInstances.length ? otherInstances.length + " 个实例仍可见" : "");
			}
			const sharing = otherInstances.filter(function (o) { return o.sharesWorkspace === true; });
			const unknown = otherInstances.filter(function (o) { return o.sharesWorkspace === null || o.sharesWorkspace === undefined; });
			if (willErase && sharing.length > 0) {
				flag("sharing", "riskSharingT", "riskSharingD", sharing.map(function (o) { return "PID " + o.pid + " (" + (o.version || "?") + ")"; }).join(", "));
			}
			if (willErase && unknown.length > 0) {
				flag("unknown", "riskUnknownT", "riskUnknownD", unknown.map(function (o) { return o.pid ? "PID " + o.pid : (o.source || "未知实例"); }).join(", "));
			}
			const live = sessionsRaw.filter(function (s) { return s && s.activity && s.activity.length > 0; });
			if (live.length > 0) {
				flag("work", "riskWorkT", "riskWorkD", live.map(function (s) { return (s.activity || []).join("+"); }).join(", "));
			}
			return { risks: risks0, noop: noop };
		}

		let createPortalFn = null;
		try {
			const reactDom = require("react-dom");
			if (reactDom && typeof reactDom.createPortal === "function") createPortalFn = reactDom.createPortal;
		} catch (error) {
			createPortalFn = null;
		}

		/** 气泡：屏幕正中，3 秒后淡出；不拦截点击。优先 portal 到 body，避免祖先 transform 破坏 fixed 居中。 */
		function Toast(props) {
			const node = jsx("div", { className: "dss-toast", children: props.text });
			try {
				if (createPortalFn && typeof document !== "undefined" && document.body) return createPortalFn(node, document.body);
			} catch (error) {
				/* 退回内联渲染 */
			}
			return node;
		}

		/**
		 * 原始报告兜底：任何"当前没枚举到的情况"都要留下可复制的一手材料，
		 * 让作者可以拿去问 DSH「这是什么意思、有没有风险」。点击即全选，便于 Ctrl+C。
		 */
		function RawReport(props) {
			const tt = props.t;
			const text = String(props.text || "");
			if (!text) return null;
			const selectAll = function (e) {
				try {
					const range = document.createRange();
					range.selectNodeContents(e.currentTarget);
					const sel = window.getSelection();
					sel.removeAllRanges();
					sel.addRange(range);
				} catch (error) {
					/* 手动拖选也一样 */
				}
			};
			return jsxs("details", {
				className: "dss-raw",
				children: [
					jsx("summary", { children: tt("rawTitle") }),
					jsx("div", { className: "dss-raw-hint", children: tt("rawHint") }),
					jsx("pre", { className: "dss-raw-pre", onClick: selectAll, children: text }),
				],
			});
		}

		/** 把报告 / 响应 / 错误拼成一段可复制的纯文本（超长截断，避免撑爆弹窗）。 */
		function rawTextOf(report, raw, error) {
			const parts = [];
			if (report) {
				try { parts.push(JSON.stringify(report, null, 1)); } catch (e) { parts.push("(报告无法序列化: " + String((e && e.message) || e) + ")"); }
			}
			if (raw) parts.push("--- 原始响应文本 ---\n" + String(raw));
			if (error) parts.push("--- 错误 ---\n" + String(error));
			const text = parts.join("\n\n");
			return text.length > 8000 ? text.slice(0, 8000) + "\n…（已截断，共 " + text.length + " 字符）" : text;
		}

		/** 弹窗：只在"有风险"或"失败"时出现；内无勾选，再点一次按钮即接受风险。 */
		function Dialog(props) {
			const tt = props.t;
			const onClose = props.onClose;
			const action = props.action;
			React.useEffect(function () {
				const onKey = function (e) { if (e.key === "Escape") onClose(); };
				window.addEventListener("keydown", onKey);
				return function () { window.removeEventListener("keydown", onKey); };
			}, [onClose]);
			const risks = props.risks || [];
			const steps = props.steps || [];
			return jsx("div", {
				className: "dss-overlay",
				onClick: onClose,
				children: jsxs("div", {
					className: "dss-card",
					onClick: function (e) { e.stopPropagation(); },
					children: [
						jsx("button", {
							type: "button", className: "dss-x", "aria-label": tt("closeX"),
							title: tt("closeX") + "  (Esc)", onClick: onClose, children: "×",
						}),
						jsx("div", { className: "dss-title", children: action === "sweep" ? tt("sweepTitle") : tt("closeTitle") }),
						jsx("div", { className: "dss-stage", children: tt("stage") }),
						props.report
							? jsx(ReportView, { t: tt, report: props.report })
							: jsx("div", { className: "dss-line dss-bad", children: tt("probeFailed") + (props.error ? ": " + props.error : "") }),
						jsx(RiskList, { t: tt, risks: risks }),
						risks.length > 0 ? jsx("div", { className: "dss-note dss-warn", children: tt("riskAccept") }) : null,
						action === "close" && props.canErase === false
							? jsx("div", { className: "dss-note", children: tt("hostNoSweep") })
							: null,
						action === "close" && props.canErase !== false
							? jsxs("label", {
									className: "dss-note",
									style: { display: "flex", gap: 6, alignItems: "center" },
									children: [
										jsx("input", {
											type: "checkbox",
											checked: props.erase !== false,
											onChange: function (e) { props.onToggleErase(e.target.checked); },
										}),
										jsx("span", { children: tt("closeEraseToggle") }),
									],
								})
							: null,
						steps.length > 0
							? jsx(Fragment, { children: steps.map(function (s, i) {
									const mark = s.na ? "na" : s.ok ? "ok" : "fail";
									return kv(s.name, mark + (s.detail ? "  " + s.detail : ""), s.ok || s.na ? "dss-ok" : "dss-bad");
								}) })
							: null,
						props.error && props.report ? jsx("div", { className: "dss-note dss-bad", children: tt("failed") + ": " + props.error }) : null,
						jsx(RawReport, { t: tt, text: props.raw }),
						jsx("div", {
							className: "dss-act",
							children: jsx("button", {
								type: "button",
								className: "dss-btn dss-danger",
								disabled: Boolean(props.executing),
								onClick: function () { props.onConfirm(); },
								children: jsx("span", { className: "dss-label", children: props.executing ? tt("executing") : action === "close" ? tt("runClose") : tt("runSweep") }),
							}),
						}),
					],
				}),
			});
		}

		function ActionButton(props) {
			return jsxs("button", {
				type: "button",
				className: props.danger ? "dss-btn dss-danger" : "dss-btn",
				title: props.title || props.label,
				"aria-label": props.label,
				disabled: Boolean(props.disabled),
				onClick: props.onClick,
				children: [props.icon, jsx("span", { className: "dss-label", children: props.label })],
			});
		}

		/**
		 * 侧栏脚部：两个按钮 + 风险弹窗 + 气泡。
		 * 点击 → 静默自检 →（无风险）直接执行并弹气泡 /（有风险）弹窗，再点一次即接受。
		 */
		function SandboxSweepActions(props) {
			const wide = props.wide !== false;
			const st = React.useState({
				dialog: null, report: null, risks: [], steps: [], busy: false, pending: null,
				executing: false, error: null, erase: true, toast: null, raw: "", caps: null,
			});
			const cur = st[0];
			const set = st[1];
			const patch = function (p) { set(function (prev) { return Object.assign({}, prev, p); }); };
			const tt = function (key) {
				if (typeof props.t === "function") return props.t(key);
				return zh[key] !== undefined ? zh[key] : key;
			};

			React.useEffect(function () {
				if (!cur.toast) return undefined;
				const timer = setTimeout(function () { patch({ toast: null }); }, 3400);
				return function () { clearTimeout(timer); };
			}, [cur.toast]);

			// v8：挂载时问一句宿主能力 —— 宿主 < 0.1.7-alpha.1 不写三件套，就不显示「清理」。
			// 问不到（老宿主没这条路由 / 网络错误）→ 保持旧行为：两个按钮都显示。
			React.useEffect(function () {
				let alive = true;
				let req;
				try { req = post(CAP_URL, {}); } catch (error) { req = Promise.resolve({ ok: false, error: String((error && error.message) || error) }); }
				req.then(function (out) {
					if (!alive) return;
					const body = out && out.ok && out.body && typeof out.body === "object" ? out.body : null;
					patch({ caps: body || { sweep: true, close: true, fallback: true } });
				});
				return function () { alive = false; };
			}, []);

			function post(url, payload) {
				return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}) })
					.then(function (res) { return res.text().then(function (text) { return { ok: res.ok, status: res.status, text: text }; }); })
					.then(function (out) {
						let body = null;
						let parseError = null;
						try { body = out.text ? JSON.parse(out.text) : null; } catch (error) { parseError = String((error && error.message) || error); }
						const raw = String(out.text || "").slice(0, 4000);
						if (out.ok && parseError === null) return { ok: true, body: body, raw: raw };
						return {
							ok: false,
							raw: raw,
							error: "HTTP " + out.status + (parseError ? " · " + parseError : "") + (out.text ? " · " + out.text.slice(0, 160) : ""),
						};
					})
					.catch(function (error) { return { ok: false, raw: "", error: String((error && error.message) || error) }; });
			}

			function start(action) {
				if (cur.busy || cur.executing) return;
				patch({ busy: true, pending: action, toast: null, error: null, steps: [], result: null });
				post(PROBE_URL, {}).then(function (probe) {
					if (!probe.ok) {
						// 自检请求本身失败：一律弹窗，并把原始响应/错误贴出来
						patch({
							busy: false, pending: null, dialog: action, report: null, risks: [], error: probe.error,
							raw: rawTextOf(null, probe.raw, probe.error),
						});
						return;
					}
					const report = probe.body || {};
					const raw = rawTextOf(report, probe.raw, null);
					let verdict;
					try {
						verdict = computeRisks(report, action, cur.erase);
					} catch (error) {
						// 兜底：判定逻辑自己出错，也算"出现了没枚举到的情况"→ 弹窗 + 原始报告
						verdict = {
							noop: false,
							risks: [{
								kind: "calc",
								title: "riskCalcT",
								desc: "riskCalcD",
								detail: String((error && error.message) || error),
							}],
						};
					}
					patch({ busy: false, pending: null, report: report, risks: verdict.risks, error: null, raw: raw });
					// 清理是空操作 → 不打扰：不弹窗、不切只读、不终止工作，只弹一个气泡
					if (action === "sweep" && verdict.noop) {
						// 没有痕迹 = 本次不做任何改动（不切只读、不终止工作），发现的风险也就不必确认
						patch({ toast: tt("toastNoop") + (verdict.risks.length > 0 ? "（本次未做任何改动）" : "") });
						return;
					}
					if (verdict.risks.length === 0) execute(action, report, cur.erase, false);
					else patch({ dialog: action });
				});
			}

			function finish(ok, steps, error, action, fromDialog) {
				patch({
					executing: false,
					steps: steps,
					error: error,
					raw: error ? rawTextOf(cur.report, null, error) : cur.raw,
					// 成功且弹窗原本就是因风险打开的 → 保留弹窗展示步骤；成功且无弹窗 → 只弹气泡；
					// 失败 → 一律打开弹窗贴错误报告
					toast: ok && !fromDialog ? (action === "close" ? tt("toastClose") : tt("toastSweepOk")) : null,
					dialog: ok ? (fromDialog ? action : null) : action,
				});
			}

			function execute(action, report, erase, fromDialog) {
				patch({ executing: true, steps: [], error: null });
				const steps = [];
				const live = ((report && report.sessions) || []).some(function (s) { return s.activity && s.activity.length > 0; });
				const begin = live
					? post(STOP_URL, {}).then(function (out) {
							steps.push({ name: tt("riskWorkT"), ok: out.ok, detail: out.ok ? "已停 " + ((out.body && out.body.stopped) || 0) + "/" + ((out.body && out.body.total) || 0) : out.error });
							return out;
						})
					: Promise.resolve({ ok: true, body: null });
				begin.then(function (out) {
					if (!out.ok) { finish(false, steps, out.error, action, fromDialog); return; }
					if (action === "close") {
						post(CLOSE_URL, { erase: erase !== false }).then(function (res) {
							if (!res.ok) { finish(false, steps, res.error, action, fromDialog); return; }
							for (const s of (res.body && res.body.steps) || []) steps.push({ name: s.name, ok: s.ok, na: s.na, detail: s.detail });
							finish(true, steps, null, action, fromDialog);
						});
						return;
					}
					post(REVOKE_URL, {}).then(function (rev) {
						const rv = rev.ok ? rev.body || {} : null;
						steps.push({
							name: "权限回收（会话切只读）",
							ok: rev.ok && (rv.failed || 0) === 0,
							detail: rev.ok ? "已切 " + (rv.changed || 0) + " · 本就只读 " + (rv.alreadyReadOnly || 0) + " · 失败 " + (rv.failed || 0) : rev.error,
						});
						if (!rev.ok) { finish(false, steps, rev.error, action, fromDialog); return; }
						const roots = ((report && report.workspaces) || []).map(function (w) { return w.root; });
						post(ERASE_URL, { dryRun: false, roots: roots }).then(function (era) {
							if (!era.ok) { finish(false, steps, era.error, action, fromDialog); return; }
							for (const res of (era.body && era.body.results) || []) {
								steps.push({
									name: shortPath(res.root),
									ok: res.verified === true,
									detail: (res.verified ? tt("verified") : tt("notVerified")) + (res.residue && res.residue.length ? " · " + res.residue.join(", ") : "") + (res.keptAce ? "  ·  " + tt("kAceKept") : "") + (era.body.ledger ? "  ·  " + tt("ledger") : ""),
								});
							}
							finish(true, steps, null, action, fromDialog);
						});
					});
				});
			}

			return jsxs(Fragment, {
				children: [
					jsxs("div", {
						className: wide ? "dss-wrap dss-wide" : "dss-wrap dss-rail",
						children: [
							// v8：只有"会写三件套的宿主"才显示「清理」（< 0.1.7-alpha.1 只保留优雅退出）
							cur.caps && cur.caps.sweep === true
								? jsx(ActionButton, {
										label: cur.busy && cur.pending === "sweep" ? tt("probing") : tt("sweep"),
										icon: wide ? null : jsx(BroomIcon, {}),
										disabled: cur.busy || cur.executing,
										onClick: function () { start("sweep"); },
									})
								: null,
							jsx(ActionButton, {
								label: cur.busy && cur.pending === "close" ? tt("probing") : tt("close"),
								title: cur.caps && cur.caps.sweep === false ? tt("hostNoSweep") : undefined,
								danger: true,
								icon: jsx(PowerIcon, {}),
								disabled: cur.busy || cur.executing,
								onClick: function () { start("close"); },
							}),
						],
					}),
					cur.dialog
						? jsx(Dialog, {
								t: tt,
								action: cur.dialog,
								report: cur.report,
								risks: cur.risks,
								steps: cur.steps,
								executing: cur.executing,
								error: cur.error,
								erase: cur.erase,
								canErase: !(cur.caps && cur.caps.sweep === false),
								raw: cur.raw,
								onToggleErase: function (v) { patch({ erase: v }); },
								onConfirm: function () { execute(cur.dialog, cur.report, cur.erase, true); },
								onClose: function () { patch({ dialog: null }); },
							})
						: null,
					cur.toast ? jsx(Toast, { text: cur.toast }) : null,
				],
			});
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ensureStyle();
			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "sandbox-sweep: dictionaries");
			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register(
					{ name: "sidebar.footer.action", id: "sandbox-sweep", locale: NS, order: 0 },
					SandboxSweepActions,
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.NS = NS;
		exports.SandboxSweepActions = SandboxSweepActions;
		return module.exports;
	},
});
