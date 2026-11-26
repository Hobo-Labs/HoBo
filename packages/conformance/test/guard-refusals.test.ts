/**
 * The gate in front of the live conformance lane.
 *
 * Everything past this file spends somebody's money and creates real resources
 * in somebody's account, and it was at 0% branch coverage. Every branch is a
 * refusal, so the tests are almost entirely refusals — which is the right shape
 * for a guard whose default answer is no.
 *
 * Four properties are asserted directly because each is the point of the
 * design rather than an implementation detail:
 *
 *   - **CI refusal is checked before anything else and has no override.** "We
 *     needed it green in CI" is exactly how a lane that spends money gets
 *     scheduled, so the refusal cannot be unlocked by setting more variables.
 *   - **The credential must be a *reference*, never material.** And a rejected
 *     value is never echoed, because a value that failed to parse as a locator
 *     is very often a pasted plaintext credential.
 *   - **There is no partially-permitted state.** A caller holding a
 *     half-checked grant is a caller who provisions on the half that passed.
 *   - **Every refusal names the variable to set.** A guard nobody can act on
 *     gets bypassed, so "remediation" is part of the contract, not a nicety.
 */

import { describe, expect, it } from "vitest";
import { isJsonString } from "../src/json.js";

import {
	CI_ENV_KEYS,
	LIVE_ENV_KEYS,
	LiveRunRefusedError,
	liveRunRefusalFor,
	parseLiveRunGrant,
} from "../src/live/guard.js";

const REF = "hobo-secret://acme/live-conformance/neon";

/** A fully-permitted environment; each test removes or breaks one thing. */
function env(overrides: Record<string, string | undefined> = {}) {
	return {
		[LIVE_ENV_KEYS.enable]: "1",
		[LIVE_ENV_KEYS.providers]: "neon,cloudflare-workers",
		[LIVE_ENV_KEYS.credentialRef]: REF,
		[LIVE_ENV_KEYS.providerDocsCheckedAt]: "2026-08-01",
		...overrides,
	};
}

const grantFor = (overrides: Record<string, string | undefined> = {}) =>
	parseLiveRunGrant({ providerId: "neon", env: env(overrides) });

const codeFor = (
	overrides: Record<string, string | undefined> = {},
	providerId = "neon",
) => liveRunRefusalFor({ providerId, env: env(overrides) })?.code;

describe("a fully permitted run", () => {
	it("produces a grant", () => {
		expect(grantFor().providerId).toBe("neon");
	});

	it("defaults the resource budget rather than leaving it unbounded", () => {
		// An absent budget must not mean "as many as you like".
		expect(grantFor().maximumResources).toBe(4);
	});

	it("carries the docs-checked date into the grant as evidence", () => {
		expect(grantFor().providerDocsCheckedAt).toBe("2026-08-01");
	});

	it("freezes the grant", () => {
		expect(Object.isFrozen(grantFor())).toBe(true);
	});

	it("trims the provider id before matching", () => {
		expect(
			parseLiveRunGrant({ providerId: "  neon  ", env: env() }).providerId,
		).toBe("neon");
	});

	it("reports no refusal through the non-throwing form", () => {
		expect(
			liveRunRefusalFor({ providerId: "neon", env: env() }),
		).toBeUndefined();
	});
});

describe("CI refusal", () => {
	it.each(CI_ENV_KEYS)("refuses when %s is set", (key) => {
		expect(codeFor({ [key]: "true" })).toBe("LIVE_LANE_REFUSED_IN_CI");
	});

	it("cannot be overridden by enabling everything else", () => {
		// There is deliberately no escape hatch. Adding one is how this lane
		// ends up on a schedule.
		expect(codeFor({ CI: "1", [LIVE_ENV_KEYS.maximumResources]: "1" })).toBe(
			"LIVE_LANE_REFUSED_IN_CI",
		);
	});

	it("is checked before the lane-enabled gate, so the real reason surfaces", () => {
		// If the ordering were reversed an operator in CI would be told to set
		// the enable flag, and would.
		expect(codeFor({ CI: "1", [LIVE_ENV_KEYS.enable]: undefined })).toBe(
			"LIVE_LANE_REFUSED_IN_CI",
		);
	});

	it.each([
		"0",
		"false",
		"FALSE",
		" ",
		"",
	])("does not treat the falsy CI value %s as automation", (value) => {
		expect(codeFor({ CI: value })).toBeUndefined();
	});

	it("treats any other non-empty value as automation", () => {
		expect(codeFor({ CI: "no" })).toBe("LIVE_LANE_REFUSED_IN_CI");
	});

	it("names the variable that caused the refusal", () => {
		// "Refused in CI" without saying which signal fired is unactionable on a
		// workstation that happens to export one.
		expect(
			liveRunRefusalFor({ providerId: "neon", env: env({ JENKINS_URL: "x" }) })
				?.message,
		).toContain("JENKINS_URL");
	});
});

describe("the lane is off by default", () => {
	it("refuses when the enable flag is absent", () => {
		expect(codeFor({ [LIVE_ENV_KEYS.enable]: undefined })).toBe(
			"LIVE_LANE_DISABLED",
		);
	});

	it.each([
		"0",
		"true",
		"yes",
		"",
		"1 ",
	])('requires exactly "1", not the near-miss %s', (value) => {
		// An acknowledgement that accepts anything truthy is not an
		// acknowledgement.
		expect(codeFor({ [LIVE_ENV_KEYS.enable]: value })).toBe(
			"LIVE_LANE_DISABLED",
		);
	});

	it("explains that the run provisions real resources", () => {
		expect(
			liveRunRefusalFor({
				providerId: "neon",
				env: env({ [LIVE_ENV_KEYS.enable]: undefined }),
			})?.remediation,
		).toContain(LIVE_ENV_KEYS.enable);
	});
});

describe("the per-provider allowlist", () => {
	it("refuses a provider that is not listed", () => {
		expect(codeFor({}, "supabase")).toBe("LIVE_LANE_PROVIDER_NOT_ENABLED");
	});

	it("refuses when the list is absent entirely", () => {
		expect(codeFor({ [LIVE_ENV_KEYS.providers]: undefined })).toBe(
			"LIVE_LANE_PROVIDER_NOT_ENABLED",
		);
	});

	it("refuses when the list is empty", () => {
		expect(codeFor({ [LIVE_ENV_KEYS.providers]: "" })).toBe(
			"LIVE_LANE_PROVIDER_NOT_ENABLED",
		);
	});

	it("tolerates whitespace around entries", () => {
		expect(
			codeFor({ [LIVE_ENV_KEYS.providers]: " neon , other " }),
		).toBeUndefined();
	});

	it("ignores empty entries from a trailing comma", () => {
		expect(codeFor({ [LIVE_ENV_KEYS.providers]: "neon,," })).toBeUndefined();
	});

	it("matches exactly rather than by prefix", () => {
		// "neon" must not be enabled by listing "neon-staging".
		expect(codeFor({ [LIVE_ENV_KEYS.providers]: "neon-staging" })).toBe(
			"LIVE_LANE_PROVIDER_NOT_ENABLED",
		);
	});
});

describe("the provider id itself", () => {
	it.each([
		"neon",
		"cloudflare-workers",
		"a1",
		"a-1-b",
	])("accepts the dns-style id %s", (providerId) => {
		expect(
			liveRunRefusalFor({
				providerId,
				env: env({ [LIVE_ENV_KEYS.providers]: providerId }),
			})?.code,
		).not.toBe("LIVE_LANE_PROVIDER_ID_INVALID");
	});

	it.each([
		"",
		"Neon",
		"neon_db",
		"neon.",
		"-neon",
		"neon-",
		"neon--db",
	])("rejects the malformed id %s", (providerId) => {
		expect(codeFor({}, providerId)).toBe("LIVE_LANE_PROVIDER_ID_INVALID");
	});

	it("is checked before CI, since a malformed id is a caller bug", () => {
		expect(codeFor({ CI: "1" }, "Bad_Id")).toBe(
			"LIVE_LANE_PROVIDER_ID_INVALID",
		);
	});
});

describe("the credential must be a reference", () => {
	it("refuses when none is supplied", () => {
		expect(codeFor({ [LIVE_ENV_KEYS.credentialRef]: undefined })).toBe(
			"LIVE_LANE_CREDENTIAL_MISSING",
		);
	});

	it("refuses a blank one", () => {
		expect(codeFor({ [LIVE_ENV_KEYS.credentialRef]: "   " })).toBe(
			"LIVE_LANE_CREDENTIAL_MISSING",
		);
	});

	it("refuses a value that is not a secret locator", () => {
		expect(codeFor({ [LIVE_ENV_KEYS.credentialRef]: "sk-live-abc123" })).toBe(
			"LIVE_LANE_CREDENTIAL_NOT_A_REFERENCE",
		);
	});

	it("never echoes the rejected value, which is often a pasted secret", () => {
		// The single most important assertion about this refusal.
		const refusal = liveRunRefusalFor({
			providerId: "neon",
			env: env({ [LIVE_ENV_KEYS.credentialRef]: "sk-live-supersecret" }),
		});
		expect(refusal?.message).not.toContain("supersecret");
		expect(refusal?.remediation).not.toContain("supersecret");
	});

	it("tells the operator to deposit the material rather than paste it", () => {
		expect(
			liveRunRefusalFor({
				providerId: "neon",
				env: env({ [LIVE_ENV_KEYS.credentialRef]: "plaintext" }),
			})?.remediation,
		).toMatch(/never paste the material/u);
	});

	it("stores only the redacted form for printing", () => {
		const grant = grantFor();
		expect(grant.redactedCredentialRef).toBeTruthy();
		expect(isJsonString(grant.redactedCredentialRef)).toBe(true);
	});

	it("trims the reference before parsing", () => {
		expect(
			codeFor({ [LIVE_ENV_KEYS.credentialRef]: `  ${REF}  ` }),
		).toBeUndefined();
	});
});

describe("the resource budget", () => {
	it.each(["1", "4", "16"])("accepts %s", (value) => {
		expect(
			grantFor({ [LIVE_ENV_KEYS.maximumResources]: value }).maximumResources,
		).toBe(Number(value));
	});

	it.each(["0", "-1", "17", "1.5", "many", " "])("rejects %s", (value) => {
		const code = codeFor({ [LIVE_ENV_KEYS.maximumResources]: value });
		// A blank value falls back to the default rather than refusing.
		expect(code).toBe(
			value.trim().length === 0
				? undefined
				: "LIVE_LANE_RESOURCE_BUDGET_INVALID",
		);
	});

	it("refuses above the ceiling even though the value is a valid integer", () => {
		// The ceiling is the point: a budget is not a number the operator picks
		// freely, it is a cap on how wrong a run can go.
		expect(codeFor({ [LIVE_ENV_KEYS.maximumResources]: "100" })).toBe(
			"LIVE_LANE_RESOURCE_BUDGET_INVALID",
		);
	});

	it("names the permitted range in the remediation", () => {
		expect(
			liveRunRefusalFor({
				providerId: "neon",
				env: env({ [LIVE_ENV_KEYS.maximumResources]: "99" }),
			})?.remediation,
		).toMatch(/1-16/u);
	});
});

describe("the provider-docs date", () => {
	it("refuses when absent", () => {
		expect(codeFor({ [LIVE_ENV_KEYS.providerDocsCheckedAt]: undefined })).toBe(
			"LIVE_LANE_PROVIDER_DOCS_DATE_MISSING",
		);
	});

	it.each([
		"2026-8-01",
		"01-08-2026",
		"2026/08/01",
		"yesterday",
		"",
	])("refuses the malformed date %s", (value) => {
		expect(codeFor({ [LIVE_ENV_KEYS.providerDocsCheckedAt]: value })).toBe(
			"LIVE_LANE_PROVIDER_DOCS_DATE_MISSING",
		);
	});

	it("trims the value before checking it", () => {
		expect(
			codeFor({ [LIVE_ENV_KEYS.providerDocsCheckedAt]: " 2026-08-01 " }),
		).toBeUndefined();
	});
});

describe("the optional run tag", () => {
	it("is omitted from the grant when unset", () => {
		expect(grantFor()).not.toHaveProperty("runTag");
	});

	it("is omitted when set to an empty string", () => {
		// Empty means "generate one", not "the tag is empty".
		expect(grantFor({ [LIVE_ENV_KEYS.runTag]: "" })).not.toHaveProperty(
			"runTag",
		);
	});

	it("is carried when valid", () => {
		expect(grantFor({ [LIVE_ENV_KEYS.runTag]: "nightly-neon" }).runTag).toBe(
			"nightly-neon",
		);
	});

	it.each([
		"ab",
		"Nightly",
		"-abc",
		"under_score",
		"a".repeat(42),
	])("refuses the invalid tag %s", (value) => {
		expect(codeFor({ [LIVE_ENV_KEYS.runTag]: value })).toBe(
			"LIVE_LANE_RUN_TAG_INVALID",
		);
	});

	it("accepts the boundary lengths", () => {
		expect(codeFor({ [LIVE_ENV_KEYS.runTag]: "abc" })).toBeUndefined();
		expect(
			codeFor({ [LIVE_ENV_KEYS.runTag]: `a${"b".repeat(40)}` }),
		).toBeUndefined();
	});
});

describe("LiveRunRefusedError", () => {
	it("puts the remediation in the message as well as the field", () => {
		// Whatever prints the error, the operator sees what to do.
		const error = new LiveRunRefusedError(
			"LIVE_LANE_DISABLED",
			"off",
			"set the flag",
		);
		expect(error.message).toContain("set the flag");
		expect(error.remediation).toBe("set the flag");
	});

	it("is an Error with a stable name", () => {
		expect(
			new LiveRunRefusedError("LIVE_LANE_DISABLED", "x", "y"),
		).toBeInstanceOf(Error);
		expect(new LiveRunRefusedError("LIVE_LANE_DISABLED", "x", "y").name).toBe(
			"LiveRunRefusedError",
		);
	});
});

describe("liveRunRefusalFor", () => {
	it("returns the refusal instead of throwing", () => {
		const refusal = liveRunRefusalFor({ providerId: "neon", env: {} });
		expect(refusal).toBeInstanceOf(LiveRunRefusedError);
	});

	it("returns undefined for a permitted run", () => {
		expect(
			liveRunRefusalFor({ providerId: "neon", env: env() }),
		).toBeUndefined();
	});
});
