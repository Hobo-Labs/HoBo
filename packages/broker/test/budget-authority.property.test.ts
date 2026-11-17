import { create } from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	type BudgetAuthorityEvent,
	BudgetEntitlementSchema,
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createBudgetAdmissionAuthority,
	EntitlementClaimSchema,
	HostingQuoteSchema,
	ProviderAccountExposureSchema,
} from "../src/budget-authority.js";

const NOW = "2026-10-30T12:00:00Z";
const SEED = 614440;
const run = { seed: SEED, numRuns: 350 };
const amount = fc.integer({ min: 0, max: 120 });

function base(limitMicros: number) {
	return create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "tenant",
			budgetId: "hosting",
			periodId: "p1",
			policyRevision: "v1",
		},
		limitMicros,
		observedAt: "2026-10-30T00:00:00Z",
		validUntil: "2026-10-31T00:00:00Z",
	});
}

function quote(id: string, bound: number) {
	return create(HostingQuoteSchema, {
		quoteId: id,
		yardId: "yard",
		providerId: "provider",
		ownerTenantId: "tenant",
		currency: "USD",
		totalMicros: Math.floor(bound / 2),
		liabilityBoundMicros: bound,
		components: [{ name: "usage", costMicros: Math.floor(bound / 2) }],
		requestDigest: `request-${id}`,
		observedAt: "2026-10-30T00:00:00Z",
		validUntil: "2026-10-31T00:00:00Z",
	});
}

function reserve(
	authority: ReturnType<typeof createBudgetAdmissionAuthority>,
	id: string,
	bound: number,
) {
	const snapshot = authority.read(NOW);
	if (!snapshot.identity) throw new Error("fixture identity missing");
	const candidate = quote(id, bound);
	return authority.reserve({
		reservationId: id,
		requestDigest: candidate.requestDigest,
		quote: candidate,
		identity: snapshot.identity,
		expectedSeq: snapshot.seq,
		now: NOW,
	});
}

describe("hosting budget authority generated properties", () => {
	it("admits only when every existing and requested exposure fits", () => {
		fc.assert(
			fc.property(
				amount,
				amount,
				amount,
				amount,
				amount,
				fc.array(amount, { minLength: 1, maxLength: 6 }),
				(limit, spent, unresolved, recovery, external, bounds) => {
					const snapshot = base(limit);
					snapshot.spentMicros = spent;
					snapshot.unresolvedMicros = unresolved;
					snapshot.recoveryReserveMicros = recovery;
					snapshot.externalCommittedMicros = external;
					const authority = createBudgetAdmissionAuthority({ snapshot });
					let held = 0;
					for (const [index, bound] of bounds.entries()) {
						const fits =
							spent + unresolved + recovery + external + held + bound <= limit;
						const before = authority.read(NOW);
						if (fits) {
							expect(
								reserve(authority, `work-${index}`, bound).reservedMicros,
							).toBe(bound);
							held += bound;
						} else {
							expect(() => reserve(authority, `work-${index}`, bound)).toThrow(
								"budget exhausted",
							);
							expect(authority.read(NOW)).toEqual(before);
						}
						expect(authority.read(NOW).reservedMicros).toBe(held);
					}
				},
			),
			run,
		);
	});

	it("retains claimed or uncertain holds through replay until evidence-backed settlement", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 1000 }),
				fc.nat({ max: 1000 }),
				fc.boolean(),
				fc.boolean(),
				(bound, usage, makeUncertain, claim) => {
					const snapshot = base(bound);
					const journal: BudgetAuthorityEvent[] = [];
					const authority = createBudgetAdmissionAuthority({
						snapshot,
						commit(event) {
							journal.push(event);
						},
					});
					reserve(authority, "work", bound);
					if (makeUncertain) authority.uncertain("work");
					if (claim) {
						const command = {
							reservationId: "work",
							requestDigest: "request-work",
							executionDigest: "execution",
						};
						authority.claimExecution(command);
						const revision = authority.read(NOW).seq;
						authority.claimExecution(command);
						expect(authority.read(NOW).seq).toBe(revision);
						expect(() => authority.release("work", true, "unused")).toThrow(
							"execution-claimed",
						);
						expect(() =>
							authority.claimExecution({
								...command,
								executionDigest: "other",
							}),
						).toThrow("another execution");
					}
					expect(authority.read(NOW).reservedMicros).toBe(bound);
					const reopened = createBudgetAdmissionAuthority({
						snapshot,
						priorEvents: journal,
					});
					expect(reopened.read(NOW)).toEqual(authority.read(NOW));
					expect(reopened.lookup("work")).toEqual(authority.lookup("work"));
					expect(() =>
						authority.settle("work", 0, {
							usageEvidenceRef: "",
							sourceStoppedEvidenceRef: "stopped",
						}),
					).toThrow("evidence required");
					const actual = usage % (bound + 1);
					const evidence = {
						usageEvidenceRef: "final-usage",
						sourceStoppedEvidenceRef: "stopped",
					};
					authority.settle("work", actual, evidence);
					const settled = authority.read(NOW);
					authority.settle("work", actual, evidence);
					expect(authority.read(NOW)).toEqual(settled);
					expect(settled).toMatchObject({
						reservedMicros: 0,
						spentMicros: actual,
					});
					expect(
						createBudgetAdmissionAuthority({
							snapshot,
							priorEvents: journal,
						}).read(NOW),
					).toEqual(settled);
				},
			),
			run,
		);
	});

	it("keeps provider and entitlement exposure within their separate limits", () => {
		const small = fc.integer({ min: 0, max: 10 });
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 20 }),
				fc.integer({ min: 0, max: 5 }),
				fc.integer({ min: 0, max: 5 }),
				fc.integer({ min: 0, max: 20 }),
				fc.array(fc.tuple(small, small), { minLength: 2, maxLength: 4 }),
				(accountLimit, accountSpent, accountExternal, allocation, requests) => {
					const snapshot = base(1000);
					snapshot.providerAccounts = [
						create(BudgetProviderAccountSchema, {
							providerAccountId: "payer",
							limitMicros: accountLimit,
							spentMicros: accountSpent,
							externalCommittedMicros: accountExternal,
						}),
					];
					snapshot.entitlements = [
						create(BudgetEntitlementSchema, {
							bucketId: "credit",
							unit: "units",
							periodId: "p1",
							remainingUnits: allocation,
							observedAt: "2026-10-30T00:00:00Z",
							validUntil: "2026-10-31T00:00:00Z",
						}),
					];
					const authority = createBudgetAdmissionAuthority({ snapshot });
					let held = 0;
					let heldUnits = 0;
					for (const [index, [bound, units]] of requests.entries()) {
						const candidate = quote(`scope-${index}`, bound);
						candidate.providerAccounts = [
							create(ProviderAccountExposureSchema, {
								providerAccountId: "payer",
								liabilityMicros: bound,
							}),
						];
						candidate.entitlementClaims = [
							create(EntitlementClaimSchema, {
								bucketId: "credit",
								unit: "units",
								units,
							}),
						];
						const before = authority.read(NOW);
						if (!before.identity) throw new Error("fixture identity missing");
						const command = {
							reservationId: `scope-${index}`,
							requestDigest: candidate.requestDigest,
							quote: candidate,
							identity: before.identity,
							expectedSeq: before.seq,
							now: NOW,
						};
						const accountFits =
							accountSpent + accountExternal + held + bound <= accountLimit;
						const allocationFits = heldUnits + units <= allocation;
						if (accountFits && allocationFits) {
							authority.reserve(command);
							held += bound;
							heldUnits += units;
						} else {
							expect(() => authority.reserve(command)).toThrow(
								accountFits
									? "entitlement exhausted"
									: "provider-account budget exhausted",
							);
							expect(authority.read(NOW)).toEqual(before);
						}
						const after = authority.read(NOW);
						expect(after.reservedMicros).toBe(held);
						expect(after.providerAccounts[0]?.reservedMicros).toBe(held);
						expect(after.entitlements[0]?.reservedUnits).toBe(heldUnits);
					}
				},
			),
			run,
		);
	});

	it("does not acknowledge an operation when its journal commit fails", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 1000 }),
				fc.constantFrom("reserve", "claim", "uncertain", "release", "settle"),
				(bound, operation) => {
					const snapshot = base(bound);
					const journal: BudgetAuthorityEvent[] = [];
					let failCommit = false;
					const authority = createBudgetAdmissionAuthority({
						snapshot,
						commit(event) {
							if (failCommit) throw new Error("injected commit failure");
							journal.push(event);
						},
					});
					if (operation !== "reserve") reserve(authority, "work", bound);
					const before = authority.read(NOW);
					const reservationBefore = authority.lookup("work");
					const entriesBefore = journal.length;
					failCommit = true;
					expect(() => {
						switch (operation) {
							case "reserve":
								reserve(authority, "work", bound);
								break;
							case "claim":
								authority.claimExecution({
									reservationId: "work",
									requestDigest: "request-work",
									executionDigest: "execution",
								});
								break;
							case "uncertain":
								authority.uncertain("work");
								break;
							case "release":
								authority.release("work", true, "unused");
								break;
							case "settle":
								authority.settle("work", bound, {
									usageEvidenceRef: "usage",
									sourceStoppedEvidenceRef: "stopped",
								});
								break;
						}
					}).toThrow("injected commit failure");
					expect(authority.read(NOW)).toEqual(before);
					expect(authority.lookup("work")).toEqual(reservationBefore);
					expect(journal).toHaveLength(entriesBefore);
					expect(
						createBudgetAdmissionAuthority({
							snapshot,
							priorEvents: journal,
						}).read(NOW),
					).toEqual(before);
				},
			),
			run,
		);
	});
});
