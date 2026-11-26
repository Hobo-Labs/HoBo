/**
 * Provisioning tests. The interesting property is negative: nothing in this
 * package ever sees a password, so a custody implementation that hands one back
 * is treated as a broken custody rather than a convenient shortcut.
 */

import type {
	PackSecretCustodyPort,
	PackSecretPolicy,
	PackSecretScope,
} from "@hobo/pack-framework";
import { isPackError } from "@hobo/pack-framework";
import { describe, expect, it } from "vitest";

import {
	POSTGRES_PACK_ID,
	POSTGRES_PASSWORD_POLICY,
	provisionPostgresApplicationCredential,
	provisionPostgresSuperuserCredential,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

type Recorded = {
	readonly scope: PackSecretScope;
	readonly policy: PackSecretPolicy;
};

interface RecordingCustody {
	readonly custody: PackSecretCustodyPort;
	readonly calls: Recorded[];
}

function recordingCustody(locator: string): RecordingCustody {
	const calls: Recorded[] = [];
	return {
		calls,
		custody: {
			generate(scope, policy) {
				calls.push({ scope, policy });
				return Promise.resolve(locator);
			},
			deposit() {
				return Promise.reject(
					new Error("a pack credential is minted, never deposited"),
				);
			},
		},
	};
}

describe("postgres credential provisioning", () => {
	it("mints the owner password inside custody and returns only a locator", async () => {
		const { custody, calls } = recordingCustody(
			"hobo-secret://tenant-demo/pg-main/superuser",
		);
		const ref = await provisionPostgresSuperuserCredential(
			custody,
			"resource:yard-1/pg-main",
		);

		expect(ref.ref).toBe("hobo-secret://tenant-demo/pg-main/superuser");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.scope).toMatchObject({
			packId: POSTGRES_PACK_ID,
			resourceRef: "resource:yard-1/pg-main",
			purpose: "database-owner-password",
		});
		// Custody gets the strength requirement, not a generated value.
		expect(calls[0]?.policy).toBe(POSTGRES_PASSWORD_POLICY);
	});

	it("asks for materially more entropy than the framework floor", () => {
		// 32 base64url characters is ~190 bits. This is a long-lived credential on
		// a port that can be reachable across a Camp, so the 16-character
		// framework minimum is not the right floor for it.
		expect(POSTGRES_PASSWORD_POLICY.minimumLength).toBeGreaterThanOrEqual(32);
		expect(POSTGRES_PASSWORD_POLICY.alphabet).toBe("base64url");
	});

	it("distinguishes the application credential from the owner credential", async () => {
		const { custody, calls } = recordingCustody(
			"hobo-secret://tenant-demo/pg-main/app",
		);
		await provisionPostgresApplicationCredential(
			custody,
			"resource:yard-1/pg-main",
		);
		expect(calls[0]?.scope.purpose).toBe("database-app-password");
	});

	it("rejects a custody that returns the password instead of a locator", async () => {
		const { custody } = recordingCustody(
			"hunter2-correct-horse-battery-staple",
		);
		await expect(
			provisionPostgresSuperuserCredential(custody, "resource:yard-1/pg-main"),
		).rejects.toSatisfy(
			(error: JsonValue) =>
				isPackError(error) && error.code === "SECRET_CUSTODY_UNAVAILABLE",
		);
	});

	it("rejects a connection string masquerading as a locator", async () => {
		const { custody } = recordingCustody(
			"postgresql://postgres:hunter2@pg-main.yard-1.hobo.test:5432/app",
		);
		await expect(
			provisionPostgresSuperuserCredential(custody, "resource:yard-1/pg-main"),
		).rejects.toSatisfy(
			(error: JsonValue) =>
				isPackError(error) && error.code === "SECRET_CUSTODY_UNAVAILABLE",
		);
	});

	it("surfaces an unavailable custody as a typed pack error, not a raw failure", async () => {
		const custody: PackSecretCustodyPort = {
			generate: () => Promise.reject(new Error("vault sealed")),
			deposit: () => Promise.reject(new Error("vault sealed")),
		};
		await expect(
			provisionPostgresSuperuserCredential(custody, "resource:yard-1/pg-main"),
		).rejects.toSatisfy(
			(error: JsonValue) =>
				isPackError(error) && error.code === "SECRET_CUSTODY_UNAVAILABLE",
		);
	});
});
