/* oxlint-disable unicorn/no-thenable -- SAFETY: exercise an untrusted thenable without invoking its accessor. */
import { runInNewContext } from "node:vm";
import { clone, create } from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	type BudgetAuthorityEvent,
	BudgetAuthorityEventSchema,
	BudgetEntitlementSchema,
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createBudgetAdmissionAuthority,
	EntitlementClaimSchema,
	HostingQuoteSchema,
	IacUnpricedPolicyProofSchema,
	IacUnpricedScopeProofSchema,
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
	it("fails closed after a commit returns an asynchronous or ambiguous result", () => {
		let thenAccesses = 0;
		// biome-ignore lint/suspicious/noThenProperty: this test refuses the accessor without invoking it.
		const thenable = Object.defineProperty({}, "then", {
			get() {
				thenAccesses += 1;
				throw new Error("then must not be inspected");
			},
		});
		const foreignPromise: unknown = runInNewContext("Promise.resolve()");
		const variants = [
			foreignPromise,
			Promise.resolve(),
			thenable,
			{},
			() => {},
		];
		const seen = new Set<unknown>();
		fc.assert(
			fc.property(fc.constantFrom(...variants), (result) => {
				seen.add(result);
				const snapshot = base(100);
				const identity = snapshot.identity;
				if (!identity) throw new Error("fixture identity missing");
				const authority = createBudgetAdmissionAuthority({
					snapshot,
					commit: () => result,
				});
				expect(() => reserve(authority, "work", 10)).toThrow(
					"budget commit must append synchronously",
				);
				expect(() => authority.read(NOW)).toThrow(
					"budget commit outcome uncertain",
				);
				expect(() => authority.lookup("work")).toThrow(
					"budget commit outcome uncertain",
				);
				expect(() => authority.configure(snapshot, 0, NOW)).toThrow(
					"budget commit outcome uncertain",
				);
				const operations = [
					() =>
						authority.claimExecution({
							reservationId: "work",
							requestDigest: "request-work",
							executionDigest: "execution",
						}),
					() =>
						authority.reserve({
							reservationId: "work",
							requestDigest: "request-work",
							quote: quote("work", 10),
							identity,
							expectedSeq: 0,
							now: NOW,
						}),
					() =>
						authority.reserveUnbounded({
							reservationId: "work",
							requestDigest: "request-work",
							inventoryHash: "inventory",
							policyProof: create(IacUnpricedPolicyProofSchema),
							scopeProof: create(IacUnpricedScopeProofSchema),
							identity,
							providerAccountIds: [],
							expectedSeq: 0,
							now: NOW,
						}),
					() =>
						authority.revalidateUnbounded({
							reservationId: "work",
							requestDigest: "request-work",
							inventoryHash: "inventory",
							executionDigest: "execution",
							policyProofHash: "policy",
							scopeProofHash: "scope",
							now: NOW,
						}),
					() =>
						authority.revalidatePriced({
							reservationId: "work",
							requestId: "request",
							targetId: "target",
							tenantId: "tenant",
							requestDigest: "request-work",
							planDigest: "plan",
							inventoryHash: "inventory",
							modelHash: "model",
							quoteHash: "quote",
							now: NOW,
						}),
					() =>
						authority.settle("work", 0, {
							usageEvidenceRef: "usage",
							sourceStoppedEvidenceRef: "stopped",
						}),
					() => authority.uncertain("work"),
					() => authority.release("work", true, "unused"),
				];
				for (const operation of operations)
					expect(operation).toThrow("budget commit outcome uncertain");
			}),
			{ seed: SEED, numRuns: 100 },
		);
		expect(seen.size).toBe(variants.length);
		expect(thenAccesses).toBe(0);
	});

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
							kind: "allowance",
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
								kind: "allowance",
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
				fc.boolean(),
				(bound, operation, appendBeforeThrow) => {
					const snapshot = base(bound);
					const journal: BudgetAuthorityEvent[] = [];
					let failCommit = false;
					let observedBeforeFailure: ReturnType<typeof base> | undefined;
					const authority = createBudgetAdmissionAuthority({
						snapshot,
						commit(event) {
							if (failCommit) {
								observedBeforeFailure = authority.read(NOW);
								if (appendBeforeThrow) journal.push(event);
								throw new Error("injected commit failure");
							}
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
					}).toThrow("budget commit outcome uncertain");
					expect(observedBeforeFailure).toEqual(before);
					expect(() => authority.read(NOW)).toThrow(
						"budget commit outcome uncertain",
					);
					expect(() => authority.lookup("work")).toThrow(
						"budget commit outcome uncertain",
					);
					expect(journal).toHaveLength(
						entriesBefore + Number(appendBeforeThrow),
					);
					const reopened = createBudgetAdmissionAuthority({
						snapshot,
						priorEvents: journal,
					});
					if (appendBeforeThrow) {
						expect(reopened.read(NOW)).toEqual(journal.at(-1)?.snapshot);
						expect(reopened.read(NOW).seq).toBe(before.seq + 1);
						expect(reopened.lookup("work")).toEqual(
							journal
								.at(-1)
								?.reservations.find((row) => row.reservationId === "work"),
						);
					} else {
						expect(reopened.read(NOW)).toEqual(before);
						expect(reopened.lookup("work")).toEqual(reservationBefore);
					}
				},
			),
			run,
		);
	});

	it("serializes journal callbacks that attempt another admission", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 1000 }),
				fc.boolean(),
				(bound, catchNested) => {
					const snapshot = base(bound);
					const journal: BudgetAuthorityEvent[] = [];
					let tryNested = true;
					let authority = createBudgetAdmissionAuthority({
						snapshot,
						commit(event) {
							if (tryNested) {
								tryNested = false;
								if (catchNested) {
									expect(() => reserve(authority, "nested", bound)).toThrow(
										"budget authority mutation during commit",
									);
								} else {
									reserve(authority, "nested", bound);
								}
							}
							journal.push(event);
						},
					});
					if (catchNested) {
						reserve(authority, "outer", bound);
						expect(authority.lookup("nested")).toBeUndefined();
						expect(authority.read(NOW).reservedMicros).toBe(bound);
						expect(journal).toHaveLength(1);
					} else {
						expect(() => reserve(authority, "outer", bound)).toThrow(
							"budget commit outcome uncertain",
						);
						expect(() => authority.read(NOW)).toThrow(
							"budget commit outcome uncertain",
						);
						expect(journal).toHaveLength(0);
						authority = createBudgetAdmissionAuthority({
							snapshot,
							priorEvents: journal,
							commit(event) {
								journal.push(event);
							},
						});
						reserve(authority, "outer", bound);
						expect(authority.lookup("nested")).toBeUndefined();
						expect(authority.read(NOW).reservedMicros).toBe(bound);
						expect(journal).toHaveLength(1);
					}
					expect(
						createBudgetAdmissionAuthority({
							snapshot,
							priorEvents: journal,
						}).read(NOW),
					).toEqual(authority.read(NOW));
				},
			),
			{ seed: 614441, numRuns: 100 },
		);
	});

	it("rejects configure scope changes while reserved units remain on the bucket", () => {
		const snapshot = base(10);
		snapshot.entitlements = [
			create(BudgetEntitlementSchema, {
				bucketId: "credit",
				kind: "allowance",
				unit: "units",
				periodId: "p1",
				remainingUnits: 10,
				observedAt: "2026-10-30T00:00:00Z",
				validUntil: "2026-10-31T00:00:00Z",
			}),
		];
		const authority = createBudgetAdmissionAuthority({
			snapshot,
			commit() {},
		});
		const candidate = quote("units", 10);
		candidate.entitlementClaims = [
			create(EntitlementClaimSchema, {
				bucketId: "credit",
				kind: "allowance",
				unit: "units",
				units: 2,
			}),
		];
		const before = authority.read(NOW);
		if (!before.identity) throw new Error("fixture identity missing");
		authority.reserve({
			reservationId: "units",
			requestDigest: candidate.requestDigest,
			quote: candidate,
			identity: before.identity,
			expectedSeq: before.seq,
			now: NOW,
		});
		const updated = authority.read(NOW);
		const bucket = updated.entitlements[0];
		if (!bucket) throw new Error("fixture bucket missing");
		expect(bucket.reservedUnits).toBeGreaterThan(0);
		bucket.periodId = "p2";
		bucket.observedAt = "2026-10-30T01:00:00Z";
		expect(() => authority.configure(updated, updated.seq, NOW)).toThrow(
			"active entitlement cannot change unit or period",
		);
	});

	it("preserves the scope of active zero-unit entitlement claims", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("held", "uncertain", "claimed"),
				fc.constantFrom("unit", "periodId"),
				(phase, field) => {
					const snapshot = base(10);
					snapshot.entitlements = [
						create(BudgetEntitlementSchema, {
							bucketId: "credit",
							kind: "allowance",
							unit: "units",
							periodId: "p1",
							remainingUnits: 10,
							observedAt: "2026-10-30T00:00:00Z",
							validUntil: "2026-10-31T00:00:00Z",
						}),
					];
					const journal: BudgetAuthorityEvent[] = [];
					const authority = createBudgetAdmissionAuthority({
						snapshot,
						commit(event) {
							journal.push(event);
						},
					});
					const candidate = quote("zero", 0);
					candidate.entitlementClaims = [
						create(EntitlementClaimSchema, {
							bucketId: "credit",
							kind: "allowance",
							unit: "units",
							units: 0,
						}),
					];
					const before = authority.read(NOW);
					if (!before.identity) throw new Error("fixture identity missing");
					authority.reserve({
						reservationId: "zero",
						requestDigest: candidate.requestDigest,
						quote: candidate,
						identity: before.identity,
						expectedSeq: before.seq,
						now: NOW,
					});
					if (phase === "uncertain") authority.uncertain("zero");
					if (phase === "claimed")
						authority.claimExecution({
							reservationId: "zero",
							requestDigest: candidate.requestDigest,
							executionDigest: "execution",
						});
					const updated = authority.read(NOW);
					const bucket = updated.entitlements[0];
					if (!bucket) throw new Error("fixture bucket missing");
					bucket[field] = field === "unit" ? "other" : "p2";
					bucket.observedAt = "2026-10-30T01:00:00Z";
					expect(() => authority.configure(updated, updated.seq, NOW)).toThrow(
						"active entitlement cannot change unit or period",
					);
					expect(authority.read(NOW).seq).toBe(updated.seq);
					const last = journal.at(-1);
					if (!last) throw new Error("fixture journal missing");
					const changed = clone(BudgetAuthorityEventSchema, last);
					const changedBucket = changed.snapshot?.entitlements[0];
					if (!changed.snapshot || !changedBucket)
						throw new Error("fixture journal bucket missing");
					changed.type = "budget.PolicyRevised";
					changed.snapshot.seq++;
					changedBucket[field] = field === "unit" ? "other" : "p2";
					changedBucket.observedAt = "2026-10-30T01:00:00Z";
					expect(() =>
						createBudgetAdmissionAuthority({
							snapshot,
							priorEvents: [...journal, changed],
						}),
					).toThrow("active financial scopes cannot be removed");
					const reopened = createBudgetAdmissionAuthority({
						snapshot,
						priorEvents: journal,
					});
					for (const instance of [authority, reopened]) {
						instance.settle("zero", 0, {
							usageEvidenceRef: "usage",
							sourceStoppedEvidenceRef: "stopped",
							entitlementClaims: candidate.entitlementClaims,
						});
						expect(instance.read(NOW).reservedMicros).toBe(0);
					}
					const after = authority.read(NOW);
					const retiredBucket = after.entitlements[0];
					if (!retiredBucket) throw new Error("fixture bucket missing");
					retiredBucket[field] = field === "unit" ? "other" : "p2";
					retiredBucket.observedAt = "2026-10-30T01:00:00Z";
					authority.configure(after, after.seq, NOW);
					expect(authority.read(NOW).entitlements[0]?.[field]).toBe(
						field === "unit" ? "other" : "p2",
					);
				},
			),
			{ seed: 614442, numRuns: 100 },
		);
	});
});
