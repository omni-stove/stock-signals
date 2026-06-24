// README 内の ```mermaid``` ブロックを mermaid 公式パーサで parse し、
// 構文エラーがあれば該当ブロックの開始行と共に報告する。
// 成功時は何も出力しない (quiet.sh 経由で無音運用するため)。
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// mermaid は DOM 前提なので jsdom で最小限のグローバルを用意してから import する。
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.DOMPurify = undefined;

const { default: mermaid } = await import("mermaid");

type Block = { startLine: number; code: string };

// ファイルから ```mermaid フェンスで囲われたブロックを開始行付きで抜き出す。
function extractBlocks(source: string): Block[] {
	const lines = source.split("\n");
	const blocks: Block[] = [];
	let start = -1;
	let buf: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (start === -1) {
			if (/^```mermaid\s*$/.test(line.trim())) {
				start = i + 1; // 1-based の開始行 (フェンス行)
				buf = [];
			}
		} else if (line.trim() === "```") {
			blocks.push({ startLine: start, code: buf.join("\n") });
			start = -1;
		} else {
			buf.push(line);
		}
	}
	return blocks;
}

async function main(): Promise<void> {
	const files = process.argv.slice(2);
	if (files.length === 0) files.push("README.md");

	mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });

	let failed = 0;
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		for (const block of extractBlocks(source)) {
			try {
				await mermaid.parse(block.code);
			} catch (err) {
				failed++;
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`✗ ${file}:${block.startLine} mermaid parse error`);
				console.error(msg);
				console.error("");
			}
		}
	}

	if (failed > 0) process.exit(1);
}

await main();
