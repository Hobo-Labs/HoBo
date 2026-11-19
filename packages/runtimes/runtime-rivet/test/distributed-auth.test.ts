import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	computeRivetOperationDigest,
	createRivetCapabilityVerifier,
	issueRivetCapability,
} from "../src/distributed-auth.js";

const key = ["hobo", "tenant-a", "camp-a", "orders"] as const;
const args = {
	eventId: "event-1",
	expectedRevision: 0,
	event: { type: "OrderCreated", amount: 42 },
};
const keys = generateKeyPairSync("ed25519");

function fixture() {
	const capability = issueRivetCapability(
		{
			issuer: "station-a",
			audience: "rivet-journal",
			subject: "service:shop",
			capabilityId: "cap-1",
			issuedAtMs: 1_000,
			expiresAtMs: 6_000,
			actorKey: key,
			action: "append",
			args,
		},
		keys.privateKey,
	);
	const verified = createRivetCapabilityVerifier({
		issuer: "station-a",
		audience: "rivet-journal",
		publicKey: keys.publicKey,
		nowMs: () => 2_000,
		authorize: async () => true,
	});
	return { capability, verified };
}

describe("Rivet actor signed operation capabilities", () => {
	it("authenticates the exact operation and server-observed tenant/camp actor key", async () => {
		const { capability, verified } = fixture();
		await expect(
			verified({ actorKey: key, action: "append", args, capability }),
		).resolves.toMatchObject({
			issuer: "station-a",
			subject: "service:shop",
			scopeDigest: computeRivetOperationDigest({
				actorKey: key,
				action: "append",
				args,
			}),
		});
	});

	it.each([
		{
			actorKey: ["hobo", "tenant-b", "camp-a", "orders"],
			action: "append",
			args,
		},
		{
			actorKey: ["hobo", "tenant-a", "camp-b", "orders"],
			action: "append",
			args,
		},
		{
			actorKey: ["hobo", "tenant-a", "camp-a", "other"],
			action: "append",
			args,
		},
		{ actorKey: key, action: "read", args },
		{ actorKey: key, action: "append", args: { ...args, expectedRevision: 1 } },
		{
			actorKey: key,
			action: "append",
			args: { ...args, event: { type: "OrderCreated", amount: 43 } },
		},
	] as const)("rejects changed scope or action data", async (actual) => {
		const { capability, verified } = fixture();
		await expect(verified({ ...actual, capability })).rejects.toMatchObject({
			code: "SCOPE_MISMATCH",
		});
	});

	it("binds read pagination as part of the operation", async () => {
		const capability = issueRivetCapability(
			{
				issuer: "station-a",
				audience: "rivet-journal",
				subject: "service:shop",
				capabilityId: "read-1",
				issuedAtMs: 1_000,
				expiresAtMs: 6_000,
				actorKey: key,
				action: "read",
				args: { afterRevision: 4, limit: 10 },
			},
			keys.privateKey,
		);
		const { verified } = fixture();
		await expect(
			verified({
				actorKey: key,
				action: "read",
				args: { afterRevision: 4, limit: 11 },
				capability,
			}),
		).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });
	});

	it("rechecks expiry after an asynchronous policy decision", async () => {
		const { capability } = fixture();
		let now = 2_000;
		const verifier = createRivetCapabilityVerifier({
			issuer: "station-a",
			audience: "rivet-journal",
			publicKey: keys.publicKey,
			nowMs: () => now,
			authorize: async () => {
				now = 6_000;
				return true;
			},
		});
		await expect(
			verifier({ actorKey: key, action: "append", args, capability }),
		).rejects.toMatchObject({ code: "CAPABILITY_EXPIRED" });
	});

	it("rejects changed claims, unknown keys, stale proofs, and denied authorization", async () => {
		const { capability } = fixture();
		const verify = (
			overrides: Partial<Parameters<typeof createRivetCapabilityVerifier>[0]>,
		) =>
			createRivetCapabilityVerifier({
				issuer: "station-a",
				audience: "rivet-journal",
				publicKey: keys.publicKey,
				nowMs: () => 2_000,
				authorize: async () => true,
				...overrides,
			});
		const input = {
			actorKey: key,
			action: "append" as const,
			args,
			capability,
		};
		await expect(
			verify({})({
				...input,
				capability: { ...capability, subject: "service:other" },
			}),
		).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
		await expect(
			verify({ publicKey: generateKeyPairSync("ed25519").publicKey })(input),
		).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
		await expect(verify({ issuer: "station-b" })(input)).rejects.toMatchObject({
			code: "AUTHORITY_MISMATCH",
		});
		await expect(
			verify({ audience: "different" })(input),
		).rejects.toMatchObject({ code: "AUTHORITY_MISMATCH" });
		await expect(verify({ nowMs: () => 6_000 })(input)).rejects.toMatchObject({
			code: "CAPABILITY_EXPIRED",
		});
		await expect(verify({ nowMs: () => 999 })(input)).rejects.toMatchObject({
			code: "CAPABILITY_NOT_YET_VALID",
		});
		await expect(
			verify({ authorize: async () => false })(input),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		await expect(
			verify({
				authorize: async () => {
					throw new Error("unavailable");
				},
			})(input),
		).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
	});

	it("fails closed on ambiguous, oversized or non-data operation inputs", () => {
		const cyclic = { self: undefined };
		Object.assign(cyclic, { self: cyclic });
		for (const candidate of [
			cyclic,
			{ value: Number.NaN },
			{ value: "x".repeat(65_537) },
			{
				get value() {
					throw new Error("getter");
				},
			},
		]) {
			expect(() =>
				computeRivetOperationDigest({
					actorKey: key,
					action: "append",
					args: candidate,
				}),
			).toThrow();
		}
	});
});
