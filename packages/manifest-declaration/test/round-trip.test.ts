import { describe, expect, it } from "vitest";

import {
	canonicalResourceIntentJson,
	decodeResourceIntent,
	encodeResourceIntent,
	parseResourceIntent,
	toResourceIntent,
} from "../src/index.js";
import { EXISTING_INTENTS } from "./fixtures/existing-intents.js";

describe("round trip over the existing corpus", () => {
	for (const entry of EXISTING_INTENTS) {
		it(`${entry.id} survives parse -> encode -> decode`, () => {
			const parsed = parseResourceIntent(entry.value);
			const decoded = decodeResourceIntent(encodeResourceIntent(parsed));

			expect(toResourceIntent(decoded)).toStrictEqual(entry.value);
			expect(decoded).toStrictEqual(parsed);
		});

		it(`${entry.id} is byte-identical on the second pass`, () => {
			const first = parseResourceIntent(entry.value);
			const second = decodeResourceIntent(encodeResourceIntent(first));
			const third = decodeResourceIntent(encodeResourceIntent(second));

			const a = canonicalResourceIntentJson(first);
			const b = canonicalResourceIntentJson(second);
			const c = canonicalResourceIntentJson(third);
			expect(b).toBe(a);
			expect(c).toBe(a);
			expect(Buffer.from(b, "utf8").equals(Buffer.from(a, "utf8"))).toBe(true);
		});
	}

	it("covers every optional field at least once across the corpus", () => {
		const withPlacement = EXISTING_INTENTS.filter(
			(entry) => entry.value.placement !== undefined,
		);
		const withSelectors = withPlacement.filter(
			(entry) => (entry.value.placement?.selectors.length ?? 0) > 0,
		);
		const withAffinities = withPlacement.filter(
			(entry) => (entry.value.placement?.affinities.length ?? 0) > 0,
		);
		const withSpread = withPlacement.filter(
			(entry) => entry.value.placement?.spread !== undefined,
		);
		const withPickN = withPlacement.filter(
			(entry) => entry.value.placement?.pickN !== undefined,
		);
		const withDeps = EXISTING_INTENTS.filter(
			(entry) => entry.value.deps.length > 0,
		);
		const withRequire = EXISTING_INTENTS.filter(
			(entry) => entry.value.require.length > 0,
		);

		expect(withSelectors.length).toBeGreaterThan(0);
		expect(withAffinities.length).toBeGreaterThan(0);
		expect(withSpread.length).toBe(2);
		expect(withPickN.length).toBe(2);
		expect(withDeps.length).toBe(1);
		expect(withRequire.length).toBe(5);

		expect(
			EXISTING_INTENTS.filter((entry) => entry.value.region !== undefined),
		).toEqual([]);
		expect(
			EXISTING_INTENTS.filter((entry) => entry.value.prefer.length > 0),
		).toEqual([]);
	});

	it("pins the canonical bytes of one fixture", () => {
		const parsed = parseResourceIntent(
			EXISTING_INTENTS.find(
				(entry) => entry.id === "placement/pick-n-2-region-pinned",
			)?.value ?? {},
		);
		expect(canonicalResourceIntentJson(parsed)).toBe(
			'{"name":"cache","negotiation":"require","objective":"min-cost","placement":{"pick_n":{"count":2},"selectors":[{"key":"region","op":"eq","values":["us-east-1"]}]},"port":"kv"}',
		);
	});
});

describe("presence, the thing a proto3 default silently eats", () => {
	const base = {
		name: "cache",
		port: "kv",
		require: [],
		prefer: [],
		negotiation: "require" as const,
		deps: [],
		objective: "min-cost",
	};

	type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;
	type JsonRecord = { readonly [key: string]: JsonValue };
	function encodeUnderImplicitPresence(intent: JsonRecord) {
		const out: JsonRecord = {};
		for (const [key, value] of Object.entries(intent)) {
			if (value === "" || value === 0 || value === false) continue;
			if (Array.isArray(value) && value.length === 0) continue;
			if (value === undefined) continue;
			out[key] = value;
		}
		return out;
	}

	it("implicit presence cannot tell an empty region from an absent one", () => {
		const empty = encodeUnderImplicitPresence({ ...base, region: "" });
		const absent = encodeUnderImplicitPresence({ ...base });
		expect(empty).toStrictEqual(absent);
		expect("region" in empty).toBe(false);
	});

	it("this package refuses the value that would be lost", () => {
		expect(() => parseResourceIntent({ ...base, region: "" })).toThrow(
			"resource intent $.region: must not be empty",
		);
	});

	it("a present region survives the round trip because the field has explicit presence", () => {
		const parsed = parseResourceIntent({ ...base, region: "us-east-1" });
		const record = encodeResourceIntent(parsed);
		expect(record.region).toBe("us-east-1");
		expect(decodeResourceIntent(record)).toStrictEqual(parsed);
	});

	it("an absent region stays absent rather than becoming an empty string", () => {
		const parsed = parseResourceIntent(base);
		expect("region" in parsed).toBe(false);
		const record = encodeResourceIntent(parsed);
		expect("region" in record).toBe(false);
		const decoded = decodeResourceIntent(record);
		expect("region" in decoded).toBe(false);
		expect(toResourceIntent(decoded)).toStrictEqual(base);
	});

	it("region present-but-undefined is refused rather than silently dropped", () => {
		expect(() => parseResourceIntent({ ...base, region: undefined })).toThrow(
			"resource intent $.region: is present but undefined; omit the field instead",
		);
	});

	it("an empty placement message keeps its presence through the wire form", () => {
		const parsed = parseResourceIntent({
			...base,
			placement: { selectors: [], affinities: [] },
		});
		const record = encodeResourceIntent(parsed);
		expect(record.placement).toStrictEqual({});
		const decoded = decodeResourceIntent(record);
		expect(decoded.placement).toStrictEqual({ selectors: [], affinities: [] });
		expect(parseResourceIntent(base).placement).toBeUndefined();
	});
});
