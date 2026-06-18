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
	SLACK_WEBHOOK_URL?: string;
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
