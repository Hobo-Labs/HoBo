import {
	campSecretNameFromBetterAuthRef,
	planBetterAuthBundle,
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
	simulateProcessRestart,
} from "./better-auth-session-durability.js";

const SYNTHETIC_SIGNING =
	"synthetic-better-auth-signing-secret-0123456789abcdef0123456789ab";

describe("better-auth session durability", () => {
	it("keeps a signed-in session row across a simulated process restart", async () => {
		const harness = createBetterAuthHostHarness();
		let database = openBetterAuthSessionStore(harness.sessionStorePath);
		try {
			const inputs = parseBetterAuthHostDotEnv(harness.dotEnv);
			const bundlePlan = planBetterAuthBundle(inputs.configInput, inputs.portsInput);
			const signedIn = recordSyntheticBetterAuthSignIn(database);
			database = simulateProcessRestart(harness.sessionStorePath, database);
			const afterRestart = loadSyntheticBetterAuthSession(
				database,
				signedIn.sessionToken,
			);
			expect(afterRestart).toEqual(signedIn);
			expect(bundlePlan.ports.relationalBindle).toBe("auth_db");
		} finally {
			database.close();
			harness.dispose();
		}
	});

	it("re-resolves the same brokered signing secret after restart so cookies stay valid", async () => {
		const harness = createBetterAuthHostHarness();
		let database = openBetterAuthSessionStore(harness.sessionStorePath);
		try {
			const inputs = parseBetterAuthHostDotEnv(harness.dotEnv);
			const bundlePlan = planBetterAuthBundle(inputs.configInput, inputs.portsInput);
			const port = createMemorySecretsPort({ id: "secrets:better-auth-durability" });
			const name = campSecretNameFromBetterAuthRef(bundlePlan.config.secretRef);
			await port.put(name, SYNTHETIC_SIGNING);
			const wireBefore = await wireBetterAuthSigningSecret(bundlePlan, port, {
				now: "2026-11-25T12:00:00.000Z",
			});
			recordSyntheticBetterAuthSignIn(database);
			database = simulateProcessRestart(harness.sessionStorePath, database);
			const wireAfter = await wireBetterAuthSigningSecret(bundlePlan, port, {
				now: "2026-11-25T12:05:00.000Z",
			});
			expect(wireAfter.secretRef).toBe(wireBefore.secretRef);
			expect(wireAfter.secretsPortId).toBe(wireBefore.secretsPortId);
			expect(loadSyntheticBetterAuthSession(database, "tok_fixture_restart")).not.toBeNull();
		} finally {
			database.close();
			harness.dispose();
		}
	});
});