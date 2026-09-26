import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const keys = (block) => new Set([...block.matchAll(/^\t{3}([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
const zhStart = src.indexOf("const zh = {");
const enStart = src.indexOf("const en = {");
const enEnd = src.indexOf("\n\t\t};", enStart);
const zh = keys(src.slice(zhStart, enStart));
const en = keys(src.slice(enStart, enEnd));

const used = new Set([...src.matchAll(/\btt\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]));
let bad = 0;
for (const k of used) {
	const inZh = zh.has(k);
	const inEn = en.has(k);
	if (!inZh || !inEn) { bad++; console.log("MISSING " + k + " zh=" + inZh + " en=" + inEn); }
}
const unusedZh = [...zh].filter((k) => !used.has(k));
console.log("用过 " + used.size + " 个键，zh=" + zh.size + " en=" + en.size);
console.log("词典里没被引用到的键（可能是动态拼接，人工确认）: " + (unusedZh.length ? unusedZh.join(",") : "（无）"));
console.log(bad === 0 ? "LABELS OK" : bad + " MISSING");
process.exitCode = bad === 0 ? 0 : 1;
