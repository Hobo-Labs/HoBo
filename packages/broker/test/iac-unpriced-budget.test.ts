import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, create, toJson } from "@bufbuild/protobuf";
import { stableHash } from "@hobo/pricing";
import { afterEach, describe, expect, it } from "vitest";
import {
	IacUnpricedPolicyProofSchema,
	IacUnpricedScopeProofSchema,
} from "../src/_generated/yard_placement_pb.js";
import {
	BudgetIdentitySchema,
	BudgetAuthorityEventSchema,
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createSqliteBudgetAdmissionAuthority,
	createBudgetAdmissionAuthority,
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
		unpricedScopeTrust: {
			verify: (proof: { signature: string }) =>
				proof.signature === "scope-signature",
			isCurrent: (proof: { signature: string }) =>
				proof.signature === "scope-signature",
			settlement: ({
				reservation,
				actualMicros,
				evidence,
			}: {
				reservation: {
					reservationId: string;
					executionDigest: string;
					financialPlanHash: string;
				};
				actualMicros: number;
				evidence: {
					financeSignature: string;
					usageEvidenceRef: string;
					sourceStoppedEvidenceRef: string;
					providerAccounts: {
						providerAccountId: string;
						liabilityMicros: number;
					}[];
				};
			}) =>
				evidence.sourceStoppedEvidenceRef === "stop:1" &&
				evidence.financeSignature ===
					`${reservation.reservationId}:${reservation.executionDigest}:${reservation.financialPlanHash}:${actualMicros}:${evidence.usageEvidenceRef}:${evidence.sourceStoppedEvidenceRef}:${JSON.stringify(evidence.providerAccounts.map(({ providerAccountId, liabilityMicros }) => ({ providerAccountId, liabilityMicros })))}`,
		},
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
		scopeProof: create(IacUnpricedScopeProofSchema, {
			identity,
			providerAccountIds: ["account-a"],
			authorityRef: "scope-authority",
			evidenceRef: "exclusive:1",
			ownershipEpoch: "epoch:1",
			observedAt: "2026-01-01T00:00:00Z",
			exclusiveUntilSettled: true,
			noSharedEntitlements: true,
			signature: "scope-signature",
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
	it("exhausts bounded admission, claim, revocation, settlement and replay sequences", () => {
		const { options, unpriced, quote } = fixture();
		const actions = [
			"priced",
			"unpriced",
			"claim",
			"forge",
			"settle",
			"release",
			"revoke",
			"replay",
		] as const;
		const policyProofHash = stableHash(
			toJson(IacUnpricedPolicyProofSchema, unpriced.policyProof, {
				alwaysEmitImplicit: true,
			}),
		);
		const scopeProofHash = stableHash(
			toJson(IacUnpricedScopeProofSchema, unpriced.scopeProof, {
				alwaysEmitImplicit: true,
			}),
		);
		const evidence = {
			usageEvidenceRef: "usage:1",
			sourceStoppedEvidenceRef: "stop:1",
			providerAccounts: [
				{ providerAccountId: "account-a", liabilityMicros: 0 },
			],
			financeSignature: `${unpriced.reservationId}:exec:1:${unpriced.inventoryHash}:0:usage:1:stop:1:[{"providerAccountId":"account-a","liabilityMicros":0}]`,
		};
		// The host independently owns every account and entitlement covered by this
		// attestation, and fences other authorities until settlement. This finite
		// ledger model does not purport to implement that external guarantee.
		for (let sequence = 0; sequence < actions.length ** 4; sequence++) {
			let active = true;
			const trust = { ...options.unpricedScopeTrust, isCurrent: () => active };
			const events: ReturnType<
				typeof create<typeof BudgetAuthorityEventSchema>
			>[] = [];
			const open = () =>
				createBudgetAdmissionAuthority({
					snapshot: options.snapshot,
					priorEvents: events,
					unpricedScopeTrust: trust,
					commit: (event) => {
						events.push(clone(BudgetAuthorityEventSchema, event));
					},
				});
			let ledger = open();
			let priced = false;
			let state: "missing" | "held" | "claimed" | "released" | "settled" =
				"missing";
			let n = sequence;
			for (let step = 0; step < 4; step++) {
				const action = actions[n % actions.length];
				n = Math.floor(n / actions.length);
				const seq = ledger.read(now).seq;
				if (action === "priced") {
					const run = () =>
						ledger.reserve({
							reservationId: "priced",
							requestDigest: quote.requestDigest,
							quote,
							identity,
							expectedSeq: seq,
							now,
						});
					if (!priced && (state === "held" || state === "claimed"))
						expect(run).toThrow();
					else {
						run();
						priced = true;
					}
				} else if (action === "unpriced") {
					const run = () =>
						ledger.reserveUnbounded({ ...unpriced, expectedSeq: seq });
					if (
						!active ||
						state === "released" ||
						(state === "missing" && priced)
					)
						expect(run).toThrow();
					else {
						run();
						if (state === "missing") state = "held";
					}
				} else if (action === "claim") {
					const run = () =>
						ledger.claimExecution({
							reservationId: unpriced.reservationId,
							requestDigest: unpriced.requestDigest,
							executionDigest: "exec:1",
							expectedSeq: seq,
							now,
						});
					if (active && (state === "held" || state === "claimed")) {
						run();
						state = "claimed";
					} else expect(run).toThrow();
				} else if (action === "forge") {
					expect(() =>
						ledger.settle(unpriced.reservationId, 0, {
							...evidence,
							financeSignature: "forged",
						}),
					).toThrow();
				} else if (action === "settle" && state === "claimed") {
					ledger.settle(unpriced.reservationId, 0, evidence);
					state = "settled";
				} else if (action === "release") {
					const run = () =>
						ledger.release(unpriced.reservationId, true, "unused");
					if (state === "held") {
						run();
						state = "released";
					} else if (state !== "released") expect(run).toThrow();
				} else if (action === "revoke") active = false;
				else if (action === "replay") ledger = open();
				const snapshot = ledger.read(now);
				expect(snapshot.unboundedExposureCount).toBe(
					state === "held" || state === "claimed" ? 1 : 0,
				);
				expect(snapshot.reservedMicros).toBe(priced ? 1_000_000 : 0);
				expect(
					!(snapshot.unboundedExposureCount > 0 && snapshot.reservedMicros > 0),
				).toBe(true);
				expect(
					ledger.revalidateUnbounded({
						reservationId: unpriced.reservationId,
						requestDigest: unpriced.requestDigest,
						inventoryHash: unpriced.inventoryHash,
						executionDigest: "exec:1",
						policyProofHash,
						scopeProofHash,
						now,
					}),
				).toBe(state === "claimed" && active);
			}
		}
	}, 30_000);

	it("captures enrolled verifier methods when opening an authority", () => {
		const { options, unpriced } = fixture();
		const ledger = createSqliteBudgetAdmissionAuthority(options);
		options.unpricedScopeTrust.verify = () => true;
		const forged = clone(IacUnpricedScopeProofSchema, unpriced.scopeProof);
		forged.signature = "forged";
		expect(() =>
			ledger.reserveUnbounded({ ...unpriced, scopeProof: forged }),
		).toThrow("exclusive financial scope");
		ledger.close();
	});
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
			financeSignature: `${unpriced.reservationId}:exec:1:${unpriced.inventoryHash}:1200000:usage:1:stop:1:[{"providerAccountId":"account-a","liabilityMicros":1200000}]`,
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

	it("does not clear exposure on forged, mismatched, or ongoing-source settlement", () => {
		const { options, unpriced } = fixture();
		const ledger = createSqliteBudgetAdmissionAuthority(options);
		ledger.reserveUnbounded(unpriced);
		ledger.claimExecution({
			reservationId: unpriced.reservationId,
			requestDigest: unpriced.requestDigest,
			executionDigest: "exec:1",
			expectedSeq: 1,
		});
		const evidence = {
			usageEvidenceRef: "usage:1",
			sourceStoppedEvidenceRef: "stop:1",
			providerAccounts: [
				{ providerAccountId: "account-a", liabilityMicros: 0 },
			],
			financeSignature: `${unpriced.reservationId}:exec:1:${unpriced.inventoryHash}:0:usage:1:stop:1:[{"providerAccountId":"account-a","liabilityMicros":0}]`,
		};
		for (const invalid of [
			{ ...evidence, financeSignature: "" },
			{ ...evidence, financeSignature: "forged" },
			{ ...evidence, sourceStoppedEvidenceRef: "still-running" },
			{
				...evidence,
				providerAccounts: [
					{ providerAccountId: "account-b", liabilityMicros: 0 },
				],
			},
			{
				...evidence,
				providerAccounts: [
					{ providerAccountId: "account-a", liabilityMicros: 1 },
				],
			},
		])
			expect(() => ledger.settle(unpriced.reservationId, 0, invalid)).toThrow();
		expect(() => ledger.settle(unpriced.reservationId, 1, evidence)).toThrow();
		expect(ledger.read(now).unboundedExposureCount).toBe(1);
		ledger.settle(unpriced.reservationId, 0, evidence);
		expect(ledger.read(now).unboundedExposureCount).toBe(0);
		ledger.close();
	});

	it("rejects competing unpriced scopes when two budget authorities share an account", async () => {
		const { options, unpriced } = fixture();
		const owners = new Set(["hosting", "other-budget"]);
		const sharedTrust = {
			...options.unpricedScopeTrust,
			verify: (proof: { signature: string }) =>
				proof.signature === "scope-signature" && owners.size === 1,
			isCurrent: () => owners.size === 1,
		};
		const one = createSqliteBudgetAdmissionAuthority({
			...options,
			unpricedScopeTrust: sharedTrust,
		});
		const otherSnapshot = clone(BudgetLedgerSnapshotSchema, options.snapshot);
		otherSnapshot.identity = create(BudgetIdentitySchema, {
			...identity,
			budgetId: "other-budget",
		});
		const other = createSqliteBudgetAdmissionAuthority({
			...options,
			path: `${options.path}.other`,
			unpricedScopeTrust: sharedTrust,
			snapshot: otherSnapshot,
		});
		const second = {
			...unpriced,
			reservationId: "iac:other",
			identity: otherSnapshot.identity,
			policyProof: create(IacUnpricedPolicyProofSchema, {
				...unpriced.policyProof,
				identity: otherSnapshot.identity,
			}),
			scopeProof: create(IacUnpricedScopeProofSchema, {
				...unpriced.scopeProof,
				identity: otherSnapshot.identity,
			}),
		};
		// The shared host registry has already authenticated both budget owners.
		// It must reject *both* proofs; neither local database can see the other.
		const attempts = await Promise.allSettled([
			Promise.resolve().then(() => one.reserveUnbounded(unpriced)),
			Promise.resolve().then(() => other.reserveUnbounded(second)),
		]);
		expect(attempts.map((result) => result.status)).toEqual([
			"rejected",
			"rejected",
		]);
		expect(one.read(now).unboundedExposureCount).toBe(0);
		expect(other.read(now).unboundedExposureCount).toBe(0);
		one.close();
		other.close();
	});

	it("fails closed without independently enrolled scope trust", () => {
		const { options, unpriced } = fixture();
		const { unpricedScopeTrust: _trust, ...withoutTrust } = options;
		const ledger = createSqliteBudgetAdmissionAuthority(withoutTrust);
		expect(() => ledger.reserveUnbounded(unpriced)).toThrow(
			"exclusive financial scope",
		);
		expect(ledger.read(now).unboundedExposureCount).toBe(0);
		ledger.close();
	});

	it.each([
		"signature",
		"shared",
		"temporary",
		"account",
	])("rejects unsafe financial scope proof: %s", (kind) => {
		const { options, unpriced } = fixture();
		const ledger = createSqliteBudgetAdmissionAuthority(options);
		const scope = clone(IacUnpricedScopeProofSchema, unpriced.scopeProof);
		if (kind === "signature") scope.signature = "forged";
		if (kind === "shared") scope.noSharedEntitlements = false;
		if (kind === "temporary") scope.exclusiveUntilSettled = false;
		if (kind === "account") scope.providerAccountIds = ["other-account"];
		expect(() =>
			ledger.reserveUnbounded({ ...unpriced, scopeProof: scope }),
		).toThrow();
		expect(ledger.read(now).unboundedExposureCount).toBe(0);
		ledger.close();
	});

	it("does not accept asynchronous scope checks as successful synchronous trust", () => {
		const { options, unpriced } = fixture();
		const ledger = createSqliteBudgetAdmissionAuthority({
			...options,
			unpricedScopeTrust: {
				...options.unpricedScopeTrust,
				// SAFETY: deliberately malformed asynchronous verifier exercises the transaction boundary.
				verify: (() => Promise.resolve(true)) as never,
			},
		});
		expect(() => ledger.reserveUnbounded(unpriced)).toThrow(
			"exclusive financial scope",
		);
		expect(ledger.read(now).unboundedExposureCount).toBe(0);
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
