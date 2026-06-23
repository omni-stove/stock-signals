// 自動生成ファイル — 直接編集しないこと。
//
// 出所は config/watchlist.yaml。`node scripts/gen-watchlist.ts` (= npm run gen:watchlist)
// が yaml の tickers[] から WATCHLIST / WATCHLIST_NAMES / WATCHLIST_META を生成して書き出す。
// 銘柄を増減するときは yaml を直して gen を走らせる (このファイルは手で触らない)。
//
// Worker は読み取り専用FSで yaml を読めないため、ビルド時に値を焼き込むのが目的。
// timeseries.ts がこのファイルから re-export し、Worker 内の各モジュールは
// 従来どおり timeseries から WATCHLIST / WATCHLIST_NAMES を import する。
// WATCHLIST_META は sectors.ts (地合いのセクター集計) が sector / sector_role を読むために使う。

// ローカル config/watchlist.yaml の tickers[].code と対応 (順序込み)。
export const WATCHLIST: string[] = ["285A", "6857", "6920", "6981"];

// コード → 表示名 (watchlist.yaml の name と対応)。
export const WATCHLIST_NAMES: Record<string, string> = {
	"285A": "キオクシアホールディングス",
	"6857": "アドバンテスト",
	"6920": "レーザーテック",
	"6981": "村田製作所",
};

// 銘柄メタ (sector 集計用)。sector / sector_role は未設定なら null。
export interface WatchlistMeta {
	code: string;
	name: string;
	sector: string | null;
	sector_role: string | null;
}
export const WATCHLIST_META: WatchlistMeta[] = [
	{ code: "285A", name: "キオクシアホールディングス", sector: "semiconductor", sector_role: "memory" },
	{ code: "6857", name: "アドバンテスト", sector: "semiconductor", sector_role: "tester" },
	{ code: "6920", name: "レーザーテック", sector: "semiconductor", sector_role: "inspection" },
	{ code: "6981", name: "村田製作所", sector: "semiconductor", sector_role: "components" },
];
