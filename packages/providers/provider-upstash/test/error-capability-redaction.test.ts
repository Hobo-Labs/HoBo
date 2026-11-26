import { describe, expect, it } from "vitest";
import { UpstashProviderError } from "../src/errors.js";

describe("Upstash public error serialization", () => {
	it("redacts bearer UUIDs and encoded claim URLs from messages and typed details", () => {
		const nativeId = "01999999-0000-4000-8000-000000000001";
		const claim = `https://console.upstash.com/redis/${nativeId}`;
		const error = new UpstashProviderError(
			"PROVIDER_OPERATION_AMBIGUOUS",
			`provider echoed ${encodeURIComponent(encodeURIComponent(claim))}`,
			{
				detail: {
					databaseId: nativeId,
					idempotencyKey: nativeId,
					body: nativeId.toUpperCase().replaceAll("-", ""),
					claimUrl: claim,
					status: 503,
				},
			},
		);
		const serialized = JSON.stringify(error).toLowerCase();
		for (const hidden of [nativeId, claim, nativeId.replaceAll("-", "")])
			expect(serialized).not.toContain(hidden);
		expect(error.detail.status).toBe(503);
	});
});
