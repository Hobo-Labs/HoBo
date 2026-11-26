import { describe, expect, it } from "vitest";

import {
	parseYardBindings,
	YARD_BINDING_CONTRACT,
	YARD_BINDING_PROFILE_PATTERN,
	type YardBinding,
	YardBindingError,
	type YardBindingInput,
} from "../src/index.js";

function row(overrides: Partial<YardBindingInput> = {}): YardBindingInput {
	return {
		profile: "data.relational/v1",
		productId: "aws:rds-postgres",
		...overrides,
	};
}

function codeOf(fn: () => void): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof YardBindingError) return error.code;
		return `not-a-YardBindingError: ${String(error)}`;
	}
	return "no-error";
}

describe("parseYardBindings() — grammar, shape, and credential parse boundary", () => {
	it("returns an empty frozen set for undefined input", () => {
		const parsed = parseYardBindings(undefined);
		expect(parsed).toEqual([]);
		expect(Object.isFrozen(parsed)).toBe(true);
	});

	it("defaults require/properties and stamps the contract", () => {
		const [parsed] = parseYardBindings([row()]);
		expect(parsed).toEqual({
			contract: YARD_BINDING_CONTRACT,
			profile: "data.relational/v1",
			productId: "aws:rds-postgres",
			require: [],
			properties: {},
		});
		expect(Object.isFrozen(parsed)).toBe(true);
	});

	it("accepts a row constrained only by connectivity", () => {
		const [parsed] = parseYardBindings([
			{ profile: "data.relational/v1", connectivityId: "pg-wire/v1" },
		]);
		expect(parsed?.connectivityId).toBe("pg-wire/v1");
		expect(parsed?.productId).toBeUndefined();
	});

	it("canonicalizes require: deduped and sorted", () => {
		const [parsed] = parseYardBindings([
			{ ...row(), require: ["tls", "pooling", "tls"] },
		]);
		expect(parsed?.require).toEqual(["pooling", "tls"]);
	});

	it("canonicalizes properties by sorted key and keeps them JSON-safe", () => {
		const [parsed] = parseYardBindings([
			{ ...row(), properties: { zone: "b", "aws.family": "postgres" } },
		]);
		expect(Object.keys(parsed?.properties ?? {})).toEqual([
			"aws.family",
			"zone",
		]);
	});

	it.each([
		["Data.relational/v1", "uppercase segment"],
		["data.relational", "missing version suffix"],
		["data.relational/v0", "major version must start at 1"],
		["data.relational/1", "missing v prefix"],
		["/v1", "empty family"],
		["data_relational/v1", "underscore is not in the grammar"],
	])("rejects profile %s (%s)", (profile) => {
		expect(codeOf(() => parseYardBindings([{ ...row(), profile }]))).toBe(
			"YARD_BINDING_PROFILE_INVALID",
		);
	});

	it("exposes the profile grammar as a reusable pattern", () => {
		expect(YARD_BINDING_PROFILE_PATTERN.test("secret-ref.locator/v1")).toBe(
			true,
		);
		expect(YARD_BINDING_PROFILE_PATTERN.test("data.relational/v10")).toBe(true);
		expect(YARD_BINDING_PROFILE_PATTERN.test("data.relational/v01")).toBe(
			false,
		);
	});

	it("rejects a row that constrains neither product nor connectivity", () => {
		expect(
			codeOf(() => parseYardBindings([{ profile: "kv.key-value/v1" }])),
		).toBe("YARD_BINDING_EMPTY_CONSTRAINT");
	});

	it("rejects a present-but-empty constraint rather than dropping it", () => {
		expect(
			codeOf(() =>
				parseYardBindings([
					{
						profile: "kv.key-value/v1",
						productId: "",
						connectivityId: "redis-resp/v1",
					},
				]),
			),
		).toBe("YARD_BINDING_EMPTY_CONSTRAINT");
	});

	it("rejects credential-shaped property keys", () => {
		expect(
			codeOf(() =>
				parseYardBindings([{ ...row(), properties: { apiKey: "hunter2" } }]),
			),
		).toBe("YARD_BINDING_CREDENTIAL_PROPERTY");
	});

	it.each([
		["password", "password"],
		["accessToken", "token"],
		["private_key", "private key"],
		["dbCredential", "credential"],
	])("rejects the credential-shaped key %s", (key) => {
		expect(
			codeOf(() =>
				parseYardBindings([{ ...row(), properties: { [key]: "x" } }]),
			),
		).toBe("YARD_BINDING_CREDENTIAL_PROPERTY");
	});

	it("rejects a row whose profile is also a pinned resolver slot", () => {
		expect(
			codeOf(() =>
				parseYardBindings([row()], {
					pinnedSlots: ["data.relational/v1"],
				}),
			),
		).toBe("YARD_BINDING_PIN_CONFLICT");
	});

	it("allows a row when a different slot is pinned", () => {
		expect(
			parseYardBindings([row()], { pinnedSlots: ["kv.key-value/v1"] }),
		).toHaveLength(1);
	});

	it("rejects a duplicate (profile, productId, connectivityId) triple", () => {
		expect(codeOf(() => parseYardBindings([row(), row()]))).toBe(
			"YARD_BINDING_DUPLICATE",
		);
	});

	it("treats an absent constraint as the empty string when deduping", () => {
		expect(
			codeOf(() =>
				parseYardBindings([
					{ profile: "kv.key-value/v1", productId: "local:in-memory-kv" },
					{
						profile: "kv.key-value/v1",
						productId: "local:in-memory-kv",
						require: ["ttl"],
					},
				]),
			),
		).toBe("YARD_BINDING_DUPLICATE");
	});

	it("keeps rows that differ only by connectivity", () => {
		expect(
			parseYardBindings([
				{ profile: "data.relational/v1", productId: "p", connectivityId: "a" },
				{ profile: "data.relational/v1", productId: "p", connectivityId: "b" },
			]),
		).toHaveLength(2);
	});

	it("carries the offending profile on the typed error", () => {
		try {
			parseYardBindings([{ profile: "kv.key-value/v1" }]);
			expect.unreachable("expected a YardBindingError");
		} catch (error) {
			expect(error).toBeInstanceOf(YardBindingError);
			// SAFETY: `expect((error as YardBindingError).profile).toBe("kv.key-value/v1");` is required at this I/O or test boundary.
			expect((error as YardBindingError).profile).toBe("kv.key-value/v1");
			// SAFETY: `expect((error as YardBindingError).name).toBe("YardBindingError");` is required at this I/O or test boundary.
			expect((error as YardBindingError).name).toBe("YardBindingError");
		}
	});

	it.each([
		[{ profile: "data.relational/v1", productId: 7 }, "non-string productId"],
		[
			{ profile: "data.relational/v1", productId: "p", require: "tls" },
			"require not an array",
		],
		[
			{ profile: "data.relational/v1", productId: "p", require: [""] },
			"empty require entry",
		],
		[
			{
				profile: "data.relational/v1",
				productId: "p",
				properties: { fn: () => 1 },
			},
			"non-JSON property value",
		],
	])("throws TypeError for structurally invalid input (%#: %s)", (input) => {
		expect(() =>
			// SAFETY: `input` is deliberately malformed; the parse boundary must
			// refuse it, so the typed signature is bypassed on purpose.
			parseYardBindings([input as never]),
		).toThrow(TypeError);
	});

	it("rejects a non-array row set", () => {
		expect(() =>
			// SAFETY: a string is deliberately not a row set; the parse boundary
			// must refuse it, so the typed signature is bypassed on purpose.
			parseYardBindings("rows" as never),
		).toThrow(TypeError);
	});
});

describe("parseYardBindings() — rows are a set, not an ordered list", () => {
	const authored: readonly YardBindingInput[] = [
		{ profile: "web.static/v1", productId: "aws:s3-website" },
		{ profile: "data.relational/v1", productId: "aws:rds-postgres" },
		{
			profile: "data.relational/v1",
			productId: "aws:aurora-postgres",
			connectivityId: "pg-wire/v1",
		},
		{ profile: "data.relational/v1", productId: "aws:aurora-postgres" },
	];

	const canonical = (rows: readonly YardBinding[]) =>
		rows.map((r) => [r.profile, r.productId ?? "", r.connectivityId ?? ""]);

	it("sorts by (profile, productId, connectivityId)", () => {
		expect(canonical(parseYardBindings(authored))).toEqual([
			["data.relational/v1", "aws:aurora-postgres", ""],
			["data.relational/v1", "aws:aurora-postgres", "pg-wire/v1"],
			["data.relational/v1", "aws:rds-postgres", ""],
			["web.static/v1", "aws:s3-website", ""],
		]);
	});

	it("produces the same canonical order under any authoring permutation", () => {
		const expected = canonical(parseYardBindings(authored));
		const permutations: readonly (readonly YardBindingInput[])[] = [
			[...authored].reverse(),
			[authored[1], authored[3], authored[0], authored[2]].filter(
				(r): r is YardBindingInput => r !== undefined,
			),
			[authored[2], authored[0], authored[3], authored[1]].filter(
				(r): r is YardBindingInput => r !== undefined,
			),
		];
		for (const permutation of permutations) {
			expect(canonical(parseYardBindings(permutation))).toEqual(expected);
		}
	});

	it("does not mutate the authored array", () => {
		const input = [...authored];
		parseYardBindings(input);
		expect(input).toEqual(authored);
	});
});
