// Cloudflare Worker: マクロイベント (FOMC / 日銀金融政策決定会合) の日程収集。
//
// 背景: FOMC・日銀会合は SQ や指数リバランスのように規則計算できず、従来は config/events.yaml に
// 人間が年1回手動転記していた (README「イベントカレンダーメンテナンス」)。公式が年単位で先の全日程を
// 出すので、これを Worker が定期スクレープして D1 (macro_events) に保持し、手動メンテを無くす。
// SQ / 指数リバランスは scripts/event-context.sh が日付計算で出すのでここでは扱わない。
//
// 収集はレーティング/決算日と同じ流儀 (素のスクレープ + 正規表現パース、LLM 不使用、INSERT OR REPLACE)。
// 月1回 (eod cron に月初相乗り) で十分: 会合は年8回・先の日程が確定公表されており、event-context.sh が
// 拾うのは「直近5日以内」なので、月初に先の日程を入れておけば近接日に judge/crash の prompt へ乗る。
//
// データソース (どちらも年ごとに先の全日程を掲載):
//   FOMC : https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
//          各年ブロックに month/date セルが交互。"27-28"=2日開催で最終日が声明発表日。声明は現地夕方
//          = 日本の翌営業日に効くので jst_effect_date = 翌日。
//   日銀  : https://www.boj.or.jp/mopo/mpmsche_minu/index.htm
//          各年テーブルの1列目「開催日および結果」が "7月30日（木）・31日（金）" 形式 (最終日=結果日)。
//          日本時間昼に出るので jst_effect_date は付けない (当日に効く)。

import { fetchHtml } from "./utils";

export interface MacroEventsEnv {
	DB: D1Database;
	USER_AGENT: string;
}

const FOMC_URL =
	"https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const BOJ_URL = "https://www.boj.or.jp/mopo/mpmsche_minu/index.htm";

type MacroEvent = {
	date: string; // YYYY-MM-DD (イベントが起きる日 / 結果発表日)
	kind: "fomc" | "boj";
	label: string;
	impact: "high";
	jst_effect_date: string | null; // 日本市場に効く営業日 (米国イベントは翌日, 日銀は null=当日)
	note: string;
};

const MONTHS: Record<string, number> = {
	january: 1,
	february: 2,
	march: 3,
	april: 4,
	may: 5,
	june: 6,
	july: 7,
	august: 8,
	september: 9,
	october: 10,
	november: 11,
	december: 12,
};

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function ymd(y: number, m: number, d: number): string {
	return `${y}-${pad2(m)}-${pad2(d)}`;
}

// YYYY-MM-DD の翌日 (米国イベントの jst_effect_date 算出)。
function nextDay(iso: string): string {
	const [y, m, d] = iso.split("-").map((n) => Number.parseInt(n, 10));
	const t = new Date(Date.UTC(y, m - 1, d + 1));
	return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function stripTags(s: string): string {
	return s.replace(/<[^>]+>/g, "").trim();
}

// --- FOMC パース -------------------------------------------------------------
// "(YYYY) FOMC Meetings" 見出し以降〜次の年見出しまでを1年ブロックとし、month/date を交互に
// 対応づける。date は "27-28"(同月2日) / "30-1"(月跨ぎ) / "17-18*"(*=会見付) /
// "22 (notation vote)"(持ち回り投票=声明日でないので除外)。最終日を声明発表日とする。
function parseFomc(html: string): MacroEvent[] {
	const out: MacroEvent[] = [];
	const heads = [...html.matchAll(/(20\d{2})\s+FOMC Meetings/g)];
	for (let i = 0; i < heads.length; i++) {
		const year = Number.parseInt(heads[i][1], 10);
		const start = heads[i].index ?? 0;
		const end =
			i + 1 < heads.length ? (heads[i + 1].index ?? html.length) : html.length;
		const seg = html.slice(start, end);
		const months = [
			...seg.matchAll(/fomc-meeting__month[^>]*>(.*?)<\/div>/gs),
		].map((m) => stripTags(m[1]).toLowerCase());
		const dates = [
			...seg.matchAll(/fomc-meeting__date[^>]*>(.*?)<\/div>/gs),
		].map((m) => stripTags(m[1]));
		const n = Math.min(months.length, dates.length);
		for (let j = 0; j < n; j++) {
			const startMonth = MONTHS[months[j]];
			if (!startMonth) continue;
			const raw = dates[j];
			if (/\(/.test(raw)) continue; // notation vote 等の注記は通常会合でないので除外
			const m = raw.match(/(\d{1,2})(?:[-–](\d{1,2})\*?)?/);
			if (!m) continue;
			const first = Number.parseInt(m[1], 10);
			const second = m[2] ? Number.parseInt(m[2], 10) : first;
			// 月跨ぎ ("30-1"): 2日目が小さければ翌月。12→1 は年も繰り上げ。
			let mm = startMonth;
			let yy = year;
			if (second < first) {
				mm += 1;
				if (mm > 12) {
					mm = 1;
					yy += 1;
				}
			}
			const date = ymd(yy, mm, second);
			out.push({
				date,
				kind: "fomc",
				label: `FOMC 政策金利発表 (${mm}月会合)`,
				impact: "high",
				jst_effect_date: nextDay(date),
				note: "声明は現地夕 = 日本の翌営業日早朝に効く。半導体は金利感応度高く翌日大きく振れやすい。",
			});
		}
	}
	return out;
}

// --- 日銀パース --------------------------------------------------------------
// ページは年ごとに "表 YYYY年" 見出し + <table>。各テーブルの1列目セルが
// "7月30日（木）・31日（金）" / "4月30日（水）・5月 1日（木）" 形式 (最終日=結果発表日)。
// 年は直前の "表 YYYY年" から取る。
function parseBoj(html: string): MacroEvent[] {
	const out: MacroEvent[] = [];
	const yearHeads = [...html.matchAll(/表\s*(20\d{2})年/g)].map((m) => ({
		index: m.index ?? 0,
		year: Number.parseInt(m[1], 10),
	}));
	const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)];
	for (const t of tables) {
		const tIndex = t.index ?? 0;
		let year = 0;
		for (const h of yearHeads) {
			if (h.index <= tIndex) year = h.year;
		}
		if (!year) continue;
		const rows = [...t[0].matchAll(/<tr[\s\S]*?<\/tr>/g)];
		for (const r of rows) {
			const cells = [...r[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(
				(c) => stripTags(c[1]).replace(/\s+/g, ""),
			);
			if (cells.length === 0) continue;
			const first = cells[0];
			// 開催日セルのみ対象: 同月2日目は月省略 ("1月22日・23日") なので月はオプショナル。
			const days = [...first.matchAll(/(?:(\d{1,2})月)?(\d{1,2})日/g)];
			if (days.length === 0) continue;
			// 曜日括弧が付く開催日行のみ採用 (公表日のみの行・見出し行を弾く)。
			if (!/[（(].[)）]/.test(first)) continue;
			// 最終日 = 配列末尾の "日"。月省略 (同月2日目) なら直前にマッチした月を引き継ぐ。
			const last = days[days.length - 1];
			let monthStr = last[1];
			if (!monthStr) {
				for (let k = days.length - 1; k >= 0; k--) {
					if (days[k][1]) {
						monthStr = days[k][1];
						break;
					}
				}
			}
			if (!monthStr) continue;
			const mm = Number.parseInt(monthStr, 10);
			const dd = Number.parseInt(last[2], 10);
			out.push({
				date: ymd(year, mm, dd),
				kind: "boj",
				label: `日銀 金融政策決定会合 結果発表 (${mm}月会合)`,
				impact: "high",
				jst_effect_date: null,
				note: "会合結果は日本時間昼に出る。長期金利・銀行/不動産・為替経由で全体に効く。",
			});
		}
	}
	return out;
}

// date+kind で重複排除 (同じ会合が複数年テーブルに跨って載るケースの保険)。
function dedupe(events: MacroEvent[]): MacroEvent[] {
	const seen = new Set<string>();
	const out: MacroEvent[] = [];
	for (const e of events) {
		const key = `${e.date}:${e.kind}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(e);
	}
	return out;
}

// 1イベントを D1 に保存。冪等キー = (date, kind)。再スクレープで最新の label/note に上書き。
async function saveEvent(env: MacroEventsEnv, e: MacroEvent): Promise<void> {
	await env.DB.prepare(
		`INSERT OR REPLACE INTO macro_events
       (date, kind, label, impact, jst_effect_date, note, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			e.date,
			e.kind,
			e.label,
			e.impact,
			e.jst_effect_date,
			e.note,
			new Date().toISOString(),
		)
		.run();
}

// FOMC + 日銀の日程を公式サイトから取得し D1 (macro_events) に保存する。
// スクレープ結果が0件なら (サイト構造変更の可能性) 保存せず例外を投げる (既存データを守る)。
export async function collectMacroEvents(
	env: MacroEventsEnv,
): Promise<Record<string, unknown>> {
	const [fomcHtml, bojHtml] = await Promise.all([
		fetchHtml(FOMC_URL, env),
		fetchHtml(BOJ_URL, env),
	]);
	const fomc = parseFomc(fomcHtml);
	const boj = parseBoj(bojHtml);
	const events = dedupe([...fomc, ...boj]);
	if (events.length === 0) {
		throw new Error(
			"macro-events: スクレープ結果が0件 (サイト構造変更の可能性)。保存をスキップ。",
		);
	}
	for (const e of events) await saveEvent(env, e);
	return { fomc: fomc.length, boj: boj.length, saved: events.length };
}

// in-source tests (本番ビルドでは tree-shake される。vitest.config.ts 参照)
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("parseFomc", () => {
		const html = `
      <p>2026 FOMC Meetings</p>
      <div class="fomc-meeting__month col"><strong>January</strong></div>
      <div class="fomc-meeting__date col">27-28</div>
      <div class="fomc-meeting__month col"><strong>October</strong></div>
      <div class="fomc-meeting__date col">28-29</div>
      <div class="fomc-meeting__month col"><strong>December</strong></div>
      <div class="fomc-meeting__date col">15-16*</div>
      <p>2027 FOMC Meetings</p>
      <div class="fomc-meeting__month col"><strong>January</strong></div>
      <div class="fomc-meeting__date col">26-27</div>
    `;
		const evts = parseFomc(html);

		it("各会合の最終日を声明日として拾い * を除去する", () => {
			const dates = evts.map((e) => e.date);
			expect(dates).toContain("2026-01-28");
			expect(dates).toContain("2026-10-29");
			expect(dates).toContain("2026-12-16");
			expect(dates).toContain("2027-01-27");
		});

		it("jst_effect_date は翌日・kind/impact を付ける", () => {
			const e = evts.find((x) => x.date === "2026-01-28");
			if (!e) throw new Error("not found");
			expect(e.jst_effect_date).toBe("2026-01-29");
			expect(e.kind).toBe("fomc");
			expect(e.impact).toBe("high");
		});

		it("notation vote 等の括弧付き注記は除外する", () => {
			const h = `2026 FOMC Meetings
        <div class="fomc-meeting__month col"><strong>May</strong></div>
        <div class="fomc-meeting__date col">22 (notation vote)</div>`;
			expect(parseFomc(h)).toHaveLength(0);
		});

		it("月跨ぎ (30-1) は翌月1日に繰り上げる", () => {
			const h = `2026 FOMC Meetings
        <div class="fomc-meeting__month col"><strong>April</strong></div>
        <div class="fomc-meeting__date col">30-1</div>`;
			expect(parseFomc(h)[0].date).toBe("2026-05-01");
		});

		it("12月跨ぎは年も繰り上げる", () => {
			const h = `2026 FOMC Meetings
        <div class="fomc-meeting__month col"><strong>December</strong></div>
        <div class="fomc-meeting__date col">31-1</div>`;
			expect(parseFomc(h)[0].date).toBe("2027-01-01");
		});
	});

	describe("parseBoj", () => {
		const html = `
      <div class="tbl-box">表 2026年
      <table>
        <tr><th>金融政策決定会合開催日および結果</th><th>各資料の公表日</th></tr>
        <tr><td>1月22日（木）・23日（金） [PDF]</td><td>2月 2日（月）</td></tr>
        <tr><td>4月30日（水）・5月 1日（木）</td><td>5月12日（火）</td></tr>
        <tr><td>7月30日（木）・31日（金）</td><td>8月10日（月）</td></tr>
      </table></div>`;
		const evts = parseBoj(html);

		it("開催日の最終日を結果発表日として拾う", () => {
			const dates = evts.map((e) => e.date);
			expect(dates).toContain("2026-01-23");
			expect(dates).toContain("2026-07-31");
		});

		it("月跨ぎ会合は後ろの月日を採る", () => {
			expect(evts.map((e) => e.date)).toContain("2026-05-01");
		});

		it("kind=boj・jst_effect_date は null (当日に効く)", () => {
			const e = evts.find((x) => x.date === "2026-07-31");
			if (!e) throw new Error("not found");
			expect(e.kind).toBe("boj");
			expect(e.jst_effect_date).toBeNull();
		});

		it("公表日のみの行 (開催日でない) は拾わない (3件)", () => {
			expect(evts).toHaveLength(3);
		});
	});

	describe("dedupe", () => {
		it("date+kind が同じイベントを1件にまとめる", () => {
			const e = {
				date: "2026-07-31",
				kind: "boj" as const,
				label: "x",
				impact: "high" as const,
				jst_effect_date: null,
				note: "n",
			};
			expect(dedupe([e, { ...e }, { ...e, kind: "fomc" }])).toHaveLength(2);
		});
	});

	describe("nextDay", () => {
		it("月末・年末を跨いで翌日を返す", () => {
			expect(nextDay("2026-07-29")).toBe("2026-07-30");
			expect(nextDay("2026-01-31")).toBe("2026-02-01");
			expect(nextDay("2026-12-31")).toBe("2027-01-01");
		});
	});
}
