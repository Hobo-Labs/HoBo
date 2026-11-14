import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createSqliteBudgetAdmissionAuthority,
	HostingQuoteSchema,
	ProviderAccountExposureSchema,
} from "@hobo/broker";
import { describe, expect, it } from "vitest";
import { createUpstashBlobCredentials } from "../src/blob-credentials.js";

const now = 1_800_000_000_000;
const instant = new Date(now).toISOString();
const account = "a".repeat(32);
const bucket = "12345678-1234-1234-1234-123456789abc";

function fixture(
	limitMicros: number,
	failAfterSend = false,
	changeAfterHold = false,
) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-upstash-budget-"));
	const identity = {
		tenantId: "tenant",
		budgetId: "hosting",
		periodId: "p1",
		policyRevision: "v1",
	};
	const snapshot = create(BudgetLedgerSnapshotSchema, {
		identity,
		limitMicros,
		observedAt: new Date(now - 1_000).toISOString(),
		validUntil: new Date(now + 600_000).toISOString(),
		providerAccounts: [
			create(BudgetProviderAccountSchema, {
				providerAccountId: "upstash:account",
				limitMicros,
			}),
		],
	});
	const broker = createSqliteBudgetAdmissionAuthority({
		path: join(dir, "budget.sqlite"),
		snapshot,
		now: () => instant,
	});
	let token = "credential_token_1",
		attempts = 0,
		sent = 0;
	const cache = createUpstashBlobCredentials({
		upstashAccountId: "account",
		bucketId: bucket,
		r2AccountId: account,
		resolveToken: async () => token,
		now: () => now,
		reserveMint: async () => {
			const id = `mint-${++attempts}`;
			const current = broker.read(instant);
			const quote = create(HostingQuoteSchema, {
				quoteId: id,
				yardId: "upstash-yard",
				providerId: "upstash",
				ownerTenantId: "tenant",
				currency: "USD",
				totalMicros: 1,
				liabilityBoundMicros: 1,
				requestDigest: id,
				observedAt: new Date(now - 1_000).toISOString(),
				validUntil: new Date(now + 600_000).toISOString(),
				components: [{ name: "mint", costMicros: 1 }],
				providerAccounts: [
					create(ProviderAccountExposureSchema, {
						providerAccountId: "upstash:account",
						liabilityMicros: 1,
					}),
				],
			});
			broker.reserve({
				reservationId: id,
				requestDigest: id,
				quote,
				identity,
				expectedSeq: current.seq,
				now: instant,
			});
			const heldSeq = broker.read(instant).seq;
			if (changeAfterHold) {
				broker.reserve({
					reservationId: "concurrent-work",
					requestDigest: id,
					quote,
					identity,
					expectedSeq: heldSeq,
					now: instant,
				});
			}
			return async () => {
				broker.claimExecution({
					reservationId: id,
					requestDigest: id,
					executionDigest: id,
					expectedSeq: heldSeq,
				});
			};
		},
		transport: async () => {
			sent++;
			if (failAfterSend) throw new Error("provider response lost");
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					endpoint: `https://${account}.r2.cloudflarestorage.com`,
					bucket,
					region: "auto",
					visibility: "private",
					accessKeyId: "access",
					secretAccessKey: "secret",
					sessionToken: "session",
					expiresAt: (now + 600_000) / 1000,
				}),
			};
		},
	});
	return {
		broker,
		cache,
		sent: () => sent,
		rotate() {
			token = "credential_token_2";
		},
		close() {
			broker.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("Upstash Blob mint funding", () => {
	it("reserves and claims the real durable Broker before the provider call", async () => {
		const f = fixture(1);
		try {
			await f.cache.resolveCredentials();
			expect(f.sent()).toBe(1);
			expect(f.broker.lookup("mint-1")).toMatchObject({
				status: "held",
				executionDigest: "mint-1",
			});
			f.rotate();
			await expect(f.cache.resolveCredentials()).rejects.toThrow(
				"budget-unavailable",
			);
			expect(f.sent()).toBe(1);
			expect(f.broker.lookup("mint-2")).toBeUndefined();
		} finally {
			f.close();
		}
	});

	it("does not send after the real Broker sequence changes before claim", async () => {
		const f = fixture(2, false, true);
		try {
			await expect(f.cache.resolveCredentials()).rejects.toThrow(
				"budget-unavailable",
			);
			expect(f.sent()).toBe(0);
			expect(f.broker.lookup("mint-1")).toMatchObject({
				status: "held",
				executionDigest: "",
			});
		} finally {
			f.close();
		}
	});

	it("retains the actual hold after an ambiguous provider failure", async () => {
		const f = fixture(1, true);
		try {
			await expect(f.cache.resolveCredentials()).rejects.toThrow("unavailable");
			expect(f.broker.lookup("mint-1")).toMatchObject({
				status: "held",
				executionDigest: "mint-1",
			});
			await expect(f.cache.resolveCredentials()).rejects.toThrow(
				"budget-unavailable",
			);
			expect(f.sent()).toBe(1);
		} finally {
			f.close();
		}
	});
});
