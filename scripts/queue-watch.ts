// scripts/queue-watch.ts
// 使い方: node scripts/queue-watch.ts <ticker>
// data/queue/<ticker>/ を watch し、対象ファイルパスを stdout に1行ずつ出す。
// analyze-ticker skill がこの出力を Monitor で流し読みして1件ずつ判定する。
//
// 行プロトコルは route-news-watch.ts と同じ:
//   READY
//   <absolute-path>
//   ERROR <msg>

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function emit(line: string) {
  process.stdout.write(line + "\n");
}

async function emitExisting(dir: string) {
  try {
    const entries = await readdir(dir);
    entries.sort();
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const p = join(dir, name);
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
  const ticker = process.argv[2];
  if (!ticker) {
    emit("ERROR usage node scripts/queue-watch.ts <ticker>");
    process.exit(2);
  }
  const dir = join(ROOT, "data/queue", ticker);
  await emitExisting(dir);

  const watcher = chokidar.watch(dir, {
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
