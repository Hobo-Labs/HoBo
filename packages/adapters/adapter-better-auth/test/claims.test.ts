import { describe, expect, it } from "vitest";
import {
	BETTER_AUTH_ACCEPTED_CLAIM_KEYS,
	BETTER_AUTH_CLAIMS_MAPPING_VERSION,
	BetterAuthClaimsError,
	mapClaimsToPrincipal,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

function claims(overrides: JsonObject = {}): JsonObject {
	return { sub: "user_01", iss: "https://app.example.com", ...overrides };
}

function codeOf(run: () => void): string {
	try {
		run();
	} catch (error) {
		if (error instanceof BetterAuthClaimsError) return error.code;
		return `unexpected:${String(error)}`;
	}
	return "no-throw";
}

describe("mapClaimsToPrincipal", () => {
	it("version-stamps every principal it produces", () => {
		expect(mapClaimsToPrincipal(claims()).claimsMappingVersion).toBe(
			BETTER_AUTH_CLAIMS_MAPPING_VERSION,
		);
	});

	it("returns a frozen record with no optional key set to undefined", () => {
		const principal = mapClaimsToPrincipal(claims());
		expect(Object.isFrozen(principal)).toBe(true);
		expect(Object.keys(principal)).toEqual([
			"subject",
			"issuer",
			"roles",
			"claimsMappingVersion",
		]);
	});

	it("is deterministic across repeated calls and claim key order", () => {
		const first = mapClaimsToPrincipal({
			sub: "user_01",
			iss: "https://app.example.com",
			roles: ["member", "admin"],
			email: "ada@example.com",
		});
		const second = mapClaimsToPrincipal({
			email: "ada@example.com",
			roles: ["admin", "member"],
			iss: "https://app.example.com",
			sub: "user_01",
		});
		expect(first).toEqual(second);
		expect(first.roles).toEqual(["admin", "member"]);
	});

	it("unions role and roles, dedupes, and sorts", () => {
		expect(
			mapClaimsToPrincipal(
				claims({ role: "owner", roles: ["member", "owner"] }),
			).roles,
		).toEqual(["member", "owner"]);
	});

	it("maps tenancy only from activeOrganizationId", () => {
		expect(
			mapClaimsToPrincipal(claims({ activeOrganizationId: "org_hobo" }))
				.organizationId,
		).toBe("org_hobo");
	});

	it("accepts registered JWT claims for shape without projecting them", () => {
		const principal = mapClaimsToPrincipal(
			claims({
				aud: "hobo",
				exp: 4102444800,
				iat: 1700000000,
				nbf: 1700000000,
				jti: "tok_01",
				name: "Ada",
				emailVerified: true,
			}),
		);
		expect(Object.keys(principal)).toEqual([
			"subject",
			"issuer",
			"roles",
			"claimsMappingVersion",
		]);
	});

	it("never consults a clock: an expired-looking exp still maps", () => {
		expect(mapClaimsToPrincipal(claims({ exp: 1 })).subject).toBe("user_01");
	});

	it.each([
		[
			"a raw token string",
			"eyJhbGciOiJIUzI1NiJ9.x.y",
			"BETTER_AUTH_CLAIMS_SHAPE_INVALID",
		],
		["an array", [], "BETTER_AUTH_CLAIMS_SHAPE_INVALID"],
		["null", null, "BETTER_AUTH_CLAIMS_SHAPE_INVALID"],
	])("rejects %s", (_label, input, expected) => {
		expect(codeOf(() => mapClaimsToPrincipal(input))).toBe(expected);
	});

	it.each([
		[{ sub: undefined }, "missing sub"],
		[{ sub: "" }, "empty sub"],
		[{ sub: 12 }, "numeric sub"],
		[{ sub: "user 01" }, "whitespace in sub"],
	])("rejects %j (%s)", (overrides) => {
		expect(codeOf(() => mapClaimsToPrincipal(claims(overrides)))).toBe(
			"BETTER_AUTH_CLAIMS_SUBJECT_INVALID",
		);
	});

	it.each([
		[{ iss: undefined }, "missing iss"],
		[{ iss: "better-auth" }, "not a URL"],
		[{ iss: "https://user:pw@app.example.com" }, "userinfo in the issuer"],
	])("rejects %j (%s)", (overrides) => {
		expect(codeOf(() => mapClaimsToPrincipal(claims(overrides)))).toBe(
			"BETTER_AUTH_CLAIMS_ISSUER_INVALID",
		);
	});

	it.each([
		[{ email: "not-an-email" }, "no domain"],
		[{ email: 5 }, "not a string"],
	])("rejects %j (%s)", (overrides) => {
		expect(codeOf(() => mapClaimsToPrincipal(claims(overrides)))).toBe(
			"BETTER_AUTH_CLAIMS_EMAIL_INVALID",
		);
	});

	it("rejects a structured organization claim rather than flattening it", () => {
		expect(
			codeOf(() =>
				mapClaimsToPrincipal(claims({ activeOrganizationId: { id: "org" } })),
			),
		).toBe("BETTER_AUTH_CLAIMS_ORGANIZATION_INVALID");
	});

	it.each([
		[{ roles: "admin,member" }, "a delimited string is not split"],
		[{ roles: [1] }, "a non-string entry"],
		[{ role: "Admin" }, "an uppercase role slug"],
		[{ roles: [""] }, "an empty role slug"],
	])("rejects %j (%s)", (overrides) => {
		expect(codeOf(() => mapClaimsToPrincipal(claims(overrides)))).toBe(
			"BETTER_AUTH_CLAIMS_ROLE_INVALID",
		);
	});

	it.each([
		[{ exp: "4102444800" }, "a string exp"],
		[{ iat: Number.NaN }, "a non-finite iat"],
		[{ jti: 7 }, "a numeric jti"],
		[{ aud: [""] }, "an empty audience entry"],
		[{ emailVerified: "true" }, "a stringly boolean"],
		[{ name: "" }, "an empty display name"],
	])("rejects %j (%s)", (overrides) => {
		expect(codeOf(() => mapClaimsToPrincipal(claims(overrides)))).toBe(
			"BETTER_AUTH_CLAIMS_REGISTERED_CLAIM_INVALID",
		);
	});

	it.each([
		[{ groups: ["engineering"] }, "an Entra-shaped group claim"],
		[{ organization_id: "org_hobo" }, "a snake_case tenancy claim"],
		[{ scope: "openid profile" }, "an OAuth scope claim"],
	])("rejects unknown claim %j rather than coercing it (%s)", (overrides) => {
		expect(codeOf(() => mapClaimsToPrincipal(claims(overrides)))).toBe(
			"BETTER_AUTH_CLAIMS_UNKNOWN_FIELD",
		);
	});

	it("names the accepted vocabulary in the unknown-claim remediation", () => {
		try {
			mapClaimsToPrincipal(claims({ groups: ["engineering"] }));
			throw new Error("expected a refusal");
		} catch (error) {
			// SAFETY: assertion to `error as BetterAuthClaimsError` is required at this boundary.
			const refusal = error as BetterAuthClaimsError;
			expect(refusal.name).toBe("BetterAuthClaimsError");
			for (const key of BETTER_AUTH_ACCEPTED_CLAIM_KEYS) {
				expect(refusal.remediation).toContain(key);
			}
		}
	});
});
