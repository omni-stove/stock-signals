---
name: ir-report
description: For a single ticker given as argument, pull newly-fetched IR articles from the Worker (since the last cursor), judge each one (buy/sell/hold, swing horizon), and rewrite that ticker's standing "IR report" GitHub Issue body, then notify Slack. One-shot; designed for GitHub Actions cron.
---

# ir-report

GitHub Actions から1回だけ呼ばれるワンショット skill。引数で渡された1銘柄について、
前回処理した時刻 (カーソル) より後に取得された新規IRだけを Worker から引き、スイング前提で
判断し、その銘柄の常設Issue (=企業レポート) の本文を丸ごと更新する。

判断基準は `analyze-ticker` skill と同一思想 (SWING = 数日〜3週間保有)。

## Invocation

```
/ir-report 285A
/ir-report 285A 6857   # 複数指定時は各銘柄について手順1-7を独立に繰り返す
```

引数 `<ticker>...` がこのレポートの対象銘柄 (証券コード、スペース区切りで複数可)。
現状 IR取得対応は 285A のみ。複数渡された場合は1銘柄ずつ順に処理する。

## 必要な環境変数

- `WORKER_URL` … Cloudflare Worker のベースURL。必須。
- `SYNC_TOKEN` … Worker が `/pull` で要求するトークン。設定されている場合のみ。
- `SLACK_WEBHOOK_URL` … 判断付き通知の送り先。未設定なら Slack通知はスキップ。
- `GH_TOKEN` / `GITHUB_TOKEN` … `gh` 用。

## 手順

### 1. 対象銘柄のメタを読む

`config/watchlist.yaml` から `<ticker>` のエントリを読み、`name` / `next_earnings_date` / `fair_per` /
`sector` をキャッシュする。`next_earnings_date` から今日基準の `days_to_earnings` を計算する。

### 2. 既存Issueとカーソルを取得する

```
gh issue list --label ir-report --label "ticker:<ticker>" --state open --json number,body --limit 1
```

- 見つかれば、本文 (`body`) 末尾の機械可読カーソルを取り出す:
  `<!-- cursor: last_fetched_at=YYYY-MM-DDTHH:MM:SS.sssZ -->`
  正規表現 `last_fetched_at=([^ ]+)` で値を取る。これが `since`。Issue番号も覚える。
- 見つからなければ `since` は無し。後で新規作成する。

### 3. Worker から新規IRを引く

```
curl -s "$WORKER_URL/pull?code=<ticker>&since=<last_fetched_at>&limit=20${SYNC_TOKEN:+&token=$SYNC_TOKEN}"
```

- `since` が無い (初回) ときは `&since=...` を付けず `limit=5` で引く。
- レスポンスは `{ ok, count, rows: [{ url, title, published_at, ir_category, fetched_at, body }] }`。
  `rows` は `fetched_at` 昇順。

`count == 0` なら新規IRなし → 何もせず終了。Issue更新もSlack通知もしない。

### 4. 価格・日足の文脈を引く

```
curl -s "$WORKER_URL/latest?kind=prices&code=<ticker>&n=20"
curl -s "$WORKER_URL/latest?kind=daily&code=<ticker>&n=20"
```

`analyze-ticker` の `## Price context` / `## Daily context` と同じ読み方をする:
- prices: 直近の `change_pct` / `volume` / `pts_price` から織り込み済みかを見る。場外は `pts_price` が live。
- daily: 5MA/25MA の位置、20日レンジ内の位置、出来高トレンド。
- データが取れない/薄いときは、その旨を rationale に明記して材料なしで進める。

### 5. 各新規IRを判断する

`rows` の各IRについて、以下のスキーマで判断オブジェクトを作る:

```json
{
  "fetched_at": "<そのIRのfetched_at。カーソル更新に使う>",
  "published_at": "2026-06-18",
  "ir_category": "holdings|corporate|business|personal|other",
  "title": "...",
  "url": "...",
  "signal": "buy | sell | hold",
  "confidence": "low | medium | high",
  "horizon": "swing",
  "rationale": "<2-3行・日本語: なぜこのシグナルか。industry/own-company を区別。価格文脈に触れる>",
  "evidence_quotes": ["<本文からの引用 最大2>"],
  "risks": "<1行: 何が起きたらこの判断が崩れるか。決算近接ならN日と明記>",
  "days_to_earnings": <整数 or null>
}
```

判断ルール:
- holdings (持株会社=適時開示) を最重要に扱う。
- 価格にもう織り込まれていそうな材料 (急騰後の好材料 / PTSプレミアム>+3%) は `buy` ではなく `hold` 寄り。
- 1記事だけで `high` を付けない。`high` は複数記事の裏取り or 決算/ガイダンスが要る。
- 決算 ≤5日は confidence を `low`、6-14日は `medium` にキャップ。記事そのものが決算発表なら例外。
- `days_to_earnings` が負なら null 扱い・制約なし、risks に「earnings date stale」。
- 陳腐化した二番煎じは `hold` / low。

### 6. Issue本文を再生成して上書きする

本文は常に全体を作り直して上書きする。コメントは使わない。構成:

```markdown
# [<ticker> <name>] IRレポート

最終更新: <今日のISO日時 (JST)>  |  対象: スイング (数日〜3週間)

## 🧭 最新の総合判断

**<buy/sell/hold>** ・ confidence: **<low/medium/high>**

<最新の総合観: 直近の新規IR群を踏まえた1-3行のまとめ。決算まで<days>日なら明記。>

## 🆕 今回の新規IR (<count>件)

### <published_at> [<ir_category日本語ラベル>] <title>
- シグナル: **<signal>** / <confidence>
- 根拠: <rationale>
- リスク: <risks>
- 出典: <url>

<...新規IRの数だけ繰り返し...>

## 🗂 直近の履歴

<過去分のうち直近 5件だけ1行サマリで残す (published_at / signal / title)。
 前回本文の履歴セクションを先頭に今回分を足し、5件を超えたら末尾を捨てる。>

---
<!-- cursor: last_fetched_at=<今回処理した rows の最大 fetched_at> -->
<!-- managed-by: ir-report skill. このIssueは自動更新されます。手で本文を編集しないでください。 -->
```

`ir_category` 日本語ラベル: holdings→📢適時開示 / corporate→🏢企業情報 /
business→🔧製品・事業 / personal→🛒個人向け / other→📄IR。

更新コマンド:
- 既存Issueあり: `gh issue edit <number> --body-file <tmpfile>`
- 既存Issueなし: `gh issue create --title "[<ticker> <name>] IRレポート" --body-file <tmpfile> --label ir-report --label "ticker:<ticker>"`
  ラベルが無ければ `gh label create ir-report` / `gh label create "ticker:<ticker>"` を先に実行。失敗は握りつぶさず注記。

カーソル `last_fetched_at` には、今回処理した `rows` の最大 `fetched_at` を入れる。次回 `since`
がそこから再開し、同じIRを二度判断しない。

### 7. Slack通知

`SLACK_WEBHOOK_URL` があれば、本文更新の要点を1通POSTする:

```
curl -s -X POST "$SLACK_WEBHOOK_URL" -H 'Content-Type: application/json' -d '{
  "text": "🧭 <ticker> <name> IRレポート更新: 総合 <signal>/<confidence> ・新規<count>件",
  "blocks": [ ...header + 各新規IRの signal/title/url を section で... ]
}'
```

holdings を先頭に寄せて強調する。`SLACK_WEBHOOK_URL` 未設定なら通知はスキップして終了。

## 出力スタイル (stdout)

冗長な実況は不要。1行サマリのみ:
```
285A new=2 → buy/medium (holdings決算上振れ) issue#12 updated, slack ok
```
新規0件のときは `285A new=0 (no update)` の1行で終える。

## Anti-patterns

- 新規0件なのに Issue を更新する / Slack を鳴らす (ノイズ)。
- 新規があるのに Issue 更新やカーソル更新を忘れる。
- コメントを乱発する。本設計は本文上書きが正。
- 1記事で `high`、価格目標の捏造、「buy now」等の指示的表現。
- `horizon: "intraday"`。
