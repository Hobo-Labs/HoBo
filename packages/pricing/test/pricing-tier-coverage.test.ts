import fc from "fast-check";
import { expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../src/json.js";
import { quoteScenario } from "../src/quote.js";
import { isQuoteVector } from "../src/types.js";
import { makeScenario, money, usage, workload } from "./fixtures.js";

type Kind = "graduated" | "volume";
function tier(from: string, to: string | undefined, price: string): JsonValue {
	const result: JsonObject = {
		from,
		flatAmount: money("0"),
		unitAmount: money(price),
	};
	if (to !== undefined) result.to = to;
	return result;
}
function scenario(kind: Kind, tiers: JsonValue[], quantity: number) {
	return makeScenario({
		charges: [
			{
				base: {
					id: "tier",
					selectors: {},
					fallback: false,
					invoiceBehavior: "itemized",
				},
				usage: { dimension: "minute", timing: "arrears", [kind]: { tiers } },
			},
		],
		candidate: [
			workload("agreement-a", [usage("minute", String(quantity), "minute")]),
		],
	});
}
function rejected(
	result: ReturnType<typeof quoteScenario>,
	code = "INVALID_PRICING_INPUT",
) {
	if (isQuoteVector(result)) throw new Error("invalid tier schedule accepted");
	expect(result.code).toBe(code);
}

it.each([
	"graduated",
	"volume",
] as const)("rejects %s tier gaps and overlaps", (kind) => {
	for (const [end, start] of [
		["5", "10"],
		["10", "5"],
	]) {
		const input = scenario(
			kind,
			[tier("0", end, "1"), tier(start, undefined, "1")],
			8,
		);
		rejected(quoteScenario(input));
		if (kind === "graduated") {
		}
	}
});

it.each([
	["starts above zero", [tier("1", undefined, "1")]],
	["negative start", [tier("-1", undefined, "1")]],
	["duplicate start", [tier("0", undefined, "1"), tier("0.0", undefined, "2")]],
	["zero width", [tier("0", "0", "1")]],
	["reversed range", [tier("0", "-1", "1")]],
	["empty schedule", []],
] as const)("rejects a %s", (_name, tiers) => {
	const input = scenario("graduated", [...tiers], 1);
	rejected(quoteScenario(input));
});

it("accepts inferred boundaries and preserves grouped graduated pricing", () => {
	const input = scenario(
		"graduated",
		[tier("10", undefined, "2"), tier("0", undefined, "1")],
		12,
	);
	const result = quoteScenario(input);
	if (!isQuoteVector(result)) throw new Error("valid tiers rejected");
	expect(result.incremental?.billed?.decimal).toBe("14");
});

it("rejects usage beyond a finite final tier", () => {
	const tiers = [tier("0", "10", "1")];
	const edge = quoteScenario(scenario("graduated", tiers, 10));
	if (!isQuoteVector(edge)) throw new Error("graduated boundary rejected");
	expect(edge.incremental?.billed?.decimal).toBe("10");
	rejected(
		quoteScenario(scenario("graduated", tiers, 11)),
		"RATE_CARD_NOT_FOUND",
	);
	rejected(quoteScenario(scenario("volume", tiers, 10)), "RATE_CARD_NOT_FOUND");
});

it("prices generated contiguous tier boundaries without gaps or double counts", () => {
	fc.assert(
		fc.property(
			fc.constantFrom<Kind>("graduated", "volume"),
			fc.integer({ min: 1, max: 50 }),
			fc.integer({ min: 1, max: 100 }),
			fc.integer({ min: 0, max: 50 }),
			fc.integer({ min: 0, max: 50 }),
			(kind, boundary, quantity, firstPrice, secondPrice) => {
				const result = quoteScenario(
					scenario(
						kind,
						[
							tier("0", String(boundary), String(firstPrice)),
							tier(String(boundary), undefined, String(secondPrice)),
						],
						quantity,
					),
				);
				if (!isQuoteVector(result))
					throw new Error(`valid tiers rejected: ${result.code}`);
				const expected =
					kind === "graduated"
						? Math.min(quantity, boundary) * firstPrice +
							Math.max(quantity - boundary, 0) * secondPrice
						: quantity * (quantity < boundary ? firstPrice : secondPrice);
				expect(result.incremental?.billed?.decimal).toBe(String(expected));
			},
		),
		{ seed: 614490, numRuns: 300 },
	);
});

it("rejects generated gaps and overlaps for both tier modes", () => {
	fc.assert(
		fc.property(
			fc.constantFrom<Kind>("graduated", "volume"),
			fc.integer({ min: 1, max: 100 }),
			fc.integer({ min: 1, max: 50 }),
			fc.boolean(),
			(kind, end, distance, gap) => {
				const start = gap ? end + distance : Math.max(0, end - distance);
				rejected(
					quoteScenario(
						scenario(
							kind,
							[
								tier("0", String(end), "1"),
								tier(String(start), undefined, "2"),
							],
							end,
						),
					),
				);
			},
		),
		{ seed: 614491, numRuns: 300 },
	);
});

it("rejects an empty tier schedule even when no usage is present", () => {
	const input = scenario("graduated", [], 1);
	input.candidate = [];
	rejected(quoteScenario(input));
});
