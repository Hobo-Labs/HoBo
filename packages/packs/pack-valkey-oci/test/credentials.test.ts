/**
 * The interesting property is negative: nothing in this package ever holds the
 * password, so a custody that returns one is a broken custody rather than a
 * convenient shortcut.
 */
import type {
	PackSecretCustodyPort,
	PackSecretPolicy,
	PackSecretScope,
} from "@hobo/pack-framework";
import { isPackError } from "@hobo/pack-framework";
import { describe, expect, it } from "vitest";

import {
	provisionValkeyAuthCredential,
	VALKEY_PACK_ID,
	VALKEY_PASSWORD_POLICY,
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

describe("valkey credential provisioning", () => {
	it("mints inside custody and returns only a locator", async () => {
		const { custody, calls } = recordingCustody(
			"hobo-secret://tenant-demo/valkey-main/requirepass",
		);
		const ref = await provisionValkeyAuthCredential(
			custody,
			"resource:yard-1/cache-main",
		);

		expect(ref.ref).toBe("hobo-secret://tenant-demo/valkey-main/requirepass");
		expect(calls[0]?.scope).toMatchObject({
			packId: VALKEY_PACK_ID,
			resourceRef: "resource:yard-1/cache-main",
			purpose: "cache-auth-password",
		});
	});

	it("asks for enough entropy to survive an unthrottled guessing loop", () => {
		// Valkey answers AUTH as fast as the network allows: no login delay, no
		// lockout, no audit trail by default.
		expect(VALKEY_PASSWORD_POLICY.minimumLength).toBeGreaterThanOrEqual(32);
		expect(VALKEY_PASSWORD_POLICY.alphabet).toBe("base64url");
	});

	it("rejects a custody that returns the password instead of a locator", async () => {
		const { custody } = recordingCustody("hunter2-correct-horse-battery-stap");
		await expect(
			provisionValkeyAuthCredential(custody, "resource:yard-1/cache-main"),
		).rejects.toSatisfy(
			(error: JsonValue) =>
				isPackError(error) && error.code === "SECRET_CUSTODY_UNAVAILABLE",
		);
	});

	it("rejects a redis URL masquerading as a locator", async () => {
		const { custody } = recordingCustody(
			"redis://default:hunter2@cache-main:6379/0",
		);
		await expect(
			provisionValkeyAuthCredential(custody, "resource:yard-1/cache-main"),
		).rejects.toSatisfy(
			(error: JsonValue) =>
				isPackError(error) && error.code === "SECRET_CUSTODY_UNAVAILABLE",
		);
	});

	it("surfaces an unavailable custody as a typed pack error", async () => {
		const custody: PackSecretCustodyPort = {
			generate: () => Promise.reject(new Error("vault sealed")),
			deposit: () => Promise.reject(new Error("vault sealed")),
		};
		await expect(
			provisionValkeyAuthCredential(custody, "resource:yard-1/cache-main"),
		).rejects.toSatisfy(
			(error: JsonValue) =>
				isPackError(error) && error.code === "SECRET_CUSTODY_UNAVAILABLE",
		);
	});
});
