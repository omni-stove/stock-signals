// Cloudflare Worker: 重い収集を 1 ジョブ = 1 invocation に分けて回す。
//
// Workers 無料枠の CPU 上限は invocation 単位なので、cron から全収集を直列に回すと合算で上限を
// 超えて丸ごと kill される。cron はジョブを自分自身 (service binding SELF) の /run に 1 本ずつ
// 投げて待つだけにし、各ジョブを別 invocation として CPU 上限を個別に受けさせる。1 ジョブが
// 落ちても他のジョブは書き込まれる。

import type { Env } from "./env";
import { sleep } from "./utils";

export interface FanOutJob {
	kind: string;
	code?: string;
	part?: string;
}

type FanOutEnv = Pick<Env, "SELF" | "SYNC_TOKEN" | "MIN_INTERVAL_MS">;

function jobKey(job: FanOutJob): string {
	return [job.kind, job.code, job.part].filter(Boolean).join(":");
}

function runUrl(job: FanOutJob): string {
	const q = new URLSearchParams({ kind: job.kind });
	if (job.code) q.set("code", job.code);
	if (job.part) q.set("part", job.part);
	return `https://self/run?${q.toString()}`;
}

// ジョブを順に /run へ投げ、ジョブごとの結果 (成功なら /run の result、失敗なら error) を返す。
// 同じサイトへの連続アクセスを避けるため、ジョブの間は MIN_INTERVAL_MS 空ける。
export async function fanOut(
	env: FanOutEnv,
	jobs: FanOutJob[],
): Promise<{ results: Record<string, unknown>; failed: string[] }> {
	const results: Record<string, unknown> = {};
	const failed: string[] = [];
	const interval = parseInt(env.MIN_INTERVAL_MS, 10) || 5000;
	for (const [i, job] of jobs.entries()) {
		if (i > 0) await sleep(interval);
		const key = jobKey(job);
		if (!env.SELF) {
			results[key] = { error: "SELF binding missing" };
			failed.push(key);
			continue;
		}
		try {
			const res = await env.SELF.fetch(runUrl(job), {
				headers: env.SYNC_TOKEN
					? { authorization: `Bearer ${env.SYNC_TOKEN}` }
					: {},
			});
			if (!res.ok) {
				results[key] = {
					error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
				};
				failed.push(key);
				continue;
			}
			results[key] = ((await res.json()) as { result?: unknown }).result;
		} catch (e) {
			results[key] = { error: (e as Error).message };
			failed.push(key);
		}
	}
	return { results, failed };
}

if (import.meta.vitest) {
	const { describe, it, expect, vi } = import.meta.vitest;

	describe("runUrl", () => {
		it("kind / code / part をクエリにする", () => {
			expect(runUrl({ kind: "daily", code: "0010" })).toBe(
				"https://self/run?kind=daily&code=0010",
			);
			expect(runUrl({ kind: "short-interest", part: "market" })).toBe(
				"https://self/run?kind=short-interest&part=market",
			);
		});
	});

	describe("fanOut", () => {
		const env = (fetch: (url: string, init?: RequestInit) => unknown) => ({
			SELF: { fetch } as unknown as Fetcher,
			SYNC_TOKEN: "tok",
			MIN_INTERVAL_MS: "1",
		});

		it("ジョブを順に投げ、認証ヘッダを付けて result を集める", async () => {
			const fetch = vi.fn(
				async (url: string, _init?: RequestInit) =>
					new Response(JSON.stringify({ ok: true, result: { url } })),
			);
			const out = await fanOut(env(fetch), [
				{ kind: "daily", code: "285A" },
				{ kind: "earnings" },
			]);
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(fetch.mock.calls[0][1]).toEqual({
				headers: { authorization: "Bearer tok" },
			});
			expect(out.failed).toEqual([]);
			expect(out.results["daily:285A"]).toEqual({
				url: "https://self/run?kind=daily&code=285A",
			});
		});

		it("落ちたジョブを記録して残りを続ける", async () => {
			const fetch = vi.fn(async (url: string) => {
				if (url.includes("285A")) throw new Error("exceededResources");
				if (url.includes("6857")) return new Response("boom", { status: 500 });
				return new Response(JSON.stringify({ ok: true, result: 1 }));
			});
			const out = await fanOut(env(fetch), [
				{ kind: "daily", code: "285A" },
				{ kind: "daily", code: "6857" },
				{ kind: "daily", code: "6920" },
			]);
			expect(out.failed).toEqual(["daily:285A", "daily:6857"]);
			expect(out.results["daily:6920"]).toBe(1);
		});

		it("SELF が無ければ全ジョブを失敗扱いにする", async () => {
			const out = await fanOut({ MIN_INTERVAL_MS: "1" }, [
				{ kind: "earnings" },
			]);
			expect(out.failed).toEqual(["earnings"]);
		});
	});
}
