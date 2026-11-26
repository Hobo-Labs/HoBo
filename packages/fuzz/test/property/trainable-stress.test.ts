import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type FuzzValue, fuzzTrainable } from "../../src/index.js";

describe("trainable gold/silver stress", () => {
	it("survives deep, wide, and polluted garbage without crashing", () => {
		type DeepNode = { n: number; child?: DeepNode };
		const deep: DeepNode = { n: 0 };
		let cursor = deep;
		for (let i = 1; i < 40; i += 1) {
			const next = { n: i };
			cursor.child = next;
			cursor = next;
		}
		const wide = Object.fromEntries(
			Array.from({ length: 80 }, (_, i) => [`k${i}`, i]),
		);
		// SAFETY: this fixture intentionally models a JSON object for pollution testing.
		const parsed = JSON.parse('{"__proto__":{"admin":true}}') as FuzzValue;
		expect(() =>
			fuzzTrainable(
				(input) => input,
				[
					{ input: deep, output: deep },
					{ input: wide, output: wide },
					{ input: parsed, output: parsed },
				],
			),
		).not.toThrow();
		const report = fuzzTrainable(
			(input: FuzzValue) => input,
			[
				{ input: { text: "ok" }, output: { text: "ok" } },
				{ input: parsed, output: parsed },
			],
		);
		expect(report.ok).toBe(false);
		expect(report.noPollution).toBe(false);
	});

	it("a pure deterministic labeler survives random gold seeds", () => {
		const fn = (input: FuzzValue) => {
			const text =
				input && Object(input) === input && "text" in input
					? String(
							// SAFETY: the object branch establishes a property-bearing input.
							(input as { text?: unknown }).text ?? "",
						)
					: "";
			return { label: text.includes("invoice") ? "billing" : "other" };
		};
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						text: fc.string({ maxLength: 40 }),
					}),
					{ minLength: 1, maxLength: 8 },
				),
				(rows) => {
					const seeds = rows.map((row) => ({
						input: row,
						output: fn(row),
					}));
					const report = fuzzTrainable(fn, seeds, {
						methodRef: "shop.classify",
					});
					expect(
						report.ok,
						report.verdicts.map((row) => row.message).join("; "),
					).toBe(true);
				},
			),
			{ numRuns: 80 },
		);
	});

	it("bigint and date seeds stay exact under a live trainable", () => {
		fc.assert(
			fc.property(
				fc.bigInt(),
				fc.integer({ min: 0, max: 1_000_000_000 }),
				(n, ms) => {
					const when = new Date(ms);
					const big = fuzzTrainable(
						(input) => input,
						[{ input: n, output: n }],
					);
					const dated = fuzzTrainable(
						(input) => input,
						[{ input: when, output: when }],
					);
					expect(big.seedHolds).toBe(true);
					expect(dated.seedHolds).toBe(true);
					expect(
						fuzzTrainable(() => n + 1n, [{ input: n, output: n }]).seedHolds,
					).toBe(false);
					expect(
						fuzzTrainable(
							() => new Date(ms + 1),
							[{ input: when, output: when }],
						).seedHolds,
					).toBe(false);
				},
			),
			{ numRuns: 40 },
		);
	});

	it("detects drift, non-determinism, throws, and oversize", () => {
		const seed = {
			input: { text: "invoice overdue" },
			output: { label: "billing" },
		};
		expect(fuzzTrainable(() => ({ label: "shipping" }), [seed]).seedHolds).toBe(
			false,
		);
		let flip = false;
		expect(
			fuzzTrainable(() => {
				flip = !flip;
				return { label: flip ? "billing" : "other" };
			}, [seed]).deterministic,
		).toBe(false);
		expect(
			fuzzTrainable(() => {
				throw new Error("boom");
			}, [seed]).seedHolds,
		).toBe(false);
		expect(
			fuzzTrainable(() => "x".repeat(70_000), [{ input: { text: "a" } }])
				.bounded,
		).toBe(false);
	});

	it("does not treat an identity echo as fail-closed", () => {
		const report = fuzzTrainable(
			(input) => input,
			[{ input: { text: "ok" }, output: { text: "ok" } }],
		);
		expect(report.failClosed).toBe(false);
	});

	it("does not crash on circular or bigint outputs", () => {
		type Circular = { self?: Circular };
		const circ: Circular = {};
		circ.self = circ;
		const circular = fuzzTrainable(
			() => circ,
			[{ input: { text: "x" }, output: { label: "x" } }],
		);
		expect(circular.ok).toBe(false);
		expect(circular.seedHolds).toBe(false);
		const big = fuzzTrainable(() => 1n, [{ input: 1, output: 1n }]);
		expect(big.ok).toBe(true);
		expect(big.seedHolds).toBe(true);
		expect(big.bounded).toBe(true);
	});

	it("does not treat NaN, dates, or maps as interchangeable", () => {
		expect(
			fuzzTrainable(() => Number.NaN, [{ input: 1, output: null }]).seedHolds,
		).toBe(false);
		expect(
			fuzzTrainable(
				() => new Date("2020-01-01T00:00:00.000Z"),
				[{ input: 1, output: new Date("2021-01-01T00:00:00.000Z") }],
			).seedHolds,
		).toBe(false);
		expect(
			fuzzTrainable(
				() => new Date("2020-01-01T00:00:00.000Z"),
				[{ input: 1, output: new Date("2020-01-01T00:00:00.000Z") }],
			).seedHolds,
		).toBe(true);
		expect(
			fuzzTrainable(
				() => new Map([["k", 1]]),
				[{ input: 1, output: new Map([["k", 2]]) }],
			).seedHolds,
		).toBe(false);
	});

	it("treats a thenable trainable as not fail-closed", () => {
		const report = fuzzTrainable(
			() => Promise.resolve({ label: "billing" }),
			[
				{
					input: { text: "invoice overdue" },
					output: { label: "billing" },
				},
			],
		);
		expect(report.failClosed).toBe(false);
		expect(report.seedHolds).toBe(false);
		expect(report.ok).toBe(false);
	});
});
