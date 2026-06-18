// scripts/route-news-watch.ts
// data/inbox/ を watch し、対象ファイルパスを stdout に1行ずつ出すだけの常駐スクリプト。
// route-news skill (Claude Code) はこのプロセスの stdout を Monitor で流し読みし、
// 1行 = 1ファイルパス を受け取って LLM 判定する。
//
// 起動時には既存の inbox 内ファイルも一通り emit してから常駐モードに入る。
// 行プロトコルは単純:
//   READY            ← 既存スキャン完了の合図
//   <absolute-path>  ← 1件
//   ERROR <msg>      ← エラー(継続)
//
// 終了はSIGINT/SIGTERMで。

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INBOX = join(ROOT, "data/inbox");

function emit(line: string) {
  process.stdout.write(line + "\n");
}

async function emitExisting() {
  try {
    const entries = await readdir(INBOX);
    // 古い順に。ファイル名が ISO 風タイムスタンプを含む前提でソート。
    entries.sort();
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const p = join(INBOX, name);
      try {
        const st = await stat(p);
        if (st.isFile()) emit(p);
      } catch {
        // skip
      }
    }
  } catch (e) {
    emit(`ERROR initial-scan ${(e as Error).message}`);
  }
  emit("READY");
}

async function main() {
  await emitExisting();

  const watcher = chokidar.watch(INBOX, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on("add", (path) => {
    if (path.endsWith(".json")) emit(resolve(path));
  });
  watcher.on("error", (e) => emit(`ERROR watcher ${(e as Error).message ?? e}`));

  const shutdown = async () => {
    await watcher.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  emit(`ERROR fatal ${(e as Error).stack ?? e}`);
  process.exit(1);
});
