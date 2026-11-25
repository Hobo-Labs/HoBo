import { describe, expect, it } from "vitest";

import {
	AUTH_ADAPTER_CONTRACT,
	assertBetterAuthRuntimeAvailable,
	BETTER_AUTH_ADAPTER_ID,
	BETTER_AUTH_CLAIMS_MAPPING_VERSION,
	BETTER_AUTH_DESCRIPTOR,
	BETTER_AUTH_REQUIRED_PORTS,
	BETTER_AUTH_RUNTIME_MODULE,
	BETTER_AUTH_SECRET_REF_SCHEMES,
	BetterAuthRuntimeUnavailableError,
} from "../src/index.js";

describe("BETTER_AUTH_DESCRIPTOR", () => {
	it("registers Better Auth as the self-hosted, organization-capable issuer", () => {
		expect(BETTER_AUTH_DESCRIPTOR).toEqual({
			contract: AUTH_ADAPTER_CONTRACT,
			id: BETTER_AUTH_ADAPTER_ID,
			displayName: "Better Auth",
			hosting: "self-hosted",
			requiredPorts: ["hobo:data/relational", "hobo:http", "hobo:secrets"],
			claimsMappingVersion: BETTER_AUTH_CLAIMS_MAPPING_VERSION,
			supportsOrganizations: true,
		});
	});

	it("is frozen, ports included, so a consumer cannot mutate the registry entry", () => {
		expect(Object.isFrozen(BETTER_AUTH_DESCRIPTOR)).toBe(true);
		expect(Object.isFrozen(BETTER_AUTH_DESCRIPTOR.requiredPorts)).toBe(true);
	});

	it.each([
		["hobo:data/relational", "auth tables live in the governed data plane"],
		["hobo:secrets", "the signing secret is brokered, never app-held"],
		["hobo:http", "routes mount on the declared api()/web() surface"],
	])("declares %s because %s", (port) => {
		expect(BETTER_AUTH_DESCRIPTOR.requiredPorts).toContain(port);
	});

	it("lists required ports sorted, so the descriptor is byte-stable", () => {
		expect([...BETTER_AUTH_REQUIRED_PORTS]).toEqual(
			[...BETTER_AUTH_REQUIRED_PORTS].sort(),
		);
	});

	it("owns no private infrastructure port outside the composed three", () => {
		expect(BETTER_AUTH_REQUIRED_PORTS).toHaveLength(3);
	});
});

describe("assertBetterAuthRuntimeAvailable", () => {
	it("refuses when the runtime dependency is absent", () => {
		expect(() => assertBetterAuthRuntimeAvailable()).toThrow(
			BetterAuthRuntimeUnavailableError,
		);
		expect(() =>
			assertBetterAuthRuntimeAvailable({ runtimePresent: false }),
		).toThrow(BetterAuthRuntimeUnavailableError);
	});

	it("refuses with a code and remediation instead of degrading to the built-in issuer", () => {
		try {
			assertBetterAuthRuntimeAvailable();
			throw new Error("expected a refusal");
		} catch (error) {
			// SAFETY: assertion to `error as BetterAuthRuntimeUnavailableError` is required at this boundary.
			const refusal = error as BetterAuthRuntimeUnavailableError;
			expect(refusal.name).toBe("BetterAuthRuntimeUnavailableError");
			expect(refusal.code).toBe("BETTER_AUTH_RUNTIME_UNAVAILABLE");
			expect(refusal.remediation).toContain(BETTER_AUTH_RUNTIME_MODULE);
			expect(refusal.remediation).toMatch(/passkey|magic-link/u);
		}
	});

	it("passes when the host reports the runtime present", () => {
		expect(() =>
			assertBetterAuthRuntimeAvailable({ runtimePresent: true }),
		).not.toThrow();
	});
});

describe("locator vocabulary", () => {
	it("mirrors the platform secret-ref scheme set exactly", () => {
		expect([...BETTER_AUTH_SECRET_REF_SCHEMES]).toEqual([
			"aws-sm",
			"azure-kv",
			"gcp-sm",
			"hobo-secret",
			"hobo-token",
			"infisical",
			"op",
			"vault",
		]);
	});
});
