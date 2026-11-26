import { describe, expect, it } from "vitest";

import {
	BINDING_REALIZATIONS,
	BINDING_RESOLUTION_CONTRACT,
	BINDING_UNAVAILABLE_CODES,
	BindingRecordError,
	type BindingResolution,
	canonicalizeAppliedRows,
	compareCanonical,
	parseBindingResolution,
	parseYardBindingRowKey,
	yardBindingRowKey,
} from "../src/index.js";

function resolution(
	overrides: Partial<BindingResolution> = {},
): BindingResolution {
	return {
		contract: BINDING_RESOLUTION_CONTRACT,
		yardId: "yard:prod-eu",
		profile: "data.postgres/v1",
		productId: "neon.serverless-postgres",
		connectivityId: "cloudflare.postgres.hyperdrive/v1",
		realization: "native",
		appliedRows: ["data.postgres/v1|neon.serverless-postgres|"],
		consideredCount: 4,
		...overrides,
	};
}

function codeOf(run: () => void): string {
	try {
		run();
	} catch (error) {
		if (error instanceof BindingRecordError) return error.code;
		throw error;
	}
	throw new Error("expected a BindingRecordError");
}

describe("binding resolution vocabulary", () => {
	it("closes the realization and refusal vocabularies", () => {
		expect(BINDING_REALIZATIONS).toStrictEqual(["native", "pack", "bridge"]);
		expect(BINDING_UNAVAILABLE_CODES).toStrictEqual([
			"YARD_BINDING_PRODUCT_UNKNOWN",
			"YARD_BINDING_PROVIDER_MISMATCH",
			"YARD_BINDING_EXCLUDED_ALL",
			"NO_COMPATIBLE_BINDING",
		]);
		expect(Object.isFrozen(BINDING_REALIZATIONS)).toBe(true);
		expect(Object.isFrozen(BINDING_UNAVAILABLE_CODES)).toBe(true);
	});
});

describe("parseBindingResolution", () => {
	it("returns a frozen derived record", () => {
		const parsed = parseBindingResolution(resolution());
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.appliedRows)).toBe(true);
		expect(parsed.contract).toBe(BINDING_RESOLUTION_CONTRACT);
		expect(parsed.productId).toBe("neon.serverless-postgres");
	});

	it("copies the incoming appliedRows array rather than aliasing it", () => {
		const rows = ["data.postgres/v1|neon.serverless-postgres|"];
		const parsed = parseBindingResolution(resolution({ appliedRows: rows }));
		expect(parsed.appliedRows).not.toBe(rows);
		rows.push("kv.cache/v1|upstash.redis|");
		expect(parsed.appliedRows).toHaveLength(1);
	});

	it("sorts and deduplicates applied row keys regardless of input order", () => {
		const forward = parseBindingResolution(
			resolution({
				appliedRows: [
					"kv.cache/v1|upstash.redis|",
					"data.postgres/v1|neon.serverless-postgres|",
					"data.postgres/v1||cloudflare.postgres.hyperdrive/v1",
				],
			}),
		);
		const permuted = parseBindingResolution(
			resolution({
				appliedRows: [
					"data.postgres/v1||cloudflare.postgres.hyperdrive/v1",
					"kv.cache/v1|upstash.redis|",
					"data.postgres/v1|neon.serverless-postgres|",
					"kv.cache/v1|upstash.redis|",
				],
			}),
		);
		expect(forward.appliedRows).toStrictEqual([
			"data.postgres/v1||cloudflare.postgres.hyperdrive/v1",
			"data.postgres/v1|neon.serverless-postgres|",
			"kv.cache/v1|upstash.redis|",
		]);
		expect(permuted.appliedRows).toStrictEqual(forward.appliedRows);
	});

	it("is deterministic — the same input parses to a deep-equal record", () => {
		expect(parseBindingResolution(resolution())).toStrictEqual(
			parseBindingResolution(resolution()),
		);
	});

	it.each([
		[{ contract: "hobo.binding-resolution/v2" }, "an unrecognized contract"],
		[{ yardId: "" }, "an empty yard id"],
		[{ profile: "  " }, "a whitespace-only profile"],
		[{ productId: 7 }, "a non-string product id"],
		[{ connectivityId: "" }, "an empty connectivity id"],
		[{ realization: "emulated" }, "a realization outside the vocabulary"],
		[{ consideredCount: 0 }, "a resolution that considered no candidates"],
		[{ consideredCount: -1 }, "a negative considered count"],
		[{ consideredCount: 1.5 }, "a fractional considered count"],
		[
			{ appliedRows: "data.postgres/v1|neon|" },
			"appliedRows that is not an array",
		],
	])("rejects %j — %s", (overrides) => {
		expect(() =>
			parseBindingResolution(
				// SAFETY: each table row deliberately overrides one runtime-validated field.
				resolution(overrides as Partial<BindingResolution>),
			),
		).toThrow(BindingRecordError);
	});

	it.each([
		[undefined],
		[null],
		["resolution"],
		[42],
	])("rejects the non-object input %j", (value) => {
		expect(codeOf(() => parseBindingResolution(value))).toBe(
			"BINDING_RECORD_INVALID",
		);
	});

	it("rejects a control character smuggled into a field", () => {
		expect(
			codeOf(() =>
				parseBindingResolution(
					resolution({ yardId: `yard:prod${String.fromCharCode(10)}INFO ok` }),
				),
			),
		).toBe("BINDING_RECORD_INVALID");
	});

	it.each([
		["postgresql://user:hunter2@db.example.com/app", "a connection string"],
		["Bearer abcdefghijklmnop", "a bearer token"],
		["sk-livexxxxxxxxxxxxxxxx", "a provider api key"],
	])("rejects the secret-shaped product id %s (%s)", (productId) => {
		expect(
			codeOf(() => parseBindingResolution(resolution({ productId }))),
		).toBe("BINDING_RECORD_CREDENTIAL_VALUE");
	});

	it("accepts a secret locator, which is not a secret", () => {
		const parsed = parseBindingResolution(
			resolution({ productId: "vault://tenant/neon/db" }),
		);
		expect(parsed.productId).toBe("vault://tenant/neon/db");
	});

	it("keeps credential material out of the serialized record", () => {
		const serialized = JSON.stringify(parseBindingResolution(resolution()));
		expect(serialized).not.toMatch(/postgresql:\/\//u);
		expect(serialized).not.toContain("password");
	});
});

describe("canonical Yard binding row keys", () => {
	it("builds the (profile, productId, connectivityId) tuple key", () => {
		expect(
			yardBindingRowKey({
				profile: "data.postgres/v1",
				productId: "neon.serverless-postgres",
			}),
		).toBe("data.postgres/v1|neon.serverless-postgres|");
		expect(
			yardBindingRowKey({
				profile: "data.postgres/v1",
				connectivityId: "cloudflare.postgres.hyperdrive/v1",
			}),
		).toBe("data.postgres/v1||cloudflare.postgres.hyperdrive/v1");
	});

	it("refuses a row that constrains neither product nor connectivity", () => {
		expect(
			codeOf(() => yardBindingRowKey({ profile: "data.postgres/v1" })),
		).toBe("BINDING_RECORD_INVALID");
	});

	it.each([
		["data.postgres/v1|neon", "too few segments"],
		["data.postgres/v1|neon|hyperdrive|extra", "too many segments"],
		["|neon.serverless-postgres|", "no profile"],
		[7, "not a string"],
	])("rejects the malformed row key %j — %s", (value) => {
		expect(codeOf(() => parseYardBindingRowKey(value))).toBe(
			"BINDING_RECORD_INVALID",
		);
	});

	it("canonicalizes a row-key collection into a frozen sorted set", () => {
		const rows = canonicalizeAppliedRows([
			"kv.cache/v1|upstash.redis|",
			"data.postgres/v1|neon.serverless-postgres|",
			"kv.cache/v1|upstash.redis|",
		]);
		expect(rows).toStrictEqual([
			"data.postgres/v1|neon.serverless-postgres|",
			"kv.cache/v1|upstash.redis|",
		]);
		expect(Object.isFrozen(rows)).toBe(true);
	});

	it("orders by codepoint so the audit trail does not depend on a locale", () => {
		expect(compareCanonical("a", "b")).toBe(-1);
		expect(compareCanonical("b", "a")).toBe(1);
		expect(compareCanonical("a", "a")).toBe(0);
		// A locale-aware collation would sort "Z" after "a"; codepoint order does not.
		expect(compareCanonical("Z", "a")).toBe(-1);
	});
});
