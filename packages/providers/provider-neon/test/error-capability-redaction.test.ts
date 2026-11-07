import { describe, expect, it } from "vitest";
import { NeonProviderError } from "../src/errors.js";

describe("Neon public error serialization", () => {
	it("redacts bearer UUIDs and encoded claim URLs from messages and arbitrary detail strings", () => {
		const nativeId = "01999999-0000-7000-8000-000000000001";
		const claim = `https://neon.new/claim/${nativeId}`;
		const privateKey = "private-native-idempotency-key";
		const error = new NeonProviderError(
			"PROVISIONING_CONFLICT",
			`provider echoed ${encodeURIComponent(encodeURIComponent(claim))}`,
			{
				detail: {
					databaseId: nativeId,
					idempotencyKey: privateKey,
					body: nativeId.toUpperCase().replaceAll("-", ""),
					claimUrl: claim,
					status: 404,
				},
			},
		);
		const serialized = JSON.stringify(error);
		for (const hidden of [
			nativeId,
			claim,
			privateKey,
			"01999999000070008000000000000001",
		])
			expect(serialized.toLowerCase()).not.toContain(hidden.toLowerCase());
		expect(error.detail.status).toBe(404);
	});
});
