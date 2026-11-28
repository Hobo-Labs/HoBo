import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import { quoteScenario } from "../src/quote.js";
import { isQuoteVector } from "../src/types.js";
import {
	creditState,
	makeScenario,
	perUnitCharge,
	usage,
	workload,
} from "./fixtures.js";

function evaluate(locale: string, reverse = false) {
	const fixture = fileURLToPath(
		new URL("./fixtures/pricing-locale.mts", import.meta.url),
	);
	const child = spawnSync(process.execPath, ["--import", "tsx", fixture], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			LC_ALL: locale,
			HOBO_TEST_REVERSE: reverse ? "1" : "0",
		},
	});
	expect(child.status, child.stderr).toBe(0);
	return JSON.parse(child.stdout);
}

it("uses the same credit and effective cost across locales while retaining explicit v1 replay", () => {
	const english = evaluate("en_US.UTF-8");
	const swedish = evaluate("sv_SE.UTF-8");
	const reversed = evaluate("sv_SE.UTF-8", true);
	expect(english.locale).toBe("en-US");
	expect(swedish.locale).toBe("sv-SE");
	for (const result of [english, swedish, reversed]) {
		expect(result.version).toBe("pricing-rating/v9");
		expect(result.effective).toBe("9");
		expect(result.consumption).toEqual(["z"]);
		expect(result.v2Version).toBe("pricing-rating/v2");
		expect(result.v2Effective).toBe("9");
		expect(result.v2Consumption).toEqual(["z"]);
	}
	expect(english.quoteHash).toBe(swedish.quoteHash);
	expect(english.legacyVersion).toBe("pricing-rating/v1");
	expect(english.legacyEffective).toBe("0");
	expect(swedish.legacyEffective).toBe("9");
	expect(english.legacyConsumption).toEqual(["ä"]);
	expect(swedish.legacyConsumption).toEqual(["z"]);
}, 120_000);

it("chooses equal-priority credits independently of input order", () => {
	const names = fc.uniqueArray(
		fc.constantFrom("a", "z", "ä", "å", "Z", "ß", "中"),
		{ minLength: 2, maxLength: 2 },
	);
	fc.assert(
		fc.property(names, ([paid, promo]) => {
			if (!paid || !promo) throw new Error("missing generated credit name");
			const grants = [
				creditState(paid, "acquisition", 0),
				creditState(promo, "zero", 0),
			];
			const scenario = (credits: typeof grants) =>
				makeScenario({
					charges: [perUnitCharge("usage", "minute", "1")],
					candidate: [
						workload("agreement-a", [usage("minute", "10", "minute")]),
					],
					credits,
				});
			const first = quoteScenario(scenario(grants));
			const reversed = quoteScenario(scenario([...grants].reverse()));
			if (!isQuoteVector(first) || !isQuoteVector(reversed))
				throw new Error("quote rejected");
			const expected = paid < promo ? paid : promo;
			expect(first.consumption.map((item) => item.sourceId)).toEqual([
				expected,
			]);
			expect(reversed.consumption.map((item) => item.sourceId)).toEqual([
				expected,
			]);
			const remaining = first.remainingHeadroom.map((item) => [
				item.sourceId,
				item.quantity?.decimal,
			]);
			expect(remaining).toContainEqual([expected, "0"]);
			expect(remaining).toContainEqual([
				expected === paid ? promo : paid,
				"10",
			]);
			expect(first.incremental?.effective?.decimal).toBe(
				expected === paid ? "9" : "0",
			);
			expect(reversed.incremental?.effective).toEqual(
				first.incremental?.effective,
			);
		}),
		{ seed: 614482, numRuns: 300 },
	);
}, 60_000);

it("rejects an unknown rating version", () => {
	const scenario = makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
	});
	for (const raw of [
		'{"ratingAlgorithmVersion":"future"}',
		'{"ratingAlgorithmVersion":null}',
	]) {
		const result = quoteScenario(scenario, JSON.parse(raw));
		expect(isQuoteVector(result)).toBe(false);
		if (isQuoteVector(result)) throw new Error("unexpected quote");
		expect(result.code).toBe("INVALID_PRICING_INPUT");
	}
});
