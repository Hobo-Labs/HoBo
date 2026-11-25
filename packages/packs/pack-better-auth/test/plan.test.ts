import { describe, expect, it } from "vitest";

import {
	assertBetterAuthRuntimeAvailable,
	BETTER_AUTH_RUNTIME_MODULE,
	BetterAuthBundlePlanError,
	BetterAuthRuntimeUnavailableError,
	parseBetterAuthConfig,
	planBetterAuthBundle,
	toBetterAuthBundlePlanRecord,
} from "../src/index.js";

const CONFIG_INPUT = {
	basePath: "/api/auth",
	secretRef: "hobo-secret://camp-prod/auth/better-auth-signing-key",
	database: { profile: "data.relational/v1" },
	emailAndPassword: { enabled: true },
	socialProviders: ["github"],
	organizations: { enabled: true },
};

const CONFIG = parseBetterAuthConfig(CONFIG_INPUT);

const PORTS = {
	relationalBindle: "auth_db",
	httpBindle: "auth_api",
	signingSecretRef: CONFIG.secretRef,
} as const;

describe("planBetterAuthBundle", () => {
	it("returns a frozen plan without execution gating by default", () => {
		const plan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		expect(plan.packId).toBe("pack.better-auth/v1");
		expect(plan.routePattern).toBe("/api/auth/*");
		expect(plan.ports.relationalBindle).toBe("auth_db");
		expect(Object.isFrozen(plan)).toBe(true);
	});

	it("projects the full parsed config into the durable plan record", () => {
		const plan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		const record = toBetterAuthBundlePlanRecord(plan);
		expect(record.parsed_config.database_profile).toBe("data.relational/v1");
		expect(record.parsed_config.email_and_password_enabled).toBe(true);
		expect(record.parsed_config.social_providers).toEqual(["github"]);
		expect(record.parsed_config.organizations_enabled).toBe(true);
		expect(record.parsed_config.secret_ref).toBe(CONFIG.secretRef);
	});

	it("refuses a signing locator mismatch", () => {
		expect(() =>
			planBetterAuthBundle(CONFIG_INPUT, {
				...PORTS,
				signingSecretRef: "hobo-secret://camp-prod/auth/other",
			}),
		).toThrow(BetterAuthBundlePlanError);
	});

	it("refuses execution when the runtime is absent", () => {
		expect(() =>
			planBetterAuthBundle(CONFIG_INPUT, PORTS, {
				forExecution: true,
				runtimePresent: false,
			}),
		).toThrow(BetterAuthRuntimeUnavailableError);
	});

	it("allows execution planning when the runtime is declared present", () => {
		expect(() =>
			planBetterAuthBundle(CONFIG_INPUT, PORTS, {
				forExecution: true,
				runtimePresent: true,
			}),
		).not.toThrow();
	});
});

describe("assertBetterAuthRuntimeAvailable", () => {
	it("names the better-auth module in remediation", () => {
		try {
			assertBetterAuthRuntimeAvailable({ runtimePresent: false });
		} catch (error) {
			expect(error).toBeInstanceOf(BetterAuthRuntimeUnavailableError);
			expect(String(error)).toContain(BETTER_AUTH_RUNTIME_MODULE);
		}
	});
});
