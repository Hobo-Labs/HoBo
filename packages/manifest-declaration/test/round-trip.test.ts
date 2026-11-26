import { describe, expect, it } from "vitest";

import {
	canonicalResourceIntentJson,
	decodeResourceIntent,
	encodeResourceIntent,
	parseResourceIntent,
	toResourceIntent,
} from "../src/index.js";
import { EXISTING_INTENTS } from "./fixtures/existing-intents.js";

/**
 * Round trip over every `ResourceIntent` value that exists in the repository.
 *
 * The question this answers is not "does my encoder agree with my decoder" —
 * that is trivially arrangeable — but "does a value the rest of the repository
 * actually builds survive being expressed in this schema". So each fixture goes
 * all the way out to the canonical proto3-JSON wire record and all the way
 * back, twice, and the assertions are on strict structural identity with the
 * *original literal*, not with anything this package produced.
 *
 * `toStrictEqual`, not `toEqual`: `toEqual` treats `{ region: undefined }` and
 * `{}` as the same object, which is exactly the distinction
 * `exactOptionalPropertyTypes` exists to preserve and exactly the one a
 * presence-losing encoder would destroy. A round-trip suite written with
 * `toEqual` would go green on the bug it is meant to catch.
 */
describe("round trip over the existing corpus", () => {
	for (const entry of EXISTING_INTENTS) {
		it(`${entry.id} survives parse -> encode -> decode`, () => {
			const parsed = parseResourceIntent(entry.value);
			const decoded = decodeResourceIntent(encodeResourceIntent(parsed));

			// The authoring view of the decoded value is the literal we started
			// with — same keys, same order-sensitive arrays, same absent fields.
			expect(toResourceIntent(decoded)).toStrictEqual(entry.value);
			// And the parsed views agree, which catches a loss that `toResourceIntent`
			// might paper over by rebuilding defaults.
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
			// A canonical form that is not stable byte-for-byte is not canonical,
			// and any digest taken over it would be a coin flip.
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

		// `region` and `prefer` are the two fields the repository has never
		// populated. Recording that here means the gap is visible rather than
		// implied by the absence of a test: everything asserted about them in
		// this package is asserted against constructed values, and the round trip
		// has therefore never seen a real one.
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
		// Written out in full rather than compared to a re-derivation: the point
		// is to notice if key ordering, field naming, or default omission ever
		// changes, and a self-referential assertion would not.
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

	// The proto3 rule for a field WITHOUT explicit presence: omit it from the
	// JSON whenever it equals the type default. This is what
	// `packages/cloud/data-models/cloud.proto` declares for `region`
	// (`string region = 7;`, no `optional`), and it is why this package declares
	// `optional string region = 7;` instead.
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
		// Both decode to the same value, so under cloud.proto's declaration the
		// two inputs are one record. That is the loss, measured rather than
		// argued.
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
		// Every field inside is at its default, so proto3 JSON emits `{}` — but
		// the message itself has presence, so the key is still there.
		expect(record.placement).toStrictEqual({});
		const decoded = decodeResourceIntent(record);
		expect(decoded.placement).toStrictEqual({ selectors: [], affinities: [] });
		expect(parseResourceIntent(base).placement).toBeUndefined();
	});
});
