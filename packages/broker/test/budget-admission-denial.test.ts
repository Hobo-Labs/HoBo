import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { clone, create, toJsonString } from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	BudgetAdmissionDeniedError,
	type BudgetAuthorityEvent,
	BudgetAuthorityEventSchema,
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
					kind: "allowance",
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
					kind: "allowance",
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
				kind: "allowance",
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
				kind: "allowance",
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

	it.each([
		"",
		"grant",
		"ALLOWANCE",
	])("rejects unsupported entitlement kind %j before admission", (kind) => {
		const q = quote();
		q.entitlementClaims = [
			create(EntitlementClaimSchema, {
				bucketId: "credit",
				kind,
				unit: "runner-ms",
				units: 1,
			}),
		];
		const authority = createBudgetAdmissionAuthority({ snapshot: snapshot() });
		expect(() => reserve(authority, q)).toThrow("unsupported entitlement kind");
		expect(authority.lookup("work")).toBeUndefined();
		expect(authority.read(NOW).seq).toBe(0);
	});

	it("replays a persisted kindless quote before strict kind validation", () => {
		const base = snapshot();
		base.entitlements = [
			create(BudgetEntitlementSchema, {
				bucketId: "credit",
				kind: "allowance",
				unit: "runner-ms",
				periodId: "p1",
				remainingUnits: 10,
				observedAt: "2026-10-30T00:00:00Z",
				validUntil: "2026-10-31T00:00:00Z",
			}),
		];
		const q = quote();
		q.entitlementClaims = [
			create(EntitlementClaimSchema, {
				bucketId: "credit",
				kind: "allowance",
				unit: "runner-ms",
				units: 1,
			}),
		];
		const events: BudgetAuthorityEvent[] = [];
		const initial = createBudgetAdmissionAuthority({
			snapshot: base,
			commit: (event) => events.push(event),
		});
		reserve(initial, q);
		const event = events[0];
		if (!event) throw new Error("reservation event missing");
		const legacyEvent = clone(BudgetAuthorityEventSchema, event);
		for (const entitlement of legacyEvent.snapshot?.entitlements ?? [])
			entitlement.kind = "";
		const reservation = legacyEvent.reservations[0];
		if (!reservation) throw new Error("reservation missing");
		for (const claim of reservation.entitlementClaims) claim.kind = "";
		for (const claim of q.entitlementClaims) claim.kind = "";
		reservation.quoteDigest = createHash("sha256")
			.update(toJsonString(HostingQuoteSchema, q))
			.digest("hex");
		const authority = createBudgetAdmissionAuthority({
			snapshot: base,
			priorEvents: [legacyEvent],
		});
		expect(reserve(authority, q)).toMatchObject({
			reservationId: "work",
			status: "held",
		});
		for (const claim of q.entitlementClaims) claim.kind = "allowance";
		expect(reserve(authority, q)).toMatchObject({
			reservationId: "work",
			status: "held",
		});
		expect(authority.read(NOW).seq).toBe(1);
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

	it("rejects reuse after a durable commit failure while retaining its cause", () => {
		const failure = new Error("unknown durable write outcome");
		const authority = createBudgetAdmissionAuthority({
			snapshot: snapshot(),
			commit() {
				throw failure;
			},
		});
		let observed: unknown;
		try {
			reserve(authority);
		} catch (error) {
			observed = error;
		}
		expect(observed).toBeInstanceOf(Error);
		expect(observed).not.toBeInstanceOf(BudgetAdmissionDeniedError);
		if (!(observed instanceof Error)) throw new Error("missing failure");
		expect(observed.cause).toBe(failure);
		expect(() => authority.lookup("work")).toThrow(
			"budget commit outcome uncertain",
		);
		expect(() => authority.read(NOW)).toThrow(
			"budget commit outcome uncertain",
		);
	});

	it("does not classify a commit exception as a denial", () => {
		const seen = new Set<string>();
		const foreign: unknown = runInNewContext(
			'new (class BudgetAdmissionDeniedError extends Error { constructor() { super("foreign denial"); } })()',
		);
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.constantFrom("denial", "proxy", "foreign", "ordinary"),
				(appendBeforeThrow, variant) => {
					const base = snapshot();
					const journal: BudgetAuthorityEvent[] = [];
					const failure = new BudgetAdmissionDeniedError(
						"budget.exhausted",
						"storage reported an ambiguous failure",
					);
					let trapCalls = 0;
					const thrown: unknown =
						variant === "proxy"
							? new Proxy(failure, {
									getPrototypeOf() {
										trapCalls += 1;
										throw failure;
									},
								})
							: variant === "foreign"
								? foreign
								: variant === "ordinary"
									? new Error("storage failed")
									: failure;
					const authority = createBudgetAdmissionAuthority({
						snapshot: base,
						commit(event) {
							if (appendBeforeThrow) journal.push(event);
							throw thrown;
						},
					});
					let observed: unknown;
					try {
						reserve(authority);
					} catch (error) {
						observed = error;
					}
					expect(observed).toBeInstanceOf(Error);
					expect(observed).not.toBeInstanceOf(BudgetAdmissionDeniedError);
					if (!(observed instanceof Error)) throw new Error("missing failure");
					expect(observed.cause).toBe(thrown);
					expect(trapCalls).toBe(0);
					expect(() => authority.read(NOW)).toThrow(
						"budget commit outcome uncertain",
					);
					const reopened = createBudgetAdmissionAuthority({
						snapshot: base,
						priorEvents: journal,
					});
					expect(reopened.lookup("work")?.status).toBe(
						appendBeforeThrow ? "held" : undefined,
					);
					seen.add(`${appendBeforeThrow}:${variant}`);
				},
			),
			{ seed: 614454, numRuns: 50 },
		);
		expect(seen.size).toBe(8);
	});
});
