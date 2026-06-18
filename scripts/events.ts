// scripts/events.ts
// config/events.yaml のマクロ/需給イベント (FOMC・SQ・CPI・日銀会合等) を読み、
// 「今日から直近 N 日以内の未来イベント」を一覧表示する確認用スクリプト。
//
// 個別決算 (watchlist.yaml の next_earnings_date) とは別に、相場全体・需給に効く
// イベントを寄り前に把握し、近接日はシグナルの確信度を抑える / 値幅予想に織り込むのが目的。
// 半導体は FOMC で金利感応度高く振れ、SQ (特にメジャーSQ) 前後は需給が歪む。
//
// 読むだけ。LLM 不使用。append もしない (valuation.ts / sector.ts と同じ流儀)。
//
// 実行:
//   node scripts/events.ts            (直近14日以内のイベント)
//   node scripts/events.ts --days 30  (直近30日以内)
//   node scripts/events.ts --all      (過去分も含め全件)
//   node scripts/events.ts --json     (機械可読)

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type EventDef = {
	date: string; // YYYY-MM-DD
	kind: string;
	label: string;
	impact?: "high" | "medium" | "low";
	jst_effect_date?: string;
	note?: string;
};
type EventsConfig = { events: EventDef[] };

type EventRow = EventDef & {
	effect_date: string; // 日本市場に効く日 (jst_effect_date があればそれ、なければ date)
	days_until: number; // 今日から effect_date までの営業日含む暦日数 (負=過去)
};

async function loadYaml<T>(path: string): Promise<T> {
	return parseYaml(await readFile(path, "utf8")) as T;
}

// YYYY-MM-DD を UTC 0時の Date にして暦日差を安定して計算する。
function parseDate(s: string): Date {
	const [y, m, d] = s.split("-").map((n) => parseInt(n, 10));
	return new Date(Date.UTC(y, m - 1, d));
}

function daysBetween(from: Date, to: Date): number {
	const MS = 24 * 60 * 60 * 1000;
	return Math.round((to.getTime() - from.getTime()) / MS);
}

function todayUtc(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function impactMark(impact?: string): string {
	switch (impact) {
		case "high":
			return "●高";
		case "medium":
			return "◐中";
		case "low":
			return "○低";
		default:
			return "－";
	}
}

function pad(s: string, width: number): string {
	let w = 0;
	for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
	return s + " ".repeat(Math.max(0, width - w));
}

function daysLabel(n: number): string {
	if (n === 0) return "本日";
	if (n < 0) return `${-n}日前`;
	return `${n}日後`;
}

function printTable(rows: EventRow[], days: number, all: boolean) {
	const scope = all ? "全件" : `直近${days}日以内`;
	console.log(`\n■ マクロ/需給イベント (${scope})`);
	console.log("─".repeat(96));
	if (rows.length === 0) {
		console.log(
			all
				? "イベント定義がありません。"
				: `${scope}に該当イベントはありません。`,
		);
		console.log("─".repeat(96));
		return;
	}
	console.log(
		[
			pad("効く日", 12),
			pad("残", 8),
			pad("重要度", 8),
			pad("種別", 10),
			"イベント",
		].join(" "),
	);
	for (const r of rows) {
		const dateCol = r.jst_effect_date ? `${r.effect_date}*` : r.effect_date;
		console.log(
			[
				pad(dateCol, 12),
				pad(daysLabel(r.days_until), 8),
				pad(impactMark(r.impact), 8),
				pad(r.kind, 10),
				r.label,
			].join(" "),
		);
		if (r.note) console.log(`             └ ${r.note}`);
	}
	console.log("─".repeat(96));
	console.log(
		"* = jst_effect_date 指定 (米国イベント等で日本市場に効く営業日が翌日)。",
	);
	console.log(
		"重要度 ●高 のイベントが3日以内にある場合、持ち越しシグナルの確信度を一段下げる目安。",
	);
}

async function main() {
	const args = process.argv.slice(2);
	const asJson = args.includes("--json");
	const all = args.includes("--all");
	const daysIdx = args.indexOf("--days");
	const days =
		daysIdx >= 0 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1], 10) : 14;

	const cfg = await loadYaml<EventsConfig>(join(ROOT, "config/events.yaml"));
	const today = todayUtc();

	const rows: EventRow[] = (cfg.events ?? [])
		.map((e) => {
			const effect = e.jst_effect_date ?? e.date;
			return {
				...e,
				effect_date: effect,
				days_until: daysBetween(today, parseDate(effect)),
			};
		})
		.filter((r) => all || (r.days_until >= 0 && r.days_until <= days))
		.sort((a, b) => a.effect_date.localeCompare(b.effect_date));

	if (asJson) {
		console.log(JSON.stringify(rows, null, 2));
		return;
	}
	printTable(rows, days, all);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
