// 監視銘柄定義 — 銘柄一覧の唯一の真のソース (手で編集する出所)。
//
// 以前は config/watchlist.yaml を出所に gen-watchlist.ts が watchlist.gen.ts を生成していたが、
// Worker は元々この .ts を import するだけなので、真のソースを最初から .ts にして二重持ちを解消した。
// yaml の利点だった「コメントで判断根拠を残す」は .ts でもそのまま書けるうえ、型チェックが効く。
//
// このファイルから派生する写経先は GitHub Actions の workflow_dispatch choice options だけで、
// それは `npm run gen:watchlist` (scripts/gen-watchlist.ts) が WATCHLIST から生成する
// (workflow_dispatch.inputs は動的生成できず yml に列挙するしかないため)。銘柄追加は add-ticker skill。
//
// 各フィールド:
//  - code        : 証券コード。
//  - name        : 表示名。
//  - sector      : セクター識別子 (sectors.ts が同一 sector 内で相対強弱を比較)。
//  - sector_role : セクター内の位置づけメモ (memory/tester/inspection 等)。
//  - aliases     : ニュース本文で銘柄判定に使う別名・略称。
//  - keywords    : 銘柄関連と判断する文脈ワード (業界・製品など)。
//  - ir_url      : IR/プレスリリース一覧ページ (人間向けの代表ページ。表示・参照用)。
//  - ir          : 公式IRスクレイプ定義。未設定 (undefined) の銘柄は IR スクレイプ対象外。
//      - site      : IR一覧パーサの振り分けキー (ir-sources.ts の parseList() が選ぶ)。
//          新しい site を足すには ir-sources.ts に専用パーサの実装が要る。
//      - list_url  : パーサが実際に取得・解析する一覧ページ/RSS の URL。ir_url とは目的が違い、
//          パーサが期待する構造のページを指す。
//  - news_url    : 銘柄ページのニュース一覧 (Worker がスクレイプし D1 articles に保存)。
//  - next_earnings_date : 次回決算発表予定日 (YYYY-MM-DD、未確定なら null)。signal-judge が信頼度抑制に使う。
//      公式日程が未開示の時期は前年同期日付ベースの推定値。実行時の値は eod cron が D1 earnings に
//      自動更新するので手動更新は原則不要 (ここの値は人間向けの記録)。過去日が残ると制約なし扱いになる。
//  - fair_per    : 「妥当」と判断する予想PER (倍)。scripts/valuation.ts が必要EPS/必要修正率の逆算に使う。
//      null は逆算スキップ。業種水準や許容PERを踏まえて更新する主観値。

// ticker.ir の形 (site パーサキー + 取得 URL)。外部が使うのは導出後の IrSourceEntry。
interface IrSource {
	site: string;
	list_url: string;
}

export interface Ticker {
	code: string;
	name: string;
	sector: string | null;
	sector_role: string | null;
	aliases: string[];
	keywords: string[];
	ir_url: string;
	ir?: IrSource;
	news_url: string;
	next_earnings_date: string | null;
	fair_per: number | null;
}

export const TICKERS: Ticker[] = [
	{
		code: "285A",
		name: "キオクシアホールディングス",
		sector: "semiconductor",
		sector_role: "memory",
		aliases: ["キオクシア", "KIOXIA", "Kioxia"],
		keywords: ["NAND", "フラッシュメモリ", "SSD", "半導体メモリ", "BiCS"],
		ir_url: "https://www.kioxia.com/ja-jp/about/news.html",
		ir: { site: "kioxia", list_url: "https://www.kioxia.com/ja-jp/news.html" },
		news_url: "https://kabutan.jp/stock/news?code=285A",
		// 1Q (2027/3期): 公式未公表、前年Q1=2025-08-08 ベースの推定。公式日程が出たら上書き。
		next_earnings_date: "2026-08-08",
		// 半導体メモリ。予想EPS未開示時期は逆算スキップ。市況依存が大きく仮に20倍。
		fair_per: 20,
	},
	{
		code: "6857",
		name: "アドバンテスト",
		sector: "semiconductor",
		sector_role: "tester",
		aliases: ["アドバンテスト", "Advantest"],
		keywords: ["半導体テスター", "SoCテスター", "メモリテスター", "HBM"],
		ir_url: "https://www.advantest.com/ja/news",
		ir: { site: "advantest", list_url: "https://www.advantest.com/ja/news/" },
		news_url: "https://kabutan.jp/stock/news?code=6857",
		// 1Q (2027/3期): 公式は「7月」表示のみ、過去3年Q1=7/29,7/31,7/26 から推定。
		next_earnings_date: "2026-07-29",
		// 半導体テスター。現在予想PER ~40倍。高成長テスターとして仮に30倍。
		fair_per: 30,
	},
	{
		code: "6920",
		name: "レーザーテック",
		sector: "semiconductor",
		sector_role: "inspection",
		aliases: ["レーザーテック", "Lasertec"],
		keywords: ["EUV", "マスク検査", "フォトマスク", "半導体検査"],
		ir_url: "https://www.lasertec.co.jp/news/",
		ir: { site: "lasertec", list_url: "https://www.lasertec.co.jp/news/" },
		news_url: "https://kabutan.jp/stock/news?code=6920",
		// 通期 (2026/6期 本決算): 公式は「8月」表示のみ、過去3年通期=8/7 から推定。
		next_earnings_date: "2026-08-07",
		// EUVマスク検査。現在予想PER ~52倍。独占的地位を加味し仮に35倍。
		fair_per: 35,
	},
	{
		code: "6981",
		name: "村田製作所",
		// 厳密には電子部品だが、スマホ/AI需要で半導体地合い(SOX)と連動しやすいため semiconductor に含める。
		sector: "semiconductor",
		sector_role: "components",
		aliases: ["村田製作所", "村田製", "Murata", "muRata"],
		keywords: [
			"MLCC",
			"積層セラミックコンデンサ",
			"電子部品",
			"通信モジュール",
			"スマホ部品",
		],
		ir_url: "https://corporate.murata.com/ja-jp/ir",
		ir: {
			site: "murata",
			// IRニュース専用 RSS (link/title/pubDate を持ち最も堅牢)。
			list_url:
				"https://corporate.murata.com/ja-jp/newsroom/news/irnews/irnews/rssfeed",
		},
		news_url: "https://kabutan.jp/stock/news?code=6981",
		// 1Q (2027/3期): 公式未公表、前年Q1(25.04-06)=2025-07-30 ベースの推定。公式日程が出たら上書き。
		next_earnings_date: "2026-07-30",
		// 電子部品(MLCC)大手。現在予想PER ~67倍。高収益部品株として仮に30倍。
		fair_per: 30,
	},
];

// ── TICKERS から派生する公開シンボル ──
// 既存の import 名 (WATCHLIST / WATCHLIST_NAMES / WATCHLIST_META / IR_SOURCES) は不変。

// コード配列 (ソース順)。
export const WATCHLIST: string[] = TICKERS.map((t) => t.code);

// コード → 表示名。
export const WATCHLIST_NAMES: Record<string, string> = Object.fromEntries(
	TICKERS.map((t) => [t.code, t.name]),
);

// sector 集計用メタ (sectors.ts / market-context.ts が使う)。
export interface WatchlistMeta {
	code: string;
	name: string;
	sector: string | null;
	sector_role: string | null;
}
export const WATCHLIST_META: WatchlistMeta[] = TICKERS.map((t) => ({
	code: t.code,
	name: t.name,
	sector: t.sector,
	sector_role: t.sector_role,
}));

// 公式IRスクレイプ対象 (ir 定義を持つ銘柄のみ)。ir-collect.ts が code/site/list_url を使う。
export interface IrSourceEntry {
	code: string;
	site: string;
	list_url: string;
}
export const IR_SOURCES: IrSourceEntry[] = TICKERS.filter(
	(t): t is Ticker & { ir: IrSource } => t.ir !== undefined,
).map((t) => ({ code: t.code, site: t.ir.site, list_url: t.ir.list_url }));

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("watchlist 派生シンボル", () => {
		it("WATCHLIST は TICKERS の code をソース順で並べる", () => {
			expect(WATCHLIST).toEqual(TICKERS.map((t) => t.code));
		});
		it("WATCHLIST_NAMES は code→name", () => {
			for (const t of TICKERS) expect(WATCHLIST_NAMES[t.code]).toBe(t.name);
		});
		it("IR_SOURCES は ir を持つ銘柄だけを code/site/list_url で出す", () => {
			const withIr = TICKERS.filter((t) => t.ir);
			expect(IR_SOURCES).toHaveLength(withIr.length);
			for (const e of IR_SOURCES) {
				expect(e.site).toBeTruthy();
				expect(e.list_url).toMatch(/^https?:\/\//);
			}
		});
		it("code は重複しない", () => {
			expect(new Set(WATCHLIST).size).toBe(WATCHLIST.length);
		});
	});
}
