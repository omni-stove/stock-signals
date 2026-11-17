// 監視銘柄定義 — 銘柄一覧の唯一の真のソース (手で編集する出所)。
// .ts なのでコメントで判断根拠を残せるうえ、型チェックが効く。
//
// このファイルから派生する写経先は GitHub Actions の workflow_dispatch choice options だけで、
// それは `npm run gen:watchlist` (scripts/gen-watchlist.ts) が WATCHLIST から生成する
// (workflow_dispatch.inputs は動的生成できず yml に列挙するしかないため)。銘柄の追加・削除は update-tickers skill。
//
// 各フィールド:
//  - code        : 証券コード。
//  - name        : 表示名。
//  - sector      : セクター識別子 (sectors.ts が同一 sector 内で相対強弱を比較)。
//  - sector_role : セクター内の位置づけメモ (memory/tester/inspection 等)。
//  - aliases     : 銘柄名の別名・略称。matchTickers が見出しから銘柄を引き当てるのに使う。
//  - keywords    : 銘柄関連と判断する文脈ワード (業界・製品など)。matchTickers が aliases と併用する。
//  - ir_url      : IR/プレスリリース一覧ページ (人間向けの代表ページ。表示・参照用)。
//  - ir          : 公式IRスクレイプ定義。未設定 (undefined) の銘柄は IR スクレイプ対象外。
//      - site      : IR一覧パーサの振り分けキー (ir-sources.ts の parseList() が選ぶ)。
//          新しい site を足すには ir-sources.ts に専用パーサの実装が要る。
//      - list_url  : パーサが実際に取得・解析する一覧ページ/RSS の URL。ir_url とは目的が違い、
//          パーサが期待する構造のページを指す。
//  - news_url    : 銘柄ページのニュース一覧 (Worker がスクレイプし D1 articles に保存)。
//  - edinet_code : EDINET コード (E+5桁)。大量保有報告書の対象会社を引き当てる (large-holdings.ts)。
//  - note        : 判定に毎回効かせたい固定注記 (任意)。living context は IR/news で再生成され
//      密度基準で削られるが、これは人手で据える不変の判断材料 (例「決算先行ピアは MU、時間外が
//      翌朝の寄りを規定」)。judge-context が当該銘柄分だけ JSON に同梱し ticker-brief 等が読む。

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
	edinet_code: string;
	note?: string;
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
		edinet_code: "E35948",
		// 半導体メモリ。予想EPS未開示時期は逆算スキップ。市況依存が大きく仮に20倍。
		// メモリ市況の先行ピアは MU。MU 決算「直後」の時間外反応だけ寄りに効く材料 (通過後は sector /
		// premarket に織り込み済み)。平時はセクタ内相対強弱と自社トピックが主。
		note: "メモリ市況の先行ピアは MU だが、効くのは MU 決算直後の時間外反応のみ。通過後や次回予定は sector/premarket に織り込み済みとして扱い、平時はセクタ内相対強弱と自社トピックで判断する。",
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
		edinet_code: "E01950",
		// 半導体テスター。現在予想PER ~40倍。高成長テスターとして仮に30倍。
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
		edinet_code: "E01991",
		// EUVマスク検査。現在予想PER ~52倍。独占的地位を加味し仮に35倍。
	},
	{
		code: "6976",
		name: "太陽誘電",
		// 電子部品(MLCC)メーカー。スマホ/AI需要で半導体地合い(SOX)と連動しやすく semiconductor に含める。
		sector: "semiconductor",
		sector_role: "components",
		aliases: ["太陽誘電", "TAIYO YUDEN", "Taiyo Yuden"],
		keywords: [
			"MLCC",
			"積層セラミックコンデンサ",
			"電子部品",
			"インダクタ",
			"通信デバイス",
		],
		ir_url: "https://www.yuden.co.jp/ir/",
		// IR一覧パーサ (ir-sources.ts) に太陽誘電用がないため ir 省略 = IR スクレイプ対象外。
		news_url: "https://kabutan.jp/stock/news?code=6976",
		edinet_code: "E01824",
		// 電子部品(MLCC)大手。利益回復途上で現在予想PER ~130倍と高いが、高収益部品株として仮に30倍。
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

// text (ニュース見出し等) に言及がある watchlist 銘柄の code を返す。
// 名前・aliases (銘柄名の別名) と keywords (製品・業界ワード。例: HBM→テスター需要) を
// 小文字化した部分一致で見る。市場テーマニュース (market-news.ts) が「この見出しはどの銘柄の
// 材料か」を引き、当たった銘柄の個別判定を起動するのに使う。
export function matchTickers(text: string): string[] {
	const t = text.toLowerCase();
	return TICKERS.filter((tk) =>
		[tk.name, ...tk.aliases, ...tk.keywords].some((w) =>
			t.includes(w.toLowerCase()),
		),
	).map((tk) => tk.code);
}

// 公式IRスクレイプ対象 (ir 定義を持つ銘柄のみ)。ir-collect.ts が code/site/list_url を使う。
export interface IrSourceEntry {
	code: string;
	site: string;
	list_url: string;
}
export const IR_SOURCES: IrSourceEntry[] = TICKERS.filter(
	(t): t is Ticker & { ir: IrSource } => t.ir !== undefined,
).map((t) => ({ code: t.code, site: t.ir.site, list_url: t.ir.list_url }));

// EDINET コード → 証券コード。
export const EDINET_TO_TICKER: Record<string, string> = Object.fromEntries(
	TICKERS.map((t) => [t.edinet_code, t.code]),
);

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

	describe("matchTickers", () => {
		it("銘柄名・別名の言及を code に引き当てる (大文字小文字をまたぐ)", () => {
			expect(matchTickers("キオクシア、NANDを値上げへ")).toEqual(["285A"]);
			expect(matchTickers("advantest が上方修正")).toEqual(["6857"]);
		});
		it("keywords (製品・業界ワード) でも引き当てる", () => {
			expect(matchTickers("SKハイニックス、HBM増産へ")).toEqual(["6857"]);
		});
		it("製品ワード (MLCC) で電子部品銘柄を引き当てる", () => {
			expect(matchTickers("MLCC市況が回復")).toEqual(["6976"]);
		});
		it("複数銘柄に当たる見出しはソース順で全て返す", () => {
			expect(matchTickers("キオクシアとアドバンテストが上昇")).toEqual([
				"285A",
				"6857",
			]);
		});
		it("言及がなければ空配列", () => {
			expect(matchTickers("東京株式（前引け）＝反発")).toEqual([]);
		});
	});
}
