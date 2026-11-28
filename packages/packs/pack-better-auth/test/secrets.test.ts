import { randomBytes, randomUUID } from "node:crypto";

import { parseBetterAuthConfig } from "@hobo/auth-adapter-contract";
import { createMemorySecretsPort, type SecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import { BetterAuthBundlePlanError } from "../src/errors.js";
import {
	campSecretNameFromBetterAuthRef,
	wireBetterAuthSigningSecret,
} from "../src/index.js";
import { planBetterAuthBundle } from "../src/plan.js";

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
		expect(wire.resolvedAtIso).toBe("2026-11-25T00:00:00.000Z");
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

	it("refuses an empty secrets port id before accessing custody", async () => {
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		await expect(
			wireBetterAuthSigningSecret(bundlePlan, unreadSecretsPort(""), {
				campAuthority: "camp-prod",
			}),
		).rejects.toMatchObject({ code: "BETTER_AUTH_BUNDLE_PORT_INVALID" });
	});

	it("refuses a non-canonical wire timestamp before accessing custody", async () => {
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		await expect(
			wireBetterAuthSigningSecret(
				bundlePlan,
				unreadSecretsPort("secrets:memory"),
				{
					campAuthority: "camp-prod",
					now: "2026-11-25T00:00:00Z",
				},
			),
		).rejects.toMatchObject({ code: "BETTER_AUTH_BUNDLE_PORT_INVALID" });
	});

	it("accepts a valid leap-day wire timestamp", async () => {
		const port = createMemorySecretsPort();
		await port.put(
			campSecretNameFromBetterAuthRef(PORTS.signingSecretRef, "camp-prod"),
			SYNTHETIC_SIGNING,
		);
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		const wire = await wireBetterAuthSigningSecret(bundlePlan, port, {
			campAuthority: "camp-prod",
			now: "2024-02-29T12:34:56.789Z",
		});
		expect(wire.resolvedAtIso).toBe("2024-02-29T12:34:56.789Z");
	});

	it.each([
		"2026-02-30T00:00:00.000Z",
		"2026-13-01T00:00:00.000Z",
		"2026-01-01T24:00:00.000Z",
	])("refuses an invalid calendar timestamp %s before accessing custody", async (now) => {
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		await expect(
			wireBetterAuthSigningSecret(
				bundlePlan,
				unreadSecretsPort("secrets:memory"),
				{
					campAuthority: "camp-prod",
					now,
				},
			),
		).rejects.toMatchObject({ code: "BETTER_AUTH_BUNDLE_PORT_INVALID" });
	});

	it("refuses when the locator would carry the signing material", async () => {
		const material = randomBytes(32).toString("hex");
		const secretRef = `hobo-secret://camp-prod/auth/${material}`;
		const input = { ...CONFIG_INPUT, secretRef };
		const ref = parseBetterAuthConfig(input).secretRef;
		const bundlePlan = planBetterAuthBundle(input, {
			...PORTS,
			signingSecretRef: ref,
		});
		const port = createMemorySecretsPort();
		await port.put(campSecretNameFromBetterAuthRef(ref, "camp-prod"), material);
		let rejected: unknown;
		try {
			await wireBetterAuthSigningSecret(bundlePlan, port, {
				campAuthority: "camp-prod",
				now: "2026-11-25T00:00:00.000Z",
			});
		} catch (error) {
			rejected = error;
		}
		expect(rejected).toBeInstanceOf(BetterAuthBundlePlanError);
		if (!(rejected instanceof BetterAuthBundlePlanError)) {
			throw new Error("expected BetterAuthBundlePlanError");
		}
		expect(rejected.code).toBe("BETTER_AUTH_SIGNING_SECRET_EXPOSED");
		expect(rejected.message.includes(material)).toBe(false);
		expect(rejected.remediation.includes(material)).toBe(false);
	});

	it("refuses when the secrets port id would carry the signing material", async () => {
		const material = randomBytes(32).toString("hex");
		const port = createMemorySecretsPort({ id: `secrets:${material}` });
		const name = campSecretNameFromBetterAuthRef(
			PORTS.signingSecretRef,
			"camp-prod",
		);
		await port.put(name, material);
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		let rejected: unknown;
		try {
			await wireBetterAuthSigningSecret(bundlePlan, port, {
				campAuthority: "camp-prod",
				now: "2026-11-25T00:00:00.000Z",
			});
		} catch (error) {
			rejected = error;
		}
		expect(rejected).toBeInstanceOf(BetterAuthBundlePlanError);
		if (!(rejected instanceof BetterAuthBundlePlanError)) {
			throw new Error("expected BetterAuthBundlePlanError");
		}
		expect(rejected.code).toBe("BETTER_AUTH_SIGNING_SECRET_EXPOSED");
		expect(rejected.message.includes(material)).toBe(false);
		expect(rejected.remediation.includes(material)).toBe(false);
	});

	it("refuses when signing material is only a cross-field splice in the wire JSON", async () => {
		const portId = randomUUID();
		const now = "2026-11-25T00:00:00.000Z";
		const material = `signing-key","secretScheme":"hobo-secret","secretsPortId":"${portId}`;
		const wire = {
			secretRef: PORTS.signingSecretRef,
			secretScheme: "hobo-secret",
			secretsPortId: portId,
			resolvedAtIso: now,
		};
		expect(portId.length).toBeGreaterThan(0);
		expect(wire.secretRef.includes(material)).toBe(false);
		expect(wire.secretScheme.includes(material)).toBe(false);
		expect(wire.secretsPortId.includes(material)).toBe(false);
		expect(wire.resolvedAtIso.includes(material)).toBe(false);
		expect(JSON.stringify(wire).includes(material)).toBe(true);

		const port = createMemorySecretsPort({ id: portId });
		await port.put(
			campSecretNameFromBetterAuthRef(PORTS.signingSecretRef, "camp-prod"),
			material,
		);
		const bundlePlan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		let rejected: unknown;
		try {
			await wireBetterAuthSigningSecret(bundlePlan, port, {
				campAuthority: "camp-prod",
				now,
			});
		} catch (error) {
			rejected = error;
		}
		expect(rejected).toBeInstanceOf(BetterAuthBundlePlanError);
		if (!(rejected instanceof BetterAuthBundlePlanError)) {
			throw new Error("expected BetterAuthBundlePlanError");
		}
		expect(rejected.code).toBe("BETTER_AUTH_SIGNING_SECRET_EXPOSED");
		expect(rejected.message.includes(material)).toBe(false);
		expect(rejected.remediation.includes(material)).toBe(false);
	});
});

function unreadSecretsPort(id: string): SecretsPort {
	const deny = (): never => {
		throw new Error("custody was accessed");
	};
	return {
		id,
		kind: "memory-fixture",
		put: deny,
		access: deny,
		accessVersion: deny,
		listVersions: deny,
	};
}
