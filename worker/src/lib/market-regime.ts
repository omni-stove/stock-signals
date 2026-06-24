// market-check が投稿する地合い (market regime) ヘッドラインの解析。
//   `🌐 地合い: <regime>・<stance>` から regime / stance を取り出す。
//   regime / stance はともに 3 値固定なので決定論的に拾える。未知フォーマットなら null
//   (= 地合いは記録しない。判定側は market_regime 不在として銘柄単体で判断する)。
// routes/misc の POST /slack/post (kind=market-check) が当日分を market_regime に控えるのに使う。

const REGIMES = ["リスクオン", "リスクオフ", "中立"] as const;
const STANCES = ["拾い場", "様子見", "守り"] as const;

export function parseMarketRegime(
	headline: string,
): { regime: string; stance: string } | null {
	const regime = REGIMES.find((r) => headline.includes(r));
	const stance = STANCES.find((s) => headline.includes(s));
	if (!regime || !stance) return null;
	return { regime, stance };
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("parseMarketRegime", () => {
		it("各 regime / stance の組を拾う", () => {
			expect(parseMarketRegime("🌐 地合い: リスクオフ・守り")).toEqual({
				regime: "リスクオフ",
				stance: "守り",
			});
			expect(parseMarketRegime("🌐 地合い: リスクオン・拾い場")).toEqual({
				regime: "リスクオン",
				stance: "拾い場",
			});
			expect(parseMarketRegime("🌐 地合い: 中立・様子見")).toEqual({
				regime: "中立",
				stance: "様子見",
			});
		});

		it("リスクオン と リスクオフ を取り違えない", () => {
			expect(parseMarketRegime("🌐 地合い: リスクオン・様子見")?.regime).toBe(
				"リスクオン",
			);
			expect(parseMarketRegime("🌐 地合い: リスクオフ・様子見")?.regime).toBe(
				"リスクオフ",
			);
		});

		it("regime か stance が読めなければ null", () => {
			expect(parseMarketRegime("🌐 地合い: 強気・全力")).toBeNull();
			expect(parseMarketRegime("🌐 地合い: リスクオフ")).toBeNull();
			expect(parseMarketRegime("")).toBeNull();
		});
	});
}
