import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	BudgetAdmissionDeniedError,
	BudgetEntitlementSchema,
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createBudgetAdmissionAuthority,
	EntitlementClaimSchema,
	HostingQuoteSchema,
	ProviderAccountExposureSchema,
} from "../src/index.js";

const NOW = "2026-10-30T12:00:00Z";
function snapshot() {
	return create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "tenant",
			budgetId: "shared",
			periodId: "p1",
			policyRevision: "v1",
		},
		limitMicros: 100,
		observedAt: "2026-10-30T00:00:00Z",
		validUntil: "2026-10-31T00:00:00Z",
	});
}
function quote() {
	return create(HostingQuoteSchema, {
		quoteId: "quote",
		yardId: "yard",
		providerId: "provider",
		ownerTenantId: "tenant",
		currency: "USD",
		totalMicros: 40,
		liabilityBoundMicros: 60,
		observedAt: "2026-10-30T00:00:00Z",
		validUntil: "2026-10-31T00:00:00Z",
		components: [{ name: "usage", costMicros: 40 }],
		requestDigest: "request",
	});
}
function reserve(
	authority: ReturnType<typeof createBudgetAdmissionAuthority>,
	q = quote(),
) {
	const current = authority.read(NOW);
	if (!current.identity) throw new Error("fixture identity missing");
	return authority.reserve({
		reservationId: "work",
		requestDigest: q.requestDigest,
		quote: q,
		identity: current.identity,
		expectedSeq: current.seq,
		now: NOW,
	});
}

describe("definitive budget admission denial", () => {
	it.each([
		"budget",
		"provider",
		"entitlement",
	] as const)("types %s exhaustion without committing any event or hold", (scope) => {
		const base = snapshot();
		const q = quote();
		if (scope === "budget") base.limitMicros = 0;
		if (scope === "provider") {
			base.providerAccounts = [
				create(BudgetProviderAccountSchema, {
					providerAccountId: "payer",
					limitMicros: 0,
				}),
			];
			q.providerAccounts = [
				create(ProviderAccountExposureSchema, {
					providerAccountId: "payer",
					liabilityMicros: 60,
				}),
			];
		}
		if (scope === "entitlement") {
			base.entitlements = [
				create(BudgetEntitlementSchema, {
					bucketId: "credit",
					unit: "runner-ms",
					periodId: "p1",
					remainingUnits: 0,
					observedAt: "2026-10-30T00:00:00Z",
					validUntil: "2026-10-31T00:00:00Z",
				}),
			];
			q.entitlementClaims = [
				create(EntitlementClaimSchema, {
					bucketId: "credit",
					unit: "runner-ms",
					units: 1,
				}),
			];
		}
		let events = 0;
		const authority = createBudgetAdmissionAuthority({
			snapshot: base,
			commit() {
				events++;
			},
		});
		expect(() => reserve(authority, q)).toThrow(BudgetAdmissionDeniedError);
		expect(() => reserve(authority, q)).toThrow(
			expect.objectContaining({ code: `${scope}.exhausted` }),
		);
		const messages = {
			budget: "budget exhausted",
			provider: "provider-account budget exhausted or unsupported",
			entitlement: "entitlement exhausted, stale or unsupported",
		};
		expect(() => reserve(authority, q)).toThrow(messages[scope]);
		expect(events).toBe(0);
		expect(authority.read(NOW)).toMatchObject({ seq: 0, reservedMicros: 0 });
		expect(authority.lookup("work")).toBeUndefined();
	});

	it("does not classify stale entitlement evidence as allowance exhaustion", () => {
		const base = snapshot();
		base.entitlements = [
			create(BudgetEntitlementSchema, {
				bucketId: "credit",
				unit: "runner-ms",
				periodId: "p1",
				remainingUnits: 10,
				observedAt: "2026-10-30T00:00:00Z",
				validUntil: NOW,
			}),
		];
		const q = quote();
		q.entitlementClaims = [
			create(EntitlementClaimSchema, {
				bucketId: "credit",
				unit: "runner-ms",
				units: 1,
			}),
		];
		const authority = createBudgetAdmissionAuthority({ snapshot: base });
		expect(() => reserve(authority, q)).toThrow("stale");
		try {
			reserve(authority, q);
			throw new Error("fixture should be refused");
		} catch (error) {
			expect(error).not.toBeInstanceOf(BudgetAdmissionDeniedError);
		}
	});

	it("preserves unsupported financial scope failures instead of treating them as queueable exhaustion", () => {
		const q = quote();
		q.providerAccounts = [
			create(ProviderAccountExposureSchema, {
				providerAccountId: "unknown",
				liabilityMicros: 60,
			}),
		];
		const authority = createBudgetAdmissionAuthority({ snapshot: snapshot() });
		expect(() => reserve(authority, q)).toThrow("unsupported");
		try {
			reserve(authority, q);
			throw new Error("fixture should be refused");
		} catch (error) {
			expect(error).not.toBeInstanceOf(BudgetAdmissionDeniedError);
		}
	});

	it("propagates the original durable commit failure without classifying it as a denial", () => {
		const failure = new Error("unknown durable write outcome");
		const authority = createBudgetAdmissionAuthority({
			snapshot: snapshot(),
			commit() {
				throw failure;
			},
		});
		expect(() => reserve(authority)).toThrow(failure);
		expect(failure).not.toBeInstanceOf(BudgetAdmissionDeniedError);
		expect(authority.lookup("work")).toBeUndefined();
	});
});
