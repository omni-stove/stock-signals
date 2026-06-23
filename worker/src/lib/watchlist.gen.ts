// 自動生成ファイル — 直接編集しないこと。
//
// 出所は config/watchlist.yaml。`node scripts/gen-watchlist.ts` (= npm run gen:watchlist)
// が yaml の tickers[] から WATCHLIST / WATCHLIST_NAMES を生成してここに書き出す。
// 銘柄を増減するときは yaml を直して gen を走らせる (このファイルは手で触らない)。
//
// Worker は読み取り専用FSで yaml を読めないため、ビルド時に値を焼き込むのが目的。
// timeseries.ts がこのファイルから re-export し、Worker 内の各モジュールは
// 従来どおり timeseries から WATCHLIST / WATCHLIST_NAMES を import する。

// ローカル config/watchlist.yaml の tickers[].code と対応 (順序込み)。
export const WATCHLIST: string[] = ["285A", "6857", "6920", "6981"];

// コード → 表示名 (watchlist.yaml の name と対応)。
export const WATCHLIST_NAMES: Record<string, string> = {
	"285A": "キオクシアホールディングス",
	"6857": "アドバンテスト",
	"6920": "レーザーテック",
	"6981": "村田製作所",
};
