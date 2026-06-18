// Cloudflare Worker: stock-signals 収集 (PoC: fetch-ir)
//
// ローカルの scripts/fetch-ir.ts と同じ解析ロジックで kioxia の公式IRを取得し、
// 記事本文を R2 (ARTICLES) に、メタ+重複排除キーを D1 (DB) に保存する。
//
// エントリポイント:
//   - scheduled(): Cron Trigger 発火時。ir定義の全銘柄を取得。
//   - fetch():     /run?code=285A&limit=3 で手動起動 (dev検証/オンデマンド用)。
//                  /health で疎通確認。
//
// 解析対象 (kioxia): https://www.kioxia.com/ja-jp/news.html
//   <a class="cmp-button"> の href が記事URL、.cmp-button__text がタイトル。
//   日付は URL の YYYYMMDD、カテゴリは URL パスから判別。
//   事業会社(kioxia.com)と持株会社(kioxia-holdings.com=上場主体)の両方が並ぶ。

import * as cheerio from "cheerio";
import { collectTimeseries } from "./timeseries";

export interface Env {
  DB: D1Database;
  ARTICLES: R2Bucket;
  USER_AGENT: string;
  MIN_INTERVAL_MS: string;
  // Slack Incoming Webhook URL (Secret)。未設定なら通知をスキップ (取得自体は動く)。
  //   設定: npx wrangler secret put SLACK_WEBHOOK_URL
  //   dev:  worker/.dev.vars に SLACK_WEBHOOK_URL="https://hooks.slack.com/..." と書く
  SLACK_WEBHOOK_URL?: string;
  // ローカル連携 /dump の簡易認証トークン (Secret)。未設定なら認証なし (dev用)。
  //   設定: npx wrangler secret put SYNC_TOKEN
  SYNC_TOKEN?: string;
  // 新規IR取得時に GitHub Actions (ir-report) を repository_dispatch で起動するための
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

// ── GitHub App 認証 (repository_dispatch 発火用) ─────────────────────────────
// Cloudflare Workers の Web Crypto (crypto.subtle) で RS256 JWT を署名し、
// installation access token に交換する。外部ライブラリ不要。

function b64url(data: ArrayBuffer | string): string {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// PKCS#8 PEM (-----BEGIN PRIVATE KEY-----) を CryptoKey に取り込む。
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// App JWT を生成 (iat を少し過去に、exp は最大10分以内)。
async function makeAppJwt(appId: string, pem: string, nowSec: number): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }),
  );
  const key = await importPrivateKey(pem);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "stock-signals-collector",
};

// App JWT → installation access token に交換する。
async function getInstallationToken(jwt: string, installId: string): Promise<string> {
  const res = await fetch(
    `https://api.github.com/app/installations/${installId}/access_tokens`,
    { method: "POST", headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}` } },
  );
  if (!res.ok) throw new Error(`installation token: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

// 新規IRを取得したとき、GitHub Actions の ir-report ワークフローを repository_dispatch で起動する。
// cron で当てずっぽうに起動して0件を引く構造を避け、「新規があるときだけ」LLMを動かす。
// App 認証情報が揃っていなければ no-op (best-effort、発火失敗で収集は止めない)。
async function dispatchIrReport(env: Env, tickers: string[]): Promise<void> {
  if (tickers.length === 0) return;
  if (!env.GH_APP_ID || !env.GH_APP_PRIVATE_KEY || !env.GH_APP_INSTALL_ID) return;
  const repo = env.GITHUB_REPO || "omni-stove/stock-signals";
  try {
    // Workers 内は Date.now() が使える (collectOne 等でも new Date() を使用済み)。
    const nowSec = Math.floor(Date.now() / 1000);
    const jwt = await makeAppJwt(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY, nowSec);
    const token = await getInstallationToken(jwt, env.GH_APP_INSTALL_ID);
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: { ...GH_HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // event_type は workflow の on.repository_dispatch.types と一致させる。
      // client_payload で新規があった銘柄を渡す (ir-report が対象を絞れる)。
      body: JSON.stringify({ event_type: "ir-fetched", client_payload: { tickers } }),
    });
    if (!res.ok) {
      console.error(`dispatch failed: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (e) {
    console.error(`dispatch error: ${(e as Error).message}`);
  }
}

// ir定義 (ローカルの config/sources.yaml の ir 相当。PoC ではコードに直書き)。
const IR_SOURCES = [
  { code: "285A", site: "kioxia", list_url: "https://www.kioxia.com/ja-jp/news.html" },
];

const DEFAULT_LIMIT = 20;

type ListItem = { url: string; title: string; date: string; category: string };

function dateFromUrl(url: string): string {
  const m = url.match(/\/(\d{4})(\d{2})(\d{2})-\d+\.html/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function categoryFromUrl(url: string): string {
  if (url.includes("kioxia-holdings.com")) return "holdings";
  if (url.includes("/about/news/")) return "corporate";
  if (url.includes("/business/news/")) return "business";
  if (url.includes("/personal/news/")) return "personal";
  return "other";
}

// kioxia ニュース一覧パーサ (scripts/fetch-ir.ts の parseKioxiaList と同じ)。
function parseKioxiaList(html: string, baseUrl: string): ListItem[] {
  const $ = cheerio.load(html);
  const out: ListItem[] = [];
  const seenUrl = new Set<string>();
  $("a.cmp-button").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    const url = new URL(href, baseUrl).toString();
    const date = dateFromUrl(url);
    if (!date) return;
    if (seenUrl.has(url)) return;
    seenUrl.add(url);
    const title = $(a).find(".cmp-button__text").text().trim() || $(a).text().trim();
    if (!title) return;
    out.push({ url, title, date, category: categoryFromUrl(url) });
  });
  return out;
}

function parseKioxiaArticle(html: string): { title: string; body: string } {
  const $ = cheerio.load(html);
  const title = $("h1").first().text().trim() || $("title").text().trim();
  const body =
    $("main").text().trim() ||
    $("article").text().trim() ||
    $(".cmp-text").text().trim() ||
    $("body").text().trim();
  return { title, body: body.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() };
}

// 全ソース UTF-8 (調査済) なので TextDecoder で十分。iconv 不要。
async function fetchText(url: string, env: Env): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": env.USER_AGENT },
    // Cloudflare のリクエストには Worker 既定のタイムアウトが効く
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder("utf-8").decode(buf);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 既に D1 に存在する URL か (= seen.txt 相当の重複排除)。
async function isSeen(env: Env, url: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM articles WHERE url = ? LIMIT 1").bind(url).first();
  return row !== null;
}

async function saveArticle(
  env: Env,
  meta: {
    url: string;
    ticker: string;
    source: string;
    title: string;
    published_at: string;
    ir_category: string;
    body: string;
  },
): Promise<void> {
  const fetched_at = new Date().toISOString();
  // R2 キー: ticker/日付-ハッシュ.json (一覧しやすい構造)。
  const r2_key = `${meta.ticker}/${meta.published_at}-${hash(meta.url)}.json`;
  const payload = JSON.stringify({ ...meta, fetched_at }, null, 2);
  await env.ARTICLES.put(r2_key, payload, {
    httpMetadata: { contentType: "application/json" },
  });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO articles
      (url, ticker, source, title, published_at, ir_category, r2_key, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      meta.url,
      meta.ticker,
      meta.source,
      meta.title,
      meta.published_at,
      meta.ir_category,
      r2_key,
      fetched_at,
    )
    .run();
}

// URL → 短いハッシュ (R2キー用)。crypto.subtle は async なので簡易版を同期で。
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// IRカテゴリ → Slack表示用の見出し。holdings(適時開示)を最も目立たせる。
function categoryHeading(cat: string): string {
  switch (cat) {
    case "holdings":
      return "📢 適時開示 (持株会社)";
    case "corporate":
      return "🏢 企業情報";
    case "business":
      return "🔧 製品・事業";
    case "personal":
      return "🛒 個人向け";
    default:
      return "📄 IR";
  }
}

type NotifyItem = { ticker: string; title: string; url: string; date: string; category: string };

// 新規取得したIRを Slack に通知する。Webhook未設定なら何もしない。
// 1リクエストで全件まとめて送る (1記事1メッセージにすると場中に連投になるため)。
async function notifySlack(env: Env, items: NotifyItem[]): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL || items.length === 0) return;

  // holdings(適時開示) を先頭に寄せて目立たせる。
  const order = (c: string) => (c === "holdings" ? 0 : 1);
  const sorted = [...items].sort((a, b) => order(a.category) - order(b.category));

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `🆕 新規IR ${items.length}件 (${sorted[0].ticker})`, emoji: true },
    },
  ];
  for (const it of sorted) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${categoryHeading(it.category)}  \`${it.date}\`\n<${it.url}|${it.title}>`,
      },
    });
  }

  // フォールバック text (通知プレビュー用)。
  const fallback = sorted.map((it) => `[${it.category}] ${it.date} ${it.title}`).join("\n");

  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: fallback, blocks }),
    });
    if (!res.ok) {
      console.error(`slack notify failed: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (e) {
    // 通知失敗は収集を止めない (best-effort)。
    console.error(`slack notify error: ${(e as Error).message}`);
  }
}

// 1ソースを取得。新しい順に最大 limit 件、未取得のものだけ本文取得→保存。
async function collectOne(
  env: Env,
  src: (typeof IR_SOURCES)[number],
  limit: number,
): Promise<{ found: number; written: number; skipped: number }> {
  const listHtml = await fetchText(src.list_url, env);
  let items = parseKioxiaList(listHtml, src.list_url);
  items.sort((a, b) => b.date.localeCompare(a.date));
  const total = items.length;
  items = items.slice(0, limit);

  const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
  let skipped = 0;
  const fresh: NotifyItem[] = []; // 今回新規に保存した記事 (Slack通知対象)
  for (const it of items) {
    if (await isSeen(env, it.url)) {
      skipped++;
      continue;
    }
    await sleep(interval);
    try {
      const artHtml = await fetchText(it.url, env);
      const parsed = parseKioxiaArticle(artHtml);
      const title = parsed.title || it.title;
      await saveArticle(env, {
        url: it.url,
        ticker: src.code,
        source: `ir:${src.site}:${src.code}`,
        title,
        published_at: it.date,
        ir_category: it.category,
        body: parsed.body,
      });
      fresh.push({ ticker: src.code, title, url: it.url, date: it.date, category: it.category });
    } catch (e) {
      console.error(`article error ${it.url}: ${(e as Error).message}`);
    }
  }
  // 新規があればまとめてSlack通知 (Webhook未設定なら no-op)。
  await notifySlack(env, fresh);
  return { found: total, written: fresh.length, skipped };
}

async function collectAll(
  env: Env,
  codeFilter: string | null,
  limit: number,
): Promise<{ results: Record<string, unknown>; freshTickers: string[] }> {
  const sources = IR_SOURCES.filter((s) => !codeFilter || s.code === codeFilter);
  const results: Record<string, unknown> = {};
  const freshTickers: string[] = []; // 今回 written > 0 だった銘柄 (= ir-report を起動すべき対象)
  for (const src of sources) {
    try {
      const r = await collectOne(env, src, limit);
      results[src.code] = r;
      if (r.written > 0) freshTickers.push(src.code);
    } catch (e) {
      results[src.code] = { error: (e as Error).message };
    }
  }
  return { results, freshTickers };
}

// 発火した cron 式 → 取得種別。wrangler.toml の [triggers] crons と対応させること。
// Cloudflare の cron trigger 上限は5個。daily と fundamentals は引け後1日1回なので、
// 1本の cron (eod = end of day) にまとめて両方実行し、5個に収める。
const CRON_KIND: Record<string, "ir" | "prices" | "eod"> = {
  "30 23 * * *": "ir",
  "30 3 * * *": "ir",
  "30 9 * * *": "ir",
  "*/5 0-6 * * *": "prices",
  "0 7 * * *": "eod", // JST 16:00 引け後: daily + fundamentals をまとめて取得
};

export default {
  // Cron Trigger 発火時。event.cron でどの cron が鳴ったか判別して種別を振り分ける。
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const kind = CRON_KIND[event.cron] ?? "ir"; // 未知の cron は IR にフォールバック
    if (kind === "ir") {
      const { results, freshTickers } = await collectAll(env, null, DEFAULT_LIMIT);
      console.log("scheduled ir done:", JSON.stringify(results), "fresh:", freshTickers.join(","));
      // 新規IRがあった銘柄だけ ir-report (GitHub Actions) を起動する。0件なら発火しない。
      await dispatchIrReport(env, freshTickers);
      return;
    }
    if (kind === "eod") {
      // 引け後の1日1回。daily と fundamentals を順に取得 (旧 2本の cron を統合)。
      const d = await collectTimeseries(env, "daily", null);
      const f = await collectTimeseries(env, "fundamentals", null);
      console.log("scheduled eod done:", JSON.stringify({ daily: d, fundamentals: f }));
      return;
    }
    const res = await collectTimeseries(env, kind, null);
    console.log(`scheduled ${kind} done:`, JSON.stringify(res));
  },

  // 手動起動 (dev検証/オンデマンド)。
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // /dispatch-test?code=285A
    //   App認証→repository_dispatch の疎通確認用。IR取得はせず、指定銘柄で強制発火する。
    //   新規IRの有無に関係なく ir-report (workflow_dispatch相当) を起動できるので、
    //   発火経路 (JWT署名→installation token→dispatch) のE2E確認に使う。
    if (url.pathname === "/dispatch-test") {
      const code = url.searchParams.get("code") || "285A";
      const configured = !!(env.GH_APP_ID && env.GH_APP_PRIVATE_KEY && env.GH_APP_INSTALL_ID);
      await dispatchIrReport(env, [code]);
      return Response.json({ ok: true, dispatched: configured, ticker: code });
    }

    // /run?kind=ir|prices|daily|fundamentals&code=285A[&limit=N]
    //   kind 省略時は ir (後方互換)。time系列は limit を無視し watchlist 全件取得。
    if (url.pathname === "/run") {
      const code = url.searchParams.get("code");
      const kind = url.searchParams.get("kind") || "ir";
      if (kind === "ir") {
        const limit = parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT), 10);
        const { results, freshTickers } = await collectAll(env, code, limit);
        // 手動 /run では既定で発火しない (検証で叩いても Actions を起動させないため)。
        // &dispatch=1 を付けたときだけ、新規があれば ir-report を起動する。
        if (url.searchParams.get("dispatch") === "1") await dispatchIrReport(env, freshTickers);
        return Response.json({ ok: true, kind, result: results, fresh: freshTickers });
      }
      if (kind === "prices" || kind === "daily" || kind === "fundamentals") {
        const res = await collectTimeseries(env, kind, code);
        return Response.json({ ok: true, kind, result: res });
      }
      return Response.json({ ok: false, error: `unknown kind: ${kind}` }, { status: 400 });
    }

    // /dump?kind=prices|daily|fundamentals&code=285A[&token=...]
    //   ローカル連携用。D1 の全行を「ローカル jsonl と同じ列・同じ並び (古い順)」で返す。
    //   ローカルの scripts/sync-from-d1.ts がこれを GET して data/<kind>/<code>.jsonl を
    //   置き換える。本番(公開URL)では SYNC_TOKEN を要求する (dev/未設定なら認証なし)。
    if (url.pathname === "/dump") {
      if (env.SYNC_TOKEN && url.searchParams.get("token") !== env.SYNC_TOKEN) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const code = url.searchParams.get("code");
      const kind = url.searchParams.get("kind") || "";

      // jsonl の列順に合わせる (読み手の最終行/全行パースがそのまま動くように)。
      const DUMP: Record<string, { table: string; order: string; cols: string }> = {
        prices: {
          table: "prices",
          order: "fetched_at ASC",
          cols: "fetched_at, source, ticker, price, change, change_pct, volume, quote_time, pts_price, pts_time",
        },
        daily: {
          table: "daily",
          order: "date ASC",
          cols: "fetched_at, source, ticker, date, open, high, low, close, change, change_pct, volume",
        },
        fundamentals: {
          table: "fundamentals",
          order: "fetched_at ASC",
          cols: "fetched_at, source, ticker, per, pbr, dividend_yield, forecast_eps, forecast_period, actual_eps, actual_period",
        },
      };
      const q = DUMP[kind];
      if (!q) return Response.json({ ok: false, error: `unknown kind: ${kind}` }, { status: 400 });

      const stmt = code
        ? env.DB.prepare(`SELECT ${q.cols} FROM ${q.table} WHERE ticker = ? ORDER BY ${q.order}`).bind(code)
        : env.DB.prepare(`SELECT ${q.cols} FROM ${q.table} ORDER BY ticker, ${q.order}`);
      const { results } = await stmt.all();
      // 1行1JSON (jsonl) で返す。ローカルはこれをそのまま書き出せる。
      const body = (results as Record<string, unknown>[]).map((r) => JSON.stringify(r)).join("\n");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    }

    // /latest?kind=ir|prices|daily|fundamentals&code=285A&n=10
    //   D1 から最新行を返す (動作確認/ローカル連携用)。kind 省略時は ir。
    if (url.pathname === "/latest") {
      const code = url.searchParams.get("code") || "285A";
      const n = parseInt(url.searchParams.get("n") || "10", 10);
      const kind = url.searchParams.get("kind") || "ir";

      // 種別 → (テーブル, 並び順カラム, 取得カラム)。SQL 識別子はホワイトリストのみ。
      const LATEST: Record<string, { table: string; order: string; cols: string }> = {
        ir: { table: "articles", order: "published_at", cols: "url, title, published_at, ir_category, r2_key, fetched_at" },
        prices: { table: "prices", order: "fetched_at", cols: "ticker, slot, price, change, change_pct, volume, quote_time, pts_price, fetched_at" },
        daily: { table: "daily", order: "date", cols: "ticker, date, open, high, low, close, change, change_pct, volume" },
        fundamentals: { table: "fundamentals", order: "date", cols: "ticker, date, per, pbr, forecast_eps, forecast_period, actual_eps, actual_period, fetched_at" },
      };
      const q = LATEST[kind];
      if (!q) return Response.json({ ok: false, error: `unknown kind: ${kind}` }, { status: 400 });

      const { results } = await env.DB.prepare(
        `SELECT ${q.cols} FROM ${q.table} WHERE ticker = ? ORDER BY ${q.order} DESC LIMIT ?`,
      )
        .bind(code, n)
        .all();
      return Response.json({ ok: true, kind, rows: results });
    }

    // /pull?code=285A&since=<ISO8601>&limit=N[&token=...]
    //   「since より後に取得した未処理IRだけ」を本文(R2)込みで、古い順 (fetched_at ASC) に返す。
    //   GitHub Actions (ir-report) が前回処理カーソル last_fetched_at を since に渡し、
    //   新規IRだけを判断対象として引くためのエンドポイント。/latest はメタのみ・published_at 順
    //   なのに対し、こちらは「判断に必要な本文」を同梱し「取りこぼさないカーソル順」で返す。
    //   since 省略時は直近 limit 件 (= 初回 / カーソル未確立時のフォールバック)。
    //   公開URLでは /dump と同様 SYNC_TOKEN を要求する (dev/未設定なら認証なし)。
    if (url.pathname === "/pull") {
      if (env.SYNC_TOKEN && url.searchParams.get("token") !== env.SYNC_TOKEN) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const code = url.searchParams.get("code") || "285A";
      const since = url.searchParams.get("since");
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);

      // since があれば fetched_at > since で絞る。無ければ直近 limit 件を ASC で返す。
      const stmt = since
        ? env.DB.prepare(
            "SELECT url, title, published_at, ir_category, r2_key, fetched_at FROM articles WHERE ticker = ? AND fetched_at > ? ORDER BY fetched_at ASC LIMIT ?",
          ).bind(code, since, limit)
        : env.DB.prepare(
            "SELECT url, title, published_at, ir_category, r2_key, fetched_at FROM articles WHERE ticker = ? ORDER BY fetched_at ASC LIMIT ?",
          ).bind(code, limit);
      const { results } = await stmt.all();

      // 各メタに R2 本文を同梱する。本文は判断 (analyze) に必須。R2 欠損は body=null で返す。
      const rows = await Promise.all(
        (results as Record<string, unknown>[]).map(async (r) => {
          let body: string | null = null;
          try {
            const obj = await env.ARTICLES.get(r.r2_key as string);
            if (obj) {
              const json = JSON.parse(await obj.text()) as { body?: string };
              body = json.body ?? null;
            }
          } catch {
            /* R2 欠損/壊れは body=null のまま (取得自体は止めない) */
          }
          return {
            url: r.url,
            title: r.title,
            published_at: r.published_at,
            ir_category: r.ir_category,
            fetched_at: r.fetched_at,
            body,
          };
        }),
      );
      return Response.json({ ok: true, code, since: since ?? null, count: rows.length, rows });
    }

    // /test-slack : Webhook疎通確認。ダミー1件を実際にSlackへ送る。
    if (url.pathname === "/test-slack") {
      if (!env.SLACK_WEBHOOK_URL) {
        return Response.json({ ok: false, error: "SLACK_WEBHOOK_URL 未設定" }, { status: 400 });
      }
      await notifySlack(env, [
        {
          ticker: "285A",
          title: "【テスト】Slack通知の疎通確認",
          url: "https://www.kioxia-holdings.com/ja-jp/news.html",
          date: "2026-06-17",
          category: "holdings",
        },
      ]);
      return Response.json({ ok: true, sent: true });
    }

    return new Response(
      "stock-signals collector. routes: /run?kind= /dump?kind= /latest?kind= /pull?code= /health /test-slack",
      { status: 404 },
    );
  },
};
