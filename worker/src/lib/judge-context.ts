// ticker-brief / crash-scenario / slack-reply に渡す「数値コンテキスト」を組み立てる純粋関数群。
//
// 設計:
//   - 取得 (D1 read) は routes/judge-context.ts が行い、ここは「生 rows → 正規化済みブロック」の
//     純粋関数に徹する。指標 (RSI/ATR/レンジ/MA) は indicators.ts を再利用し二重実装しない。
//   - 出力キーは snake_case。
//   - 丸め: long_chg/short_chg は floor1 (小数第1位切り捨て)。

import {
	computeDailyIndicators,
	type DailyRow,
	maDevPct,
	withMovingAverages,
} from "./indicators";
import {
	classifyUsSession,
	parseUsIndexes,
	resolveUsCloseJstDate,
} from "./premarket";

// (x*10|floor)/10。負値も下方向に floor。
function floor1(x: number): number {
	return Math.floor(x * 10) / 10;
}

// ザラ場中の vol_x をペース換算で出す。daily にはまだ当日行が無いので vol_x_20d は
// 前日基準のまま (確定値)。これと別に「当日累積出来高をフル換算 (÷ 経過立会率) して
// 20日平均で割った」当日ベースの倍率を intraday として渡し、ザラ場判断が前日値を
// 当日値と取り違えないようにする。経過率が小さすぎる寄り直後 (<10%) は誤差が大きいので出さない。
export interface IntradayVol {
	// 当日の累積出来高 (prices 最新スナップショット)。
	cumVolume: number | null;
	// 立会経過率 (0..1)。sessionElapsedFrac。
	elapsedFrac: number;
	// 20日平均出来高 (avgVolume20d)。
	avgVol20d: number | null;
}

const MIN_ELAPSED_FRAC = 0.1; // 寄り直後はペース換算の誤差が大きいので intraday を出さない閾値

function intradayVolX(iv: IntradayVol): number | null {
	if (
		iv.cumVolume == null ||
		iv.avgVol20d == null ||
		iv.avgVol20d <= 0 ||
		iv.elapsedFrac < MIN_ELAPSED_FRAC
	) {
		return null;
	}
	const projected = iv.cumVolume / iv.elapsedFrac; // 1日フル換算
	return floor1(projected / iv.avgVol20d);
}

// --- earnings: days_to_earnings ---------------------------------------------
export interface EarningsBlock {
	status: "ok" | "unknown";
	next_date: string | null;
	days_to_earnings: number | null;
}

// next_date と today (YYYY-MM-DD) の暦日差。next_date が無ければ unknown。
export function buildEarnings(
	nextDate: string | null | undefined,
	today: string,
): EarningsBlock {
	if (!nextDate) {
		return { status: "unknown", next_date: null, days_to_earnings: null };
	}
	const ms =
		new Date(`${nextDate}T12:00:00Z`).getTime() -
		new Date(`${today}T12:00:00Z`).getTime();
	return {
		status: "ok",
		next_date: nextDate,
		days_to_earnings: Math.round(ms / 86400_000),
	};
}

// --- earnings_result: 直近に出た決算の beat/miss -----------------------------
// 「決算が近い」(buildEarnings) と対をなす「決算が出たばかり」ブロック。fundamentals は
// (ticker, date) で毎日1スナップショット入るので、actual_period (最後の実績四半期) が
// 前の取得日から別四半期へ切り替わった日 = その四半期決算が出た日、と捉えられる。
// その日から FRESH_DAYS 営業日以内なら fresh とし、実績EPS vs 予想EPS のサプライズ符号を渡す。
// 読み(材料としての重み付け)は ticker-brief (LLM) に委ね、ここは事実 (beat/miss と経過日) だけ出す。

// fundamentals の1スナップショット (取得日 date と、その時点の実績/予想)。
export interface FundamentalsSnapshot {
	date: string; // 取得日 YYYY-MM-DD
	actual_eps?: number | null;
	actual_period?: string | null;
	forecast_eps?: number | null;
}

export interface EarningsResultBlock {
	status: "fresh" | "stale" | "none";
	reported_period: string | null; // 出たばかりの決算期 (例 "2026.06")
	days_since: number | null; // 決算が出た取得日から today までの営業日 (土日除く、同日=0)
	actual_eps: number | null;
	forecast_eps: number | null;
	surprise_pct: number | null; // (actual - forecast)/|forecast| ×100、floor1
	verdict: "beat" | "inline" | "miss" | null;
}

// 決算が出てから fresh 扱いする営業日 (当日=0。寄りで大半が織り込まれるので2営業日ほど)。
const FRESH_DAYS = 2;
// サプライズが inline を脱する閾値 (予想比 ±%)。これ未満は誤差として inline。
const SURPRISE_BAND_PCT = 5;

// from→to (いずれも YYYY-MM-DD) の間の営業日数 (土日を除く、同日=0)。祝日は非考慮の近似で、
// event-context.ts の営業日計算と揃える (窓判定なので祝日ズレは実用上問題ない)。
function businessDaysBetween(from: string, to: string): number {
	let count = 0;
	const cur = new Date(`${from}T00:00:00Z`);
	const end = new Date(`${to}T00:00:00Z`);
	while (cur < end) {
		cur.setUTCDate(cur.getUTCDate() + 1);
		const w = cur.getUTCDay();
		if (w !== 0 && w !== 6) count++;
	}
	return count;
}

const NONE_RESULT: EarningsResultBlock = {
	status: "none",
	reported_period: null,
	days_since: null,
	actual_eps: null,
	forecast_eps: null,
	surprise_pct: null,
	verdict: null,
};

// snapshots は date 降順 (新しい順) で渡す。先頭が最新スナップショット。
export function buildEarningsResult(
	snapshots: FundamentalsSnapshot[],
	today: string,
): EarningsResultBlock {
	if (snapshots.length === 0) return NONE_RESULT;
	const latest = snapshots[0];
	const period = latest.actual_period ?? null;
	if (!period) return NONE_RESULT;

	// actual_period が latest と違う最初の (= 直近の) 古いスナップショットを探す。
	// 見つかればその「直後」のスナップショットが切り替わり日 = 決算が出た日。
	let reportedAt: string | null = null;
	for (let i = 1; i < snapshots.length; i++) {
		const prevPeriod = snapshots[i].actual_period ?? null;
		if (prevPeriod && prevPeriod !== period) {
			reportedAt = snapshots[i - 1].date;
			break;
		}
		// period が一致し続ける = まだ切り替わっていない。さらに遡る。
	}
	// 全スナップショットで同じ period = この窓内に切替なし。決算は窓より前。
	if (reportedAt === null) {
		return { ...NONE_RESULT, status: "stale", reported_period: period };
	}

	const daysSince = businessDaysBetween(reportedAt, today);

	const actual = latest.actual_eps ?? null;
	const forecast = latest.forecast_eps ?? null;
	let surprisePct: number | null = null;
	let verdict: EarningsResultBlock["verdict"] = null;
	if (actual !== null && forecast !== null && forecast !== 0) {
		surprisePct = floor1(((actual - forecast) / Math.abs(forecast)) * 100);
		verdict =
			surprisePct >= SURPRISE_BAND_PCT
				? "beat"
				: surprisePct <= -SURPRISE_BAND_PCT
					? "miss"
					: "inline";
	}

	return {
		status: daysSince <= FRESH_DAYS ? "fresh" : "stale",
		reported_period: period,
		days_since: daysSince,
		actual_eps: actual,
		forecast_eps: forecast,
		surprise_pct: surprisePct,
		verdict,
	};
}

// --- valuation: 現値 × 予想EPS の実績PER を fair_per と突き合わせる -----------
// fair_per は watchlist の静的値 (妥当と判断する予想PER)。現値と forecast_eps から実績PER を
// 出し、fair_per の上/下/同等を判定する。読み (割高/割安をどう扱うか) は
// ticker-brief に委ね、ここは per_now と vs_fair の事実だけ出す。
export interface ValuationBlock {
	status: "ok" | "unavailable";
	per_now: number | null; // 現値 / forecast_eps、floor1
	fair_per: number | null; // watchlist の妥当予想PER
	vs_fair: "above" | "inline" | "below" | null;
}

// per が fair_per からこの割合 (±%) 内なら inline。丸め/予想ブレを誤差として吸収する。
const FAIR_PER_BAND_PCT = 5;

export function buildValuation(
	priceNow: number | null | undefined,
	forecastEps: number | null | undefined,
	fairPer: number | null | undefined,
): ValuationBlock {
	if (priceNow == null || forecastEps == null || forecastEps <= 0) {
		return {
			status: "unavailable",
			per_now: null,
			fair_per: fairPer ?? null,
			vs_fair: null,
		};
	}
	const perNow = floor1(priceNow / forecastEps);
	if (fairPer == null || fairPer <= 0) {
		return { status: "ok", per_now: perNow, fair_per: null, vs_fair: null };
	}
	const devPct = ((perNow - fairPer) / fairPer) * 100;
	const vsFair =
		devPct >= FAIR_PER_BAND_PCT
			? "above"
			: devPct <= -FAIR_PER_BAND_PCT
				? "below"
				: "inline";
	return { status: "ok", per_now: perNow, fair_per: fairPer, vs_fair: vsFair };
}

// --- premarket: 鮮度判定 (age>20h で stale) ---------------------------------
// us_session は休場またぎ判定 (premarket.ts): fresh = 前夜の新しい NY /
// carried_over = 米国休場などで前営業日の東京セッションが既に消化した数字の持ち越し。
export interface PremarketRow {
	fetched_at?: string | null;
	sox_change_pct?: number | null;
	nasdaq_change_pct?: number | null;
	dow_change_pct?: number | null;
	nikkei_futures_price?: number | null;
	nikkei_contract?: string | null;
	us_indexes_json?: string | null;
	[key: string]: unknown;
}

export function buildPremarket(
	row: PremarketRow | null | undefined,
	epochNow: number,
	today: string,
): Record<string, unknown> {
	if (!row?.fetched_at) return { status: "unavailable" };
	const ageH = Math.floor(
		(epochNow - new Date(row.fetched_at).getTime()) / 3600_000,
	);
	const usCloseJst = resolveUsCloseJstDate(
		parseUsIndexes(row.us_indexes_json),
		row.fetched_at,
	);
	return {
		status: ageH > 20 ? "stale" : "ok",
		age_hours: ageH,
		us_close_jst_date: usCloseJst,
		us_session: classifyUsSession(usCloseJst, today),
		sox_change_pct: row.sox_change_pct ?? null,
		nasdaq_change_pct: row.nasdaq_change_pct ?? null,
		dow_change_pct: row.dow_change_pct ?? null,
		nikkei_futures_price: row.nikkei_futures_price ?? null,
		nikkei_contract: row.nikkei_contract ?? null,
	};
}

// --- margin: WoW 増減 (rows は date DESC, [0]=最新週 [1]=前週) ---------------
export interface MarginRow {
	date: string;
	long_qty?: number | null;
	short_qty?: number | null;
	ratio?: number | null;
}

export function buildMargin(rows: MarginRow[]): Record<string, unknown> {
	if (!rows || rows.length < 1) return { status: "unavailable" };
	const cur = rows[0];
	const prev = rows[1] ?? null;
	const wow = (
		c: number | null | undefined,
		p: number | null | undefined,
	): number | null => (prev && c != null && p != null ? floor1(c - p) : null);
	return {
		status: "ok",
		rows_n: rows.length,
		latest_date: cur.date,
		long_qty: cur.long_qty ?? null,
		short_qty: cur.short_qty ?? null,
		ratio: cur.ratio ?? null,
		long_chg: wow(cur.long_qty, prev?.long_qty),
		short_chg: wow(cur.short_qty, prev?.short_qty),
		prev_date: prev?.date ?? null,
	};
}

// --- forced: 強制決済フローのスコア (forced_liquidation 最新行) ---------------
// 「投げ/踏みが今日いつ出るか」を judge が読むための材料。direction=long(投げ)/short(踏み上げ)、
// stance=building(燃料+着火が揃い、これから出る)/exhausted(出尽くし)。fuel/fire/exhaust は 0..3。
// settle_warning_in_days は building のときだけ非 null (追証→強制決済の猶予営業日数)。
export interface ForcedRow {
	date: string;
	direction?: string | null;
	stance?: string | null;
	fuel?: number | null;
	fire?: number | null;
	exhaust?: number | null;
	settle_warning_in_days?: number | null;
	summary?: string | null;
}

export function buildForced(
	row: ForcedRow | null | undefined,
): Record<string, unknown> {
	if (!row || (row.stance ?? "none") === "none") return { status: "none" };
	return {
		status: "ok",
		date: row.date,
		direction: row.direction ?? null,
		stance: row.stance ?? null,
		fuel: row.fuel ?? null,
		fire: row.fire ?? null,
		exhaust: row.exhaust ?? null,
		settle_warning_in_days: row.settle_warning_in_days ?? null,
		summary: row.summary ?? null,
	};
}

// today (JST, YYYY-MM-DD) から n 営業日 (土日除く近似、祝日は非考慮) 前の日付。
function businessDaysBefore(today: string, n: number): string {
	const d = new Date(`${today}T00:00:00Z`);
	let left = n;
	while (left > 0) {
		d.setUTCDate(d.getUTCDate() - 1);
		const w = d.getUTCDay();
		if (w !== 0 && w !== 6) left--;
	}
	return d.toISOString().slice(0, 10);
}

// --- daily: indicators.ts を使い 20日レンジ/MA位置/RSI/ATR を組む -------------
// rows は date DESC (新しい順)。withMovingAverages で ma5/ma25 を付与してから指標を計算する。
// intraday を渡すと、ザラ場中で daily に当日行がまだ無い局面の「当日ベース vol_x」を併記する。
// today を渡すと鮮度を判定する: 最新足が2営業日前より古い (= eod 収集が2回以上落ちて確定足が
// 欠けている) 場合は status を stale にし、judge に古い MA/レンジ/ATR を最新値として読ませない。
// 正常時の最新足は前営業日 (ザラ場中) か当日 (引け後) なので、2営業日の猶予は祝日1日を吸収する
// (連休明けの初日だけ保守側に stale と誤判定しうるが、価格と文脈だけで判定は継続できる)。
export function buildDaily(
	rowsDesc: DailyRow[],
	intraday?: IntradayVol | null,
	today?: string | null,
): Record<string, unknown> {
	const n = rowsDesc?.length ?? 0;
	if (n < 5) return { status: "insufficient", rows_n: n };
	const latestDate = (rowsDesc[0]?.date as string | undefined) ?? null;
	if (today && latestDate && latestDate < businessDaysBefore(today, 2)) {
		return { status: "stale", rows_n: n, latest_date: latestDate };
	}
	// ma を付与した最新行を「現在地」とする。n と同数を要求して全行に ma を載せる。
	const withMa = withMovingAverages(
		rowsDesc as Record<string, unknown>[],
		n,
	) as DailyRow[];
	const cur = withMa[0];
	const ind = computeDailyIndicators(rowsDesc);
	if (!ind) return { status: "insufficient", rows_n: n };

	const close = (cur.close as number | null) ?? null;
	const ma5 = (cur.ma5 as number | null) ?? null;
	const ma25 = (cur.ma25 as number | null) ?? null;
	const maPosition =
		ma5 != null && ma25 != null && close != null && close > ma5 && close > ma25
			? "above"
			: ma5 != null &&
					ma25 != null &&
					close != null &&
					close < ma5 &&
					close < ma25
				? "below"
				: "between";

	// ザラ場中 (route が intraday を渡したとき) は当日ベース vol_x を併記する。
	// vol_x_20d 本体は前日確定足のままなので、判断側が intraday を優先して読む。
	const volXIntraday = intraday ? intradayVolX(intraday) : null;

	return {
		status: "ok",
		rows_n: n,
		// latest_date は daily の最新確定足の日付。ザラ場中は当日ではなく前営業日を指す。
		latest_date: cur.date,
		close,
		range_high_20d: ind.range_high_20d,
		range_low_20d: ind.range_low_20d,
		range_pct: ind.range_pct,
		ma5,
		ma25,
		ma_position: maPosition,
		ma25_dev_pct: maDevPct(close, ma25),
		ma5_dev_pct: maDevPct(close, ma5),
		vol_x_20d: ind.vol_x_20d,
		// ザラ場中のみ非 null。当日累積出来高を立会経過率でフル換算し 20日平均で割った倍率。
		// daily が当日未確定の局面で vol_x_20d (前日基準) の代わりに読む値。
		vol_x_20d_intraday: volXIntraday,
		rsi_14: ind.rsi_14,
		atr_pct: ind.atr_pct,
		atr_pct_baseline: ind.atr_pct_baseline,
		atr_vs_baseline: ind.atr_vs_baseline,
		vol_pctile_60d: ind.vol_pctile_60d,
		move_per_vol: ind.move_per_vol,
		obv_trend: ind.obv_trend,
		ad_trend: ind.ad_trend,
		cmf_20d: ind.cmf_20d,
		volume_quality: ind.volume_quality,
		momentum_state: ind.momentum_state,
	};
}

// --- prices: トレンド素材 + 鮮度 (age>2h で closed) --------------------------
export interface PriceRow {
	slot?: string | null;
	change_pct?: number | null;
	volume?: number | null;
	quote_time?: string | null;
	[key: string]: unknown;
}

export function buildPrices(
	rows: PriceRow[],
	epochNow: number,
): Record<string, unknown> {
	if (!rows || rows.length === 0) return { status: "unavailable" };
	const latest = rows[0];
	const fetchedAt = (latest as { fetched_at?: string }).fetched_at;
	let quoteStatus: "live" | "closed" | "unavailable";
	let ageH = 0;
	if (fetchedAt) {
		ageH = Math.floor((epochNow - new Date(fetchedAt).getTime()) / 3600_000);
		quoteStatus = ageH > 2 ? "closed" : "live";
	} else {
		quoteStatus = "unavailable";
	}
	return {
		status: "ok",
		quote_status: quoteStatus,
		age_hours: ageH,
		rows_n: rows.length,
		latest,
		series: rows.map((r) => ({
			slot: r.slot ?? null,
			change_pct: r.change_pct ?? null,
			volume: r.volume ?? null,
			quote_time: r.quote_time ?? null,
		})),
	};
}

// in-source tests。
if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("buildEarnings", () => {
		it("next_date があれば暦日差を出す", () => {
			expect(buildEarnings("2026-06-30", "2026-06-20")).toEqual({
				status: "ok",
				next_date: "2026-06-30",
				days_to_earnings: 10,
			});
		});
		it("next_date 無しは unknown/null", () => {
			expect(buildEarnings(null, "2026-06-20")).toEqual({
				status: "unknown",
				next_date: null,
				days_to_earnings: null,
			});
		});
	});

	describe("buildEarningsResult", () => {
		// date 降順 (新しい順) で渡す。actual_period の切替で「決算が出た日」を割り出す。
		it("直近で四半期が切替→fresh、予想超えで beat", () => {
			// 06-18(木) 切替 → 06-19(金) today = 1営業日。
			const out = buildEarningsResult(
				[
					{
						date: "2026-06-19",
						actual_eps: 152,
						forecast_eps: 120,
						actual_period: "2026.06",
					},
					{
						date: "2026-06-18",
						actual_eps: 152,
						forecast_eps: 120,
						actual_period: "2026.06",
					},
					{
						date: "2026-06-17",
						actual_eps: 100,
						forecast_eps: 120,
						actual_period: "2026.03",
					},
				],
				"2026-06-19",
			);
			expect(out.status).toBe("fresh");
			expect(out.reported_period).toBe("2026.06");
			expect(out.days_since).toBe(1); // 切替日 = 2026-06-18(木)
			expect(out.verdict).toBe("beat");
			expect(out.surprise_pct).toBe(26.6); // (152-120)/120*100 floor1
		});
		it("予想割れは miss", () => {
			const out = buildEarningsResult(
				[
					{
						date: "2026-06-20",
						actual_eps: 90,
						forecast_eps: 120,
						actual_period: "2026.06",
					},
					{
						date: "2026-06-19",
						actual_eps: 100,
						forecast_eps: 120,
						actual_period: "2026.03",
					},
				],
				"2026-06-20",
			);
			expect(out.status).toBe("fresh");
			expect(out.verdict).toBe("miss");
		});
		it("予想比±5%以内は inline", () => {
			const out = buildEarningsResult(
				[
					{
						date: "2026-06-20",
						actual_eps: 123,
						forecast_eps: 120,
						actual_period: "2026.06",
					},
					{
						date: "2026-06-19",
						actual_eps: 100,
						forecast_eps: 120,
						actual_period: "2026.03",
					},
				],
				"2026-06-20",
			);
			expect(out.verdict).toBe("inline");
		});
		it("切替から FRESH_DAYS 超過は stale", () => {
			// 06-12(金) 切替 → 06-19(金) today = 5営業日 > 2。
			const out = buildEarningsResult(
				[
					{
						date: "2026-06-19",
						actual_eps: 152,
						forecast_eps: 120,
						actual_period: "2026.06",
					},
					{
						date: "2026-06-12", // 切替直後 = 決算が出た日 (金)
						actual_eps: 152,
						forecast_eps: 120,
						actual_period: "2026.06",
					},
					{
						date: "2026-06-11",
						actual_eps: 100,
						forecast_eps: 120,
						actual_period: "2026.03",
					},
				],
				"2026-06-19",
			);
			expect(out.status).toBe("stale");
			expect(out.days_since).toBe(5);
			expect(out.reported_period).toBe("2026.06");
		});
		it("土日は営業日に数えない (金切替→翌月曜 today = 1営業日で fresh)", () => {
			// 06-19(金) 切替 → 06-22(月) today。暦日3だが営業日は1。
			const out = buildEarningsResult(
				[
					{
						date: "2026-06-22",
						actual_eps: 152,
						forecast_eps: 120,
						actual_period: "2026.06",
					},
					{
						date: "2026-06-19", // 切替直後 = 決算が出た日 (金)
						actual_eps: 152,
						forecast_eps: 120,
						actual_period: "2026.06",
					},
					{
						date: "2026-06-18",
						actual_eps: 100,
						forecast_eps: 120,
						actual_period: "2026.03",
					},
				],
				"2026-06-22",
			);
			expect(out.status).toBe("fresh");
			expect(out.days_since).toBe(1);
		});
		it("窓内で切替なし (全行同一四半期) は stale", () => {
			const out = buildEarningsResult(
				[
					{ date: "2026-06-20", actual_period: "2026.06" },
					{ date: "2026-06-19", actual_period: "2026.06" },
				],
				"2026-06-20",
			);
			expect(out.status).toBe("stale");
			expect(out.days_since).toBeNull();
		});
		it("スナップショット無し / actual_period 無しは none", () => {
			expect(buildEarningsResult([], "2026-06-20").status).toBe("none");
			expect(
				buildEarningsResult(
					[{ date: "2026-06-20", actual_period: null }],
					"2026-06-20",
				).status,
			).toBe("none");
		});
	});

	describe("buildValuation", () => {
		it("現値/予想EPS で実績PER、fair_per 超えは above", () => {
			// 3000/100=30、fair_per=20 → +50% → above
			expect(buildValuation(3000, 100, 20)).toEqual({
				status: "ok",
				per_now: 30,
				fair_per: 20,
				vs_fair: "above",
			});
		});
		it("fair_per 下回りは below", () => {
			// 1500/100=15、fair_per=20 → -25% → below
			expect(buildValuation(1500, 100, 20)).toEqual({
				status: "ok",
				per_now: 15,
				fair_per: 20,
				vs_fair: "below",
			});
		});
		it("±5%以内は inline", () => {
			// 2040/100=20.4、fair_per=20 → +2% → inline
			expect(buildValuation(2040, 100, 20).vs_fair).toBe("inline");
		});
		it("予想EPS が 0/null なら unavailable (fair_per は保持)", () => {
			expect(buildValuation(3000, 0, 20)).toEqual({
				status: "unavailable",
				per_now: null,
				fair_per: 20,
				vs_fair: null,
			});
			expect(buildValuation(3000, null, 20).status).toBe("unavailable");
		});
		it("fair_per が null なら per_now だけ出し vs_fair は null", () => {
			expect(buildValuation(3000, 100, null)).toEqual({
				status: "ok",
				per_now: 30,
				fair_per: null,
				vs_fair: null,
			});
		});
	});

	describe("buildPremarket", () => {
		// 2026-06-20 は土曜だが、鮮度計算は epoch 差のみなので曜日は無関係。
		const now = Date.parse("2026-06-20T00:00:00Z");
		const today = "2026-06-20";
		it("1時間前は ok、値を載せる (jst_time なしは us_session unknown)", () => {
			const out = buildPremarket(
				{
					fetched_at: new Date(now - 3600_000).toISOString(),
					sox_change_pct: 1.2,
				},
				now,
				today,
			);
			expect(out.status).toBe("ok");
			expect(out.sox_change_pct).toBe(1.2);
			expect(out.us_close_jst_date).toBeNull();
			expect(out.us_session).toBe("unknown");
		});
		it("24時間前は stale (>20h)", () => {
			const out = buildPremarket(
				{ fetched_at: new Date(now - 24 * 3600_000).toISOString() },
				now,
				today,
			);
			expect(out.status).toBe("stale");
		});
		it("米国休場明け (クローズが前営業日以前) は carried_over", () => {
			// 月曜 7/6 朝: jst_time 3日 (金曜早朝) = 金曜の東京セッションが消化済み。
			const monday = Date.parse("2026-07-05T23:30:00Z"); // JST 7/6 08:30
			const out = buildPremarket(
				{
					fetched_at: new Date(monday).toISOString(),
					sox_change_pct: -5.4,
					us_indexes_json: '[{"key":"sox","jst_time":"03日 06:16"}]',
				},
				monday,
				"2026-07-06",
			);
			expect(out.us_close_jst_date).toBe("2026-07-03");
			expect(out.us_session).toBe("carried_over");
		});
		it("通常の週末明け (金曜クローズ = JST 土曜早朝) は fresh", () => {
			const monday = Date.parse("2026-06-28T23:30:00Z"); // JST 6/29(月) 08:30
			const out = buildPremarket(
				{
					fetched_at: new Date(monday).toISOString(),
					us_indexes_json: '[{"key":"sox","jst_time":"27日 06:16"}]',
				},
				monday,
				"2026-06-29",
			);
			expect(out.us_close_jst_date).toBe("2026-06-27");
			expect(out.us_session).toBe("fresh");
		});
		it("行なしは unavailable", () => {
			expect(buildPremarket(null, now, today)).toEqual({
				status: "unavailable",
			});
		});
	});

	describe("buildMargin", () => {
		it("2週分で WoW を出す (floor1)", () => {
			const out = buildMargin([
				{ date: "2026-06-19", long_qty: 150.0, short_qty: 40.0, ratio: 3.75 },
				{ date: "2026-06-12", long_qty: 100.0, short_qty: 50.0, ratio: 2.0 },
			]);
			expect(out.status).toBe("ok");
			expect(out.long_chg).toBe(50);
			expect(out.short_chg).toBe(-10);
			expect(out.prev_date).toBe("2026-06-12");
		});
		it("1週分は WoW null", () => {
			const out = buildMargin([
				{ date: "2026-06-19", long_qty: 150.0, short_qty: 40.0, ratio: 3.75 },
			]);
			expect(out.status).toBe("ok");
			expect(out.long_chg).toBeNull();
			expect(out.prev_date).toBeNull();
		});
		it("行なしは unavailable", () => {
			expect(buildMargin([])).toEqual({ status: "unavailable" });
		});
	});

	describe("buildForced", () => {
		it("stance!=none はスコアを通す", () => {
			const out = buildForced({
				date: "2026-06-29",
				direction: "long",
				stance: "building",
				fuel: 3,
				fire: 3,
				exhaust: 0,
				settle_warning_in_days: 2,
				summary: "🔻投げ警戒 285A [fuel3/fire3/exhaust0]",
			});
			expect(out.status).toBe("ok");
			expect(out.direction).toBe("long");
			expect(out.stance).toBe("building");
			expect(out.settle_warning_in_days).toBe(2);
		});
		it("stance=none は none に潰す", () => {
			expect(buildForced({ date: "2026-06-29", stance: "none" })).toEqual({
				status: "none",
			});
		});
		it("行なしは none", () => {
			expect(buildForced(null)).toEqual({ status: "none" });
		});
	});

	describe("buildDaily", () => {
		// ma は生 daily 行には無く withMovingAverages が付与する (本番 /latest と同じ)。
		// bats は ma 列を注入していたが、Worker 化後は ma を内部計算するのでこのテストもそれに合わせる。
		// 新しい順 (DESC) の系列を close 配列から作る (i=0 が最古)。high/low は close±spread。
		const desc = (
			closes: number[],
			opts: { spread?: number; volume?: number[] } = {},
		): DailyRow[] => {
			const spread = opts.spread ?? 1;
			const asc = closes.map((c, i) => ({
				date: `2026-06-${String(i + 1).padStart(2, "0")}`,
				high: c + spread,
				low: c - spread,
				close: c,
				volume: opts.volume ? opts.volume[i] : 1000,
			}));
			return asc.reverse();
		};

		it("5本未満は insufficient", () => {
			const out = buildDaily(desc([100]));
			expect(out.status).toBe("insufficient");
			expect(out.rows_n).toBe(1);
		});
		it("高値圏 (単調上昇) は range_pct≧80 / ma above", () => {
			// ma_position は ma25 が要る = 25本以上。単調上昇 → close は ma5/ma25 より上 → above。
			const out = buildDaily(
				desc(Array.from({ length: 30 }, (_, i) => 10 + i)),
			);
			expect(out.status).toBe("ok");
			expect(out.range_pct as number).toBeGreaterThanOrEqual(80);
			expect(out.ma_position).toBe("above");
		});
		it("安値圏 (単調下降) は range_pct≦20 / ma below", () => {
			const out = buildDaily(
				desc(Array.from({ length: 30 }, (_, i) => 40 - i)),
			);
			expect(out.range_pct as number).toBeLessThanOrEqual(20);
			expect(out.ma_position).toBe("below");
		});
		it("出来高倍率: 最新が平均の約2倍 → 1.9", () => {
			const vols = [...Array(19).fill(1000), 2000];
			const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
			const out = buildDaily(desc(closes, { volume: vols }));
			// indicators.ts の vol_x_20d テストと同じ: (19*1000+2000)/20=1050, 2000/1050=1.9
			expect(out.vol_x_20d).toBe(1.9);
		});
		it("intraday 未指定なら vol_x_20d_intraday は null", () => {
			const out = buildDaily(
				desc(Array.from({ length: 20 }, (_, i) => 10 + i)),
			);
			expect(out.vol_x_20d_intraday).toBeNull();
		});
		it("intraday: 累積出来高をフル換算して 20日平均で割る", () => {
			const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
			// 全日 volume=1000 → avgVol20d=1000。経過率0.5で当日累積600 → フル換算1200 → 1200/1000=1.2。
			const out = buildDaily(desc(closes, { volume: Array(20).fill(1000) }), {
				cumVolume: 600,
				elapsedFrac: 0.5,
				avgVol20d: 1000,
			});
			expect(out.vol_x_20d_intraday).toBe(1.2);
		});
		it("intraday: 経過率が閾値未満 (寄り直後) は null", () => {
			const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
			const out = buildDaily(desc(closes, { volume: Array(20).fill(1000) }), {
				cumVolume: 50,
				elapsedFrac: 0.05, // < MIN_ELAPSED_FRAC
				avgVol20d: 1000,
			});
			expect(out.vol_x_20d_intraday).toBeNull();
		});
		it("intraday: 累積出来高 null なら vol_x_20d_intraday も null", () => {
			const closes = Array.from({ length: 20 }, (_, i) => 10 + i);
			const out = buildDaily(desc(closes, { volume: Array(20).fill(1000) }), {
				cumVolume: null,
				elapsedFrac: 0.8,
				avgVol20d: 1000,
			});
			expect(out.vol_x_20d_intraday).toBeNull();
		});
		it("15本未満は rsi/atr が null", () => {
			const out = buildDaily(
				desc(Array.from({ length: 14 }, (_, i) => 10 + i)),
			);
			expect(out.rsi_14).toBeNull();
			expect(out.atr_pct).toBeNull();
		});
		it("最新足が2営業日前より古ければ stale (収集が落ちて確定足が欠けた状態)", () => {
			// desc(30本) の最新足は 2026-06-30 (火)。today=07-03(金) の2営業日前は 07-01 →
			// 06-30 < 07-01 で stale。指標は返さない。
			const rows = desc(Array.from({ length: 30 }, (_, i) => 10 + i));
			const out = buildDaily(rows, null, "2026-07-03");
			expect(out).toEqual({
				status: "stale",
				rows_n: 30,
				latest_date: "2026-06-30",
			});
		});
		it("最新足が前営業日なら ok (ザラ場中の正常形)", () => {
			const rows = desc(Array.from({ length: 30 }, (_, i) => 10 + i));
			expect(buildDaily(rows, null, "2026-07-01").status).toBe("ok");
		});
		it("土日はギャップに数えない (金曜足 + 月曜 today は ok)", () => {
			// desc(26本) の最新足は 2026-06-26 (金)。today=06-29(月) の2営業日前は 06-25(木)。
			const rows = desc(Array.from({ length: 26 }, (_, i) => 10 + i));
			expect(buildDaily(rows, null, "2026-06-29").status).toBe("ok");
		});
		it("today 未指定なら鮮度判定しない (後方互換)", () => {
			const rows = desc(Array.from({ length: 30 }, (_, i) => 10 + i));
			expect(buildDaily(rows).status).toBe("ok");
		});
	});

	describe("buildPrices", () => {
		const now = Date.parse("2026-06-20T05:00:00Z");
		it("3時間前は closed", () => {
			const out = buildPrices(
				[
					{
						slot: "regular",
						change_pct: 1.2,
						volume: 100,
						quote_time: "t",
						fetched_at: new Date(now - 3 * 3600_000).toISOString(),
					},
				],
				now,
			);
			expect(out.quote_status).toBe("closed");
			expect(out.status).toBe("ok");
		});
		it("1時間前は live、series を整形", () => {
			const out = buildPrices(
				[
					{
						slot: "regular",
						change_pct: 1.2,
						volume: 100,
						quote_time: "t",
						fetched_at: new Date(now - 3600_000).toISOString(),
					},
				],
				now,
			);
			expect(out.quote_status).toBe("live");
			expect((out.series as unknown[]).length).toBe(1);
		});
		it("行なしは unavailable", () => {
			expect(buildPrices([], now)).toEqual({ status: "unavailable" });
		});
	});
}
