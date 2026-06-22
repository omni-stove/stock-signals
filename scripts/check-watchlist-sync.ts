// scripts/check-watchlist-sync.ts
// 銘柄一覧の単一ソース (config/watchlist.yaml) と、それを写経している箇所の同期を検証する。
//
// 銘柄コードは GitHub Actions の workflow_dispatch.inputs.ticker (type: choice) の
// options が静的記述しか許さない都合上、yaml だけを真のソースにできず複数箇所に写経している:
//   ① config/watchlist.yaml の tickers[].code        ← 真のソース
//   ② worker/src/lib/timeseries.ts の WATCHLIST       (Worker は読み取り専用FSで yaml を持てない)
//   ③ .github/workflows/context-builder.yml の options (workflow_dispatch は動的生成不可)
//   ④ .github/workflows/signal-judge.yml   の options (同上)
//
// このスクリプトは ②③④ が ① と完全一致 (順序込み) するかを検証し、ズレていれば exit 1。
// verify から呼ばれるので、銘柄を足して yaml だけ直すと verify が落ちて写経漏れに気づける。
//
// 実行: node scripts/check-watchlist-sync.ts

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

// ① 真のソース: watchlist.yaml の tickers[].code (+ name)
const yamlText = await read("../config/watchlist.yaml");
const parsed = parseYaml(yamlText) as {
	tickers?: { code?: string; name?: string }[];
};
const source = (parsed.tickers ?? []).map((t) => String(t.code));
// code → name (Slack 銘柄ピッカーの表示名)。timeseries.ts の WATCHLIST_NAMES と照合する。
const sourceNames = Object.fromEntries(
	(parsed.tickers ?? []).map((t) => [String(t.code), String(t.name ?? "")]),
);
if (source.length === 0) {
	console.error("config/watchlist.yaml の tickers が空です");
	process.exit(1);
}

const errors: string[] = [];

// 順序込みで配列一致を検証する。
function expect(label: string, actual: string[]): void {
	const a = JSON.stringify(actual);
	const s = JSON.stringify(source);
	if (a !== s) {
		errors.push(
			`${label} が watchlist.yaml と不一致:\n  yaml: ${s}\n  実物: ${a}`,
		);
	}
}

// ② worker/src/lib/timeseries.ts の WATCHLIST 配列リテラル + WATCHLIST_NAMES マップ
{
	const text = await read("../worker/src/lib/timeseries.ts");
	const m = text.match(/export const WATCHLIST: string\[\] = \[([^\]]*)\];/);
	if (!m) {
		errors.push("timeseries.ts の WATCHLIST 定義を抽出できませんでした");
	} else {
		const codes = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
		expect("timeseries.ts の WATCHLIST", codes);
	}

	// WATCHLIST_NAMES: Record<string, string> = { "CODE": "名前", ... } を抽出し、
	// yaml の code→name と完全一致 (キー集合 + 各値) するか検証する。
	const nm = text.match(
		/export const WATCHLIST_NAMES: Record<string, string> = \{([\s\S]*?)\};/,
	);
	if (!nm) {
		errors.push("timeseries.ts の WATCHLIST_NAMES 定義を抽出できませんでした");
	} else {
		const pairs = [...nm[1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)];
		const names = Object.fromEntries(pairs.map((p) => [p[1], p[2]]));
		const actual = JSON.stringify(names);
		const expected = JSON.stringify(sourceNames);
		if (actual !== expected) {
			errors.push(
				`timeseries.ts の WATCHLIST_NAMES が watchlist.yaml の name と不一致:\n  yaml: ${expected}\n  実物: ${actual}`,
			);
		}
	}
}

// ③④ ワークフローの workflow_dispatch.inputs.ticker.options
// options: の直後に続く `- "CODE"` 行を順に拾う (コメントは無視)。
async function workflowOptions(rel: string): Promise<string[]> {
	const text = await read(rel);
	const lines = text.split("\n");
	const start = lines.findIndex((l) => /^\s*options:\s*$/.test(l));
	if (start === -1) return [];
	const codes: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const m = line.match(/^\s*-\s*"([^"]+)"/);
		if (m) {
			codes.push(m[1]);
			continue;
		}
		// options ブロックは同等以上のインデントの list item で構成される。
		// list item でない非空行に当たったらブロック終了。
		if (line.trim() !== "" && !/^\s*#/.test(line)) break;
	}
	return codes;
}

expect(
	"context-builder.yml の options",
	await workflowOptions("../.github/workflows/context-builder.yml"),
);
expect(
	"signal-judge.yml の options",
	await workflowOptions("../.github/workflows/signal-judge.yml"),
);

if (errors.length > 0) {
	console.error("銘柄一覧の同期チェックに失敗しました。\n");
	for (const e of errors) console.error(`- ${e}\n`);
	console.error(
		"config/watchlist.yaml を真のソースとして、上記の写経先を一致させてください。",
	);
	process.exit(1);
}

console.log(`watchlist 同期 OK (${source.length} 銘柄: ${source.join(", ")})`);
