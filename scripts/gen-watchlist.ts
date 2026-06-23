// scripts/gen-watchlist.ts
//
// 銘柄一覧の単一ソース (config/watchlist.yaml) から、それを写経している箇所を自動生成する。
// 写経先は Worker (読み取り専用FSで yaml を読めない) と GitHub Actions の choice options
// (workflow_dispatch は動的生成できない) という制約上どうしても必要で、従来は手で揃えて
// check-watchlist-sync.ts で検証していた。このスクリプトは「揃える」側を肩代わりする。
//
// 生成先:
//   ① worker/src/lib/watchlist.gen.ts            … WATCHLIST 配列 + WATCHLIST_NAMES マップ
//      (timeseries.ts がここから re-export するので Worker 各所の import は不変)
//   ② .github/workflows/context-builder.yml      … workflow_dispatch.inputs.ticker.options
//   ③ .github/workflows/signal-judge.yml         … 同上
//      (②③は `# GEN:watchlist:start` 〜 `# GEN:watchlist:end` で囲った領域だけ差し替える)
//
// 実行:   node scripts/gen-watchlist.ts            (= npm run gen:watchlist)
// チェック: node scripts/gen-watchlist.ts --check    生成結果と現状が一致するか検証 (CI 用、書き込まない)

import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const checkMode = process.argv.includes("--check");

const url = (rel: string) => new URL(rel, import.meta.url);
const read = (rel: string) => readFile(url(rel), "utf8");

// ── 単一ソースを読む ──
const yamlText = await read("../config/watchlist.yaml");
const parsed = parseYaml(yamlText) as {
	tickers?: { code?: string; name?: string }[];
};
const tickers = (parsed.tickers ?? []).map((t) => ({
	code: String(t.code ?? ""),
	name: String(t.name ?? ""),
}));
if (tickers.length === 0) {
	console.error("config/watchlist.yaml の tickers が空です");
	process.exit(1);
}
for (const t of tickers) {
	if (!t.code || !t.name) {
		console.error(
			`code/name の欠けた tickers エントリがあります: ${JSON.stringify(t)}`,
		);
		process.exit(1);
	}
}

// ── ① watchlist.gen.ts の本文を組み立てる ──
function renderGenTs(): string {
	const arr = tickers.map((t) => `"${t.code}"`).join(", ");
	const names = tickers.map((t) => `\t"${t.code}": "${t.name}",`).join("\n");
	return `// 自動生成ファイル — 直接編集しないこと。
//
// 出所は config/watchlist.yaml。\`node scripts/gen-watchlist.ts\` (= npm run gen:watchlist)
// が yaml の tickers[] から WATCHLIST / WATCHLIST_NAMES を生成してここに書き出す。
// 銘柄を増減するときは yaml を直して gen を走らせる (このファイルは手で触らない)。
//
// Worker は読み取り専用FSで yaml を読めないため、ビルド時に値を焼き込むのが目的。
// timeseries.ts がこのファイルから re-export し、Worker 内の各モジュールは
// 従来どおり timeseries から WATCHLIST / WATCHLIST_NAMES を import する。

// ローカル config/watchlist.yaml の tickers[].code と対応 (順序込み)。
export const WATCHLIST: string[] = [${arr}];

// コード → 表示名 (watchlist.yaml の name と対応)。
export const WATCHLIST_NAMES: Record<string, string> = {
${names}
};
`;
}

// ── ②③ workflow yml の options 領域を差し替える ──
// `# GEN:watchlist:start` 〜 `# GEN:watchlist:end` の間 (両マーカーの行は残す) を、
// マーカー行のインデントに合わせた options 行で置き換える。
function renderYml(original: string, file: string): string {
	const startRe = /^([ \t]*)# GEN:watchlist:start[ \t]*$/m;
	const m = original.match(startRe);
	if (!m) {
		console.error(`${file}: マーカー '# GEN:watchlist:start' が見つかりません`);
		process.exit(1);
	}
	const indent = m[1];
	const lines = tickers
		.map((t) => `${indent}- "${t.code}"  # ${t.name}`)
		.join("\n");
	const blockRe =
		/(^[ \t]*# GEN:watchlist:start[ \t]*$\n)[\s\S]*?(^[ \t]*# GEN:watchlist:end[ \t]*$)/m;
	if (!blockRe.test(original)) {
		console.error(
			`${file}: マーカー end '# GEN:watchlist:end' が見つかりません`,
		);
		process.exit(1);
	}
	return original.replace(blockRe, `$1${lines}\n$2`);
}

// ── 出力ターゲット ──
type Target = { rel: string; next: string };
const targets: Target[] = [];

targets.push({
	rel: "../worker/src/lib/watchlist.gen.ts",
	next: renderGenTs(),
});

for (const rel of [
	"../.github/workflows/context-builder.yml",
	"../.github/workflows/signal-judge.yml",
]) {
	const cur = await read(rel);
	targets.push({ rel, next: renderYml(cur, rel) });
}

// ── 書き込み or 検証 ──
let drift = false;
for (const t of targets) {
	const cur = await read(t.rel).catch(() => "");
	if (cur === t.next) continue;
	if (checkMode) {
		drift = true;
		console.error(
			`drift: ${t.rel} が config/watchlist.yaml と不一致。'npm run gen:watchlist' を実行してください。`,
		);
	} else {
		await writeFile(url(t.rel), t.next);
		console.log(`updated ${t.rel}`);
	}
}

if (checkMode) {
	if (drift) process.exit(1);
	console.log("watchlist 生成物は config/watchlist.yaml と一致しています。");
} else {
	console.log(`gen:watchlist done (${tickers.length} tickers)`);
}
