import { createHmac } from "node:crypto";
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
	it("refuses malformed stored session fields", () => {
		const harness = createBetterAuthHostHarness();
		const database = openBetterAuthSessionStore(harness.sessionStorePath);
		try {
			database
				.prepare(
					"INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					"bad-session",
					"2026-12-25",
					"bad-token",
					"2026-11-25",
					"2026-11-25",
					new Uint8Array([1]),
				);
			expect(loadSyntheticBetterAuthSession(database, "bad-token")).toBeNull();
		} finally {
			database.close();
			harness.dispose();
		}
	});

	it("keeps a signed-in session row across a simulated process restart", async () => {
		const harness = createBetterAuthHostHarness();
		let database = openBetterAuthSessionStore(harness.sessionStorePath);
		try {
			const inputs = parseBetterAuthHostDotEnv(harness.dotEnv);
			const bundlePlan = planBetterAuthBundle(
				inputs.configInput,
				inputs.portsInput,
			);
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
			const bundlePlan = planBetterAuthBundle(
				inputs.configInput,
				inputs.portsInput,
			);
			const port = createMemorySecretsPort({
				id: "secrets:better-auth-durability",
			});
			const name = campSecretNameFromBetterAuthRef(
				bundlePlan.config.secretRef,
				inputs.campAuthority,
			);
			await port.put(name, SYNTHETIC_SIGNING);
			const wireBefore = await wireBetterAuthSigningSecret(bundlePlan, port, {
				campAuthority: inputs.campAuthority,
				now: "2026-11-25T12:00:00.000Z",
			});
			const before = await port.access(name);
			if (before.status !== "ok" || !before.material)
				throw new Error("fixture signing secret unavailable");
			const session = recordSyntheticBetterAuthSignIn(database);
			const signature = createHmac("sha256", before.material)
				.update(session.sessionToken)
				.digest("hex");
			database = simulateProcessRestart(harness.sessionStorePath, database);
			const wireAfter = await wireBetterAuthSigningSecret(bundlePlan, port, {
				campAuthority: inputs.campAuthority,
				now: "2026-11-25T12:05:00.000Z",
			});
			const after = await port.access(name);
			if (after.status !== "ok" || !after.material)
				throw new Error("fixture signing secret unavailable after restart");
			expect(wireAfter.secretRef).toBe(wireBefore.secretRef);
			expect(wireAfter.secretsPortId).toBe(wireBefore.secretsPortId);
			expect(
				createHmac("sha256", after.material)
					.update(session.sessionToken)
					.digest("hex"),
			).toBe(signature);
			expect(
				loadSyntheticBetterAuthSession(database, "tok_fixture_restart"),
			).not.toBeNull();
		} finally {
			database.close();
			harness.dispose();
		}
	});
});
