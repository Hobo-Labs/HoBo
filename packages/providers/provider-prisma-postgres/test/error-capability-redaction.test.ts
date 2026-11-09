import { describe, expect, it } from "vitest";
import { PrismaProviderError } from "../src/errors.js";

describe("Prisma public error serialization", () => {
	it("redacts native project ids, private operation keys and encoded claim URLs", () => {
		const nativeId = "proj_fake000000000000";
		const claim = `https://create-db.prisma.io/claim?projectID=${nativeId}`;
		const privateKey = "private-native-idempotency-key";
		const error = new PrismaProviderError(
			"PROVISIONING_CONFLICT",
			`provider echoed ${encodeURIComponent(encodeURIComponent(claim))}`,
			{
				detail: {
					projectId: nativeId,
					idempotencyKey: privateKey,
					body: nativeId,
					claimUrl: claim,
					status: 409,
				},
			},
		);
		const serialized = JSON.stringify(error);
		for (const hidden of [nativeId, claim, privateKey])
			expect(serialized).not.toContain(hidden);
		expect(error.detail.status).toBe(409);
	});
});
