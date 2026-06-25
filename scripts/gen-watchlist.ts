// scripts/gen-watchlist.ts
//
// 銘柄一覧の唯一の真のソース (worker/src/lib/watchlist.ts の TICKERS) から、
// それを写経している箇所を自動生成する。
//
// 写経先は GitHub Actions の choice options だけ。workflow_dispatch.inputs は実行時に
// 動的生成できず yml に列挙するしかないため、ここで揃える。Worker 側は watchlist.ts を
// 直接 import するので生成は不要。
//
// 生成先:
//   ① .github/workflows/context-builder.yml      … workflow_dispatch.inputs.ticker.options
//   ② .github/workflows/signal-judge.yml         … 同上
//      (`# GEN:watchlist:start` 〜 `# GEN:watchlist:end` で囲った領域だけ差し替える)
//
// 実行:   node scripts/gen-watchlist.ts            (= npm run gen:watchlist)
// チェック: node scripts/gen-watchlist.ts --check    生成結果と現状が一致するか検証 (CI 用、書き込まない)

import { readFile, writeFile } from "node:fs/promises";
import { TICKERS } from "../worker/src/lib/watchlist.ts";

const url = (rel: string) => new URL(rel, import.meta.url);
const read = (rel: string) => readFile(url(rel), "utf8");

// ── workflow yml の options 領域を差し替える ──
// `# GEN:watchlist:start` 〜 `# GEN:watchlist:end` の間 (両マーカーの行は残す) を、
// マーカー行のインデントに合わせた options 行で置き換える。
function renderYml(
	tickers: { code: string; name: string }[],
	original: string,
	file: string,
): string {
	const startRe = /^([ \t]*)# GEN:watchlist:start[ \t]*$/m;
	const m = original.match(startRe);
	if (!m) {
		throw new Error(
			`${file}: マーカー '# GEN:watchlist:start' が見つかりません`,
		);
	}
	const indent = m[1];
	const lines = tickers
		.map((t) => `${indent}- "${t.code}"  # ${t.name}`)
		.join("\n");
	const blockRe =
		/(^[ \t]*# GEN:watchlist:start[ \t]*$\n)[\s\S]*?(^[ \t]*# GEN:watchlist:end[ \t]*$)/m;
	if (!blockRe.test(original)) {
		throw new Error(
			`${file}: マーカー end '# GEN:watchlist:end' が見つかりません`,
		);
	}
	return original.replace(blockRe, `$1${lines}\n$2`);
}

// ── 出力ターゲット ──
type Target = { rel: string; next: string };

async function main(): Promise<void> {
	const checkMode = process.argv.includes("--check");

	const targets: Target[] = [];
	for (const rel of [
		"../.github/workflows/context-builder.yml",
		"../.github/workflows/signal-judge.yml",
	]) {
		const cur = await read(rel);
		targets.push({ rel, next: renderYml(TICKERS, cur, rel) });
	}

	// ── 書き込み or 検証 ──
	let drift = false;
	for (const t of targets) {
		const cur = await read(t.rel).catch(() => "");
		if (cur === t.next) continue;
		if (checkMode) {
			drift = true;
			console.error(
				`drift: ${t.rel} が watchlist.ts と不一致。'npm run gen:watchlist' を実行してください。`,
			);
		} else {
			await writeFile(url(t.rel), t.next);
			console.log(`updated ${t.rel}`);
		}
	}

	if (checkMode) {
		if (drift) process.exit(1);
		console.log(
			"watchlist 生成物は worker/src/lib/watchlist.ts と一致しています。",
		);
	} else {
		console.log(`gen:watchlist done (${TICKERS.length} tickers)`);
	}
}

if (!import.meta.vitest) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	});
}

// in-source tests (vitest.config.ts 参照)
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	const SAMPLE = [
		{ code: "7203", name: "トヨタ" },
		{ code: "6758", name: "ソニー" },
	];

	describe("renderYml", () => {
		const yml = `jobs:\n  x:\n    options:\n      # GEN:watchlist:start\n      - "OLD"\n      # GEN:watchlist:end\n`;

		it("マーカー間だけをインデント維持で差し替える", () => {
			const out = renderYml(SAMPLE, yml, "f.yml");
			expect(out).toContain('      - "7203"  # トヨタ');
			expect(out).toContain('      - "6758"  # ソニー');
			expect(out).not.toContain("OLD");
			// マーカー行は残る
			expect(out).toContain("# GEN:watchlist:start");
			expect(out).toContain("# GEN:watchlist:end");
		});

		it("start マーカーが無ければ throw", () => {
			expect(() => renderYml(SAMPLE, "no markers", "f.yml")).toThrow(/start/);
		});

		it("end マーカーが無ければ throw", () => {
			const noEnd = "      # GEN:watchlist:start\n      - x\n";
			expect(() => renderYml(SAMPLE, noEnd, "f.yml")).toThrow(/end/);
		});
	});
}
