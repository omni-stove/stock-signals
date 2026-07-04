// Cloudflare Worker: 全モジュール共通の Env (バインディング + Secrets/Vars) 型。
// index.ts / github-dispatch.ts / ir-sources.ts が共有する。

export interface Env {
	DB: D1Database;
	ARTICLES: R2Bucket;
	USER_AGENT: string;
	MIN_INTERVAL_MS: string;
	// Slack Incoming Webhook URL (Secret)。未設定なら通知をスキップ (取得自体は動く)。
	//   設定: npx wrangler secret put SLACK_WEBHOOK_URL
	//   dev:  worker/.dev.vars に SLACK_WEBHOOK_URL="https://hooks.slack.com/..." と書く
	//   judge(レポート)通知の送り先でもある。
	SLACK_WEBHOOK_URL?: string;
	// 新規IR通知専用の Slack Webhook URL (Secret)。IR をレポートと別チャンネルに出すための分離。
	// 未設定なら SLACK_WEBHOOK_URL にフォールバック (= 同一チャンネル)。
	//   設定: npx wrangler secret put SLACK_IR_WEBHOOK_URL
	SLACK_IR_WEBHOOK_URL?: string;
	// 新規ニュース通知専用の Slack Webhook URL (Secret)。銘柄ニュース/市場テーマニュースの新着を
	// IR・レポートと別チャンネルに出すための分離。未設定なら通知をスキップ (取得自体は動く)。
	//   設定: npx wrangler secret put SLACK_NEWS_WEBHOOK_URL
	SLACK_NEWS_WEBHOOK_URL?: string;
	// 重要イベント (決算/FOMC/日銀/SQ/リバランス) リマインダー専用の Slack Webhook URL (Secret)。
	// 未設定なら SLACK_WEBHOOK_URL にフォールバック (= レポートと同一チャンネル)。
	//   設定: npx wrangler secret put SLACK_REMINDER_WEBHOOK_URL
	SLACK_REMINDER_WEBHOOK_URL?: string;
	// Slack スラッシュコマンド /crash の署名検証シークレット (Secret)。Slack App の
	// Basic Information → Signing Secret。/slack/* ルートはこの値で受信を検証する
	// (Bearer 認証は通さないので、なりすまし防止はこの署名検証が担う)。未設定なら
	// /slack/* は 503 を返す (検証なしで dispatch を撃てる口を開けないため)。
	//   設定: npx wrangler secret put SLACK_SIGNING_SECRET
	SLACK_SIGNING_SECRET?: string;
	// Slack Bot トークン (xoxb-, Secret)。解析結果を chat.postMessage で投稿し、返ってくる ts を
	// D1 (slack_threads) に控える→スレッド返信から銘柄を復元する、ための対話機能で使う。
	// 必要スコープ: chat:write (投稿), channels:history (返信受信/スレッド履歴取得)。
	// 未設定なら /slack/post は 503、/slack/events は no-op (返信対話が無効になるだけ)。
	//   設定: npx wrangler secret put SLACK_BOT_TOKEN
	SLACK_BOT_TOKEN?: string;
	// 解析結果/返答の投稿先 Slack チャンネルID (例 C0123ABCD)。/slack/post で channel 省略時に使う。
	// signal-judge/crash-scenario の投稿先 = 返信を受けるチャンネル。Secret でも Var でも可。
	//   設定: npx wrangler secret put SLACK_REPLY_CHANNEL  (または wrangler.toml の [vars])
	SLACK_REPLY_CHANNEL?: string;
	// 銘柄コンテキスト (contexts テーブル) 更新時に living document 全文を投稿する Slack チャンネルID。
	// 人間が普段見ない内部ストアの覗き窓。解析結果の SLACK_REPLY_CHANNEL とは別チャンネルに分離する。
	// 未設定なら通知をスキップ。
	//   設定: npx wrangler secret put SLACK_CONTEXT_CHANNEL  (または wrangler.toml の [vars])
	SLACK_CONTEXT_CHANNEL?: string;
	// 全エンドポイント (/health を除く) の簡易認証トークン (Secret)。未設定なら認証なし (dev用)。
	//   設定: npx wrangler secret put SYNC_TOKEN
	//   送り方は Authorization: Bearer <token> ヘッダ、または ?token=<token> クエリのどちらでも可。
	//   ヘッダ推奨 (URL がログ/履歴に残らない)。/run /dispatch-test /test-slack /latest /pull /pull-news が対象。
	SYNC_TOKEN?: string;
	// 新規IR/ニュース取得時に GitHub Actions (signal-report) を repository_dispatch で起動するための
	// GitHub App (omnistove-internal-auth) 認証情報。App秘密鍵で JWT を署名し
	// installation token に交換して叩く。3つ揃っていなければ発火しない (取得自体は動く)。
	//   GH_APP_ID          … App ID (数値)
	//   GH_APP_PRIVATE_KEY … App の private key (.pem の中身、PKCS#8 PEM)。Secret。
	//   GH_APP_INSTALL_ID  … omni-stove org への installation id (数値)
	//     設定: npx wrangler secret put GH_APP_PRIVATE_KEY  (ID系は vars でも secret でも可)
	GH_APP_ID?: string;
	GH_APP_PRIVATE_KEY?: string;
	GH_APP_INSTALL_ID?: string;
	// 発火先リポジトリ (owner/repo)。未設定なら下記デフォルトを使う。
	GITHUB_REPO?: string;
}
