import {
	campSecretNameFromBetterAuthRef,
	planBetterAuthBundle,
	planBetterAuthRelationalMigrations,
	wireBetterAuthSigningSecret,
} from "@hobo/pack-better-auth";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	createBetterAuthHostHarness,
	parseBetterAuthHostDotEnv,
} from "./better-auth-host-harness.js";
import {
	loadSyntheticBetterAuthSession,
	openBetterAuthSessionStore,
	recordSyntheticBetterAuthSignIn,
} from "./better-auth-session-durability.js";

const SYNTHETIC_SIGNING =
	"synthetic-better-auth-signing-secret-0123456789abcdef0123456789ab";

describe("better-auth onboarding steps", () => {
	it("chains construction config, bundle plan, migrations, broker wire, and first session", async () => {
		const harness = createBetterAuthHostHarness();
		const database = openBetterAuthSessionStore(harness.sessionStorePath);
		try {
			const inputs = parseBetterAuthHostDotEnv(harness.dotEnv);
			const bundlePlan = planBetterAuthBundle(
				inputs.configInput,
				inputs.portsInput,
			);
			const migrations = planBetterAuthRelationalMigrations(bundlePlan);
			const port = createMemorySecretsPort({ id: "secrets:onboarding" });
			const secretName = campSecretNameFromBetterAuthRef(
				bundlePlan.config.secretRef,
				inputs.campAuthority,
			);
			await port.put(secretName, SYNTHETIC_SIGNING);
			const wire = await wireBetterAuthSigningSecret(bundlePlan, port, {
				campAuthority: inputs.campAuthority,
				now: "2026-11-25T00:00:00.000Z",
			});
			const signedIn = recordSyntheticBetterAuthSignIn(database);
			expect(migrations.migrationPlan.steps.length).toBeGreaterThan(0);
			expect(wire.secretRef).toBe(inputs.configInput.secretRef);
			expect(
				loadSyntheticBetterAuthSession(database, signedIn.sessionToken),
			).toEqual(signedIn);
		} finally {
			database.close();
			harness.dispose();
		}
	});
});
