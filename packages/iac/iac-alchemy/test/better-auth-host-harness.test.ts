import { createMemorySecretsPort } from "@hobo/identity";
import {
	campSecretNameFromBetterAuthRef,
	planBetterAuthBundle,
	planBetterAuthRelationalMigrations,
	wireBetterAuthSigningSecret,
} from "@hobo/pack-better-auth";
import { describe, expect, it } from "vitest";

import {
	createBetterAuthHostHarness,
	parseBetterAuthHostDotEnv,
} from "./better-auth-host-harness.js";

const SYNTHETIC_SIGNING =
	"synthetic-better-auth-signing-secret-0123456789abcdef0123456789ab";

describe("better-auth Alchemy host harness", () => {
	it("maps construction-time dotenv keys into a pack bundle plan", async () => {
		const harness = createBetterAuthHostHarness();
		try {
			const inputs = parseBetterAuthHostDotEnv(harness.dotEnv);
			const bundlePlan = planBetterAuthBundle(
				inputs.configInput,
				inputs.portsInput,
			);
			const migrations = planBetterAuthRelationalMigrations(bundlePlan);
			expect(migrations.migrationPlan.steps.length).toBeGreaterThan(0);
			expect(harness.createInMemoryAlchemyState()).toBeDefined();
		} finally {
			harness.dispose();
		}
	});

	it("wires the brokered signing secret through the camp port after dotenv-shaped inputs", async () => {
		const harness = createBetterAuthHostHarness();
		try {
			const inputs = parseBetterAuthHostDotEnv(harness.dotEnv);
			const bundlePlan = planBetterAuthBundle(
				inputs.configInput,
				inputs.portsInput,
			);
			const port = createMemorySecretsPort({ id: "secrets:better-auth-host" });
			const name = campSecretNameFromBetterAuthRef(
				bundlePlan.config.secretRef,
				inputs.campAuthority,
			);
			await port.put(name, SYNTHETIC_SIGNING);
			const wire = await wireBetterAuthSigningSecret(bundlePlan, port, {
				campAuthority: inputs.campAuthority,
				now: "2026-11-25T00:00:00.000Z",
			});
			expect(wire.secretsPortId).toBe("secrets:better-auth-host");
			expect(JSON.stringify(wire)).not.toContain(SYNTHETIC_SIGNING);
			expect(harness.sqlite).toBe(harness.sessionStorePath);
		} finally {
			harness.dispose();
		}
	});
});
