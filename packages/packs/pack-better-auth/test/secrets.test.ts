import { parseBetterAuthConfig } from "@hobo/auth-adapter-contract";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import { BetterAuthBundlePlanError } from "../src/errors.js";
import { planBetterAuthBundle } from "../src/plan.js";
import {
	campSecretNameFromBetterAuthRef,
	wireBetterAuthSigningSecret,
} from "../src/index.js";

const CONFIG_INPUT = {
	basePath: "/api/auth",
	secretRef: "hobo-secret://camp-prod/auth/better-auth-signing-key",
	database: { profile: "data.relational/v1" },
	emailAndPassword: { enabled: true },
	socialProviders: ["github"],
	organizations: { enabled: true },
};

const PORTS = {
	relationalBindle: "auth_db",
	httpBindle: "auth_api",
	signingSecretRef: parseBetterAuthConfig(CONFIG_INPUT).secretRef,
} as const;

const SYNTHETIC_SIGNING =
	"synthetic-better-auth-signing-secret-0123456789abcdef0123456789ab";

describe("wireBetterAuthSigningSecret", () => {
	it("resolves a brokered locator without returning material on the wire record", async () => {
		const port = createMemorySecretsPort();
		const name = campSecretNameFromBetterAuthRef(
			PORTS.signingSecretRef,
			"camp-prod",
		);
		await port.put(name, SYNTHETIC_SIGNING);
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		const wire = await wireBetterAuthSigningSecret(bundlePlan, port, {
			campAuthority: "camp-prod",
			now: "2026-11-25T00:00:00.000Z",
		});
		expect(wire.secretRef).toBe(PORTS.signingSecretRef);
		expect(wire.secretScheme).toBe("hobo-secret");
		expect(wire.secretsPortId).toBe(port.id);
		expect(JSON.stringify(wire)).not.toContain(SYNTHETIC_SIGNING);
	});

	it("refuses when custody does not hold the signing secret", async () => {
		const port = createMemorySecretsPort();
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		await expect(
			wireBetterAuthSigningSecret(bundlePlan, port, {
				campAuthority: "camp-prod",
			}),
		).rejects.toMatchObject({
			code: "BETTER_AUTH_SIGNING_SECRET_UNRESOLVED",
		} satisfies Partial<BetterAuthBundlePlanError>);
	});

	it("refuses brokered material shorter than the minimum length", async () => {
		const port = createMemorySecretsPort();
		const name = campSecretNameFromBetterAuthRef(
			PORTS.signingSecretRef,
			"camp-prod",
		);
		await port.put(name, "too-short");
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		await expect(
			wireBetterAuthSigningSecret(bundlePlan, port, {
				campAuthority: "camp-prod",
			}),
		).rejects.toMatchObject({
			code: "BETTER_AUTH_SIGNING_SECRET_WEAK",
		} satisfies Partial<BetterAuthBundlePlanError>);
	});

	it.each([
		["wrong camp", "hobo-secret://another-camp/auth/better-auth-signing-key"],
		["another provider", "vault://camp-prod/auth/better-auth-signing-key"],
		[
			"field selector",
			"hobo-secret://camp-prod/auth/better-auth-signing-key#value",
		],
	])("refuses a locator with a %s before accessing custody", async (_case, locator) => {
		const port = createMemorySecretsPort();
		const input = { ...CONFIG_INPUT, secretRef: locator };
		const ref = parseBetterAuthConfig(input).secretRef;
		const bundlePlan = planBetterAuthBundle(input, {
			...PORTS,
			signingSecretRef: ref,
		});
		await port.put("auth/better-auth-signing-key", SYNTHETIC_SIGNING);
		await expect(
			wireBetterAuthSigningSecret(bundlePlan, port, {
				campAuthority: "camp-prod",
			}),
		).rejects.toMatchObject({ code: "BETTER_AUTH_BUNDLE_PORT_INVALID" });
	});
});
