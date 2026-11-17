import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { IacUnpricedPolicyProofSchema } from "../src/_generated/yard_placement_pb.js";
import {
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createSqliteBudgetAdmissionAuthority,
	HostingQuoteSchema,
} from "../src/index.js";

const now = "2026-01-02T00:00:00Z";
const end = "2026-01-31T00:00:00Z";
const identity = {
	tenantId: "tenant-a",
	budgetId: "hosting",
	periodId: "2026-01",
	policyRevision: "r1",
};
const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-unpriced-budget-"));
	directories.push(dir);
	const options = {
		path: join(dir, "budget.sqlite"),
		now: () => now,
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity,
			limitMicros: 3_000_000,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: end,
			providerAccounts: [
				{ providerAccountId: "account-a", limitMicros: 3_000_000 },
			],
		}),
	};
	const unpriced = {
		reservationId: "iac:unpriced",
		requestDigest: `sha256:${"a".repeat(64)}`,
		inventoryHash: `sha256:${"b".repeat(64)}`,
		policyProof: create(IacUnpricedPolicyProofSchema, {
			requestDigest: `sha256:${"a".repeat(64)}`,
			inventoryHash: `sha256:${"b".repeat(64)}`,
			identity,
			policyHash: "policy:1",
			effect: "allow",
			evidenceRef: "approval:1",
			obligationsSatisfied: true,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: end,
		}),
		identity: options.snapshot.identity,
		providerAccountIds: ["account-a"],
		expectedSeq: 0,
		now,
	};
	const quote = create(HostingQuoteSchema, {
		quoteId: "priced",
		yardId: "yard-a",
		providerId: "provider-a",
		ownerTenantId: "tenant-a",
		currency: "USD",
		totalMicros: 1_000_000,
		liabilityBoundMicros: 1_000_000,
		observedAt: "2026-01-01T00:00:00Z",
		validUntil: end,
		requestDigest: "priced-request",
		components: [{ name: "compute", costMicros: 1_000_000 }],
		providerAccounts: [
			{ providerAccountId: "account-a", liabilityMicros: 1_000_000 },
		],
	});
	return { options, unpriced, quote };
}

describe("durable unbounded liability admission", () => {
	it("records unknown liability explicitly and blocks bounded admission until settlement", () => {
		const { options, unpriced, quote } = fixture();
		const ledger = createSqliteBudgetAdmissionAuthority(options);
		const receipt = ledger.reserveUnbounded(unpriced);
		expect(receipt).toMatchObject({ status: "held", unboundedExposure: true });
		expect(ledger.read(now)).toMatchObject({ unboundedExposureCount: 1 });
		expect(() =>
			ledger.reserve({
				reservationId: "priced",
				requestDigest: quote.requestDigest,
				quote,
				identity,
				expectedSeq: 1,
				now,
			}),
		).toThrow("unbounded");
		const claim = ledger.claimExecution({
			reservationId: unpriced.reservationId,
			requestDigest: unpriced.requestDigest,
			executionDigest: "exec:1",
			expectedSeq: 1,
		});
		expect(claim.unboundedExposure).toBe(true);
		expect(() =>
			ledger.release(unpriced.reservationId, true, "not-used"),
		).toThrow();
		ledger.settle(unpriced.reservationId, 1_200_000, {
			usageEvidenceRef: "usage:1",
			sourceStoppedEvidenceRef: "stop:1",
			providerAccounts: [
				{ providerAccountId: "account-a", liabilityMicros: 1_200_000 },
			],
		});
		expect(ledger.read(now)).toMatchObject({
			spentMicros: 1_200_000,
			unboundedExposureCount: 0,
		});
		ledger.close();
		const reopened = createSqliteBudgetAdmissionAuthority(options);
		expect(reopened.lookup(unpriced.reservationId)).toMatchObject({
			status: "settled",
			unboundedExposure: true,
			actualMicros: 1_200_000,
		});
		expect(reopened.read(now).unboundedExposureCount).toBe(0);
		reopened.close();
	});

	it("does not allow unbounded exposure to invalidate existing bounded holds", () => {
		const { options, unpriced, quote } = fixture();
		const ledger = createSqliteBudgetAdmissionAuthority(options);
		ledger.reserve({
			reservationId: "priced",
			requestDigest: quote.requestDigest,
			quote,
			identity,
			expectedSeq: 0,
			now,
		});
		expect(() =>
			ledger.reserveUnbounded({ ...unpriced, expectedSeq: 1 }),
		).toThrow("bounded");
		expect(ledger.read(now)).toMatchObject({
			reservedMicros: 1_000_000,
			unboundedExposureCount: 0,
		});
		ledger.close();
	});

	it("preserves unknown exposure across independent connections, retries, and failed CAS", () => {
		const { options, unpriced, quote } = fixture();
		const one = createSqliteBudgetAdmissionAuthority(options);
		const two = createSqliteBudgetAdmissionAuthority(options);
		one.reserveUnbounded(unpriced);
		expect(two.read(now).unboundedExposureCount).toBe(1);
		expect(two.reserveUnbounded(unpriced).unboundedExposure).toBe(true);
		expect(() =>
			two.reserveUnbounded({ ...unpriced, requestDigest: "different" }),
		).toThrow();
		expect(() =>
			two.reserve({
				reservationId: "priced",
				requestDigest: quote.requestDigest,
				quote,
				identity,
				expectedSeq: 0,
				now,
			}),
		).toThrow();
		one.close();
		two.close();
		const reopened = createSqliteBudgetAdmissionAuthority(options);
		expect(reopened.read(now).unboundedExposureCount).toBe(1);
		reopened.release(unpriced.reservationId, true, "verified-unused");
		expect(reopened.read(now).unboundedExposureCount).toBe(0);
		reopened.close();
	});

	it("keeps budget routing closed until all unpriced operations are reconciled", () => {
		const { options, unpriced, quote } = fixture();
		const ledger = createSqliteBudgetAdmissionAuthority(options);
		ledger.reserveUnbounded(unpriced);
		const second = {
			...unpriced,
			reservationId: "iac:destroy",
			requestDigest: `sha256:${"d".repeat(64)}`,
			expectedSeq: 1,
			policyProof: create(IacUnpricedPolicyProofSchema, {
				...unpriced.policyProof,
				requestDigest: `sha256:${"d".repeat(64)}`,
			}),
		};
		ledger.reserveUnbounded(second);
		expect(ledger.read(now).unboundedExposureCount).toBe(2);
		ledger.release(unpriced.reservationId, true, "unused:1");
		expect(ledger.read(now).unboundedExposureCount).toBe(1);
		expect(() =>
			ledger.reserve({
				reservationId: "priced",
				requestDigest: quote.requestDigest,
				quote,
				identity,
				expectedSeq: 3,
				now,
			}),
		).toThrow("unbounded");
		ledger.release(second.reservationId, true, "unused:2");
		expect(ledger.read(now).unboundedExposureCount).toBe(0);
		ledger.close();
	});

	it("refuses to change financial scopes while unknown liability is active", () => {
		const { options, unpriced } = fixture();
		const ledger = createSqliteBudgetAdmissionAuthority(options);
		ledger.reserveUnbounded(unpriced);
		const changed = ledger.read(now);
		changed.providerAccounts.push(
			create(BudgetProviderAccountSchema, {
				providerAccountId: "account-b",
				limitMicros: 1_000_000,
			}),
		);
		expect(() => ledger.configure(changed, 1, now)).toThrow("financial scopes");
		ledger.close();
	});

	it.each([
		"deny",
		"approval",
		"obligations",
		"expired",
		"wrong-scope",
	])("does not hold liability for invalid unpriced policy: %s", (kind) => {
		const { options, unpriced } = fixture();
		const ledger = createSqliteBudgetAdmissionAuthority(options);
		const proof = create(IacUnpricedPolicyProofSchema, unpriced.policyProof);
		if (kind === "deny") proof.effect = "deny";
		if (kind === "approval") proof.effect = "require-approval";
		if (kind === "obligations") proof.obligationsSatisfied = false;
		if (kind === "expired") proof.validUntil = now;
		if (kind === "wrong-scope")
			proof.inventoryHash = `sha256:${"f".repeat(64)}`;
		expect(() =>
			ledger.reserveUnbounded({ ...unpriced, policyProof: proof }),
		).toThrow();
		expect(ledger.read(now).unboundedExposureCount).toBe(0);
		ledger.close();
	});

	it("does not claim execution after the unpriced authorization expires", () => {
		const { options, unpriced } = fixture();
		let clock = now;
		const ledger = createSqliteBudgetAdmissionAuthority({
			...options,
			now: () => clock,
		});
		unpriced.policyProof.validUntil = "2026-01-10T00:00:00Z";
		ledger.reserveUnbounded(unpriced);
		clock = unpriced.policyProof.validUntil;
		expect(() =>
			ledger.claimExecution({
				reservationId: unpriced.reservationId,
				requestDigest: unpriced.requestDigest,
				executionDigest: "exec:late",
				expectedSeq: 1,
			}),
		).toThrow("unpriced policy authorization is stale");
		clock = now;
		expect(ledger.read(now).unboundedExposureCount).toBe(1);
		ledger.close();
	});
});
