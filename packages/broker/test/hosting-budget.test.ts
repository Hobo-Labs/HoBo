import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type BudgetAuthorityEvent,
	BudgetAuthorityEventSchema,
	BudgetEntitlementSchema,
	type BudgetLedgerSnapshot,
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	buildDeploymentRequestFromParts,
	contentHashOf,
	createBudgetAdmissionAuthority,
	createLocalHostCatalog,
	createMeteredBillingPlane,
	createSqliteBudgetAdmissionAuthority,
	EntitlementClaimSchema,
	HostingPolicyProofSchema,
	HostingQuoteSchema,
	LOCAL_HOST_PROVIDER_ID,
	localYardInstance,
	ProviderAccountExposureSchema,
	resolveBindleDeployment,
	YARD_EVENTS,
	type YardFirstPlacementDeps,
	yardEvent,
} from "../src/index.js";

const NOW = "2026-10-29T12:00:00Z";
const allowHosting: NonNullable<YardFirstPlacementDeps["authorizeHosting"]> = (
	input,
) => ({
	gate: { effect: "allow", reasons: [], events: [] },
	proof: create(HostingPolicyProofSchema, {
		requestDigest: input.requestDigest,
		quoteId: input.quote.quoteId,
		identity: input.identity,
		effect: "allow",
		policyHash: "sha256:approved-policy",
		evidenceRef: "gatekeeper:decision",
		obligationsSatisfied: true,
	}),
});
function snapshot(limitMicros = 100): BudgetLedgerSnapshot {
	return create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "tenant",
			budgetId: "hosting",
			periodId: "2026-10",
			policyRevision: "r1",
		},
		seq: 0,
		limitMicros,
		spentMicros: 0,
		reservedMicros: 0,
		observedAt: "2026-10-29T00:00:00Z",
		validUntil: "2026-11-01T00:00:00Z",
	});
}
function quote(id = "q1", expected = 40, bound = 60) {
	return create(HostingQuoteSchema, {
		quoteId: id,
		yardId: "yard:a",
		providerId: "aws",
		ownerTenantId: "tenant",
		currency: "USD",
		totalMicros: expected,
		liabilityBoundMicros: bound,
		components: [{ name: "execution-and-egress", costMicros: expected }],
		requestDigest: "request-digest",
		observedAt: "2026-10-29T00:00:00Z",
		validUntil: "2026-11-01T00:00:00Z",
	});
}
function input(
	authority: ReturnType<typeof createBudgetAdmissionAuthority>,
	id = "first",
	q = quote(),
) {
	const current = authority.read(NOW);
	if (!current.identity) throw new Error("fixture identity missing");
	return {
		reservationId: id,
		requestDigest: q.requestDigest,
		quote: q,
		identity: current.identity,
		expectedSeq: current.seq,
		now: NOW,
	};
}

describe("shared financial admission", () => {
	it("adopts a financial hold for one execution without reserving twice", () => {
		const authority = createBudgetAdmissionAuthority({ snapshot: snapshot() });
		const q = quote();
		q.financialPlanHash = "financial-plan";
		authority.reserve(input(authority, "first", q));
		const command = {
			reservationId: "first",
			requestDigest: q.requestDigest,
			executionDigest: "execution-a",
		};
		expect(authority.claimExecution(command).financialPlanHash).toBe(
			"financial-plan",
		);
		const revision = authority.read(NOW).seq;
		expect(authority.claimExecution(command).executionDigest).toBe(
			"execution-a",
		);
		expect(authority.read(NOW)).toMatchObject({
			seq: revision,
			reservedMicros: 60,
		});
		expect(() =>
			authority.claimExecution({ ...command, executionDigest: "execution-b" }),
		).toThrow("another execution");
		expect(() =>
			authority.claimExecution({ ...command, requestDigest: "foreign" }),
		).toThrow("exact live");
		authority.settle("first", 20, {
			usageEvidenceRef: "usage",
			sourceStoppedEvidenceRef: "stopped",
		});
		expect(() => authority.claimExecution(command)).toThrow("exact live");
	});
	it("replays commitments and rejects cross-tenant or corrupt journal snapshots", () => {
		const journal: BudgetAuthorityEvent[] = [];
		const authority = createBudgetAdmissionAuthority({
			snapshot: snapshot(),
			commit(event) {
				journal.push(event);
			},
		});
		authority.reserve(input(authority));
		authority.uncertain("first");
		const reopened = createBudgetAdmissionAuthority({
			snapshot: snapshot(),
			priorEvents: journal,
		});
		expect(reopened.lookup("first")?.status).toBe("uncertain");
		expect(reopened.read(NOW).reservedMicros).toBe(60);
		const firstEvent = journal[0];
		if (!firstEvent) throw new Error("fixture journal missing");
		const foreign = clone(BudgetAuthorityEventSchema, firstEvent);
		if (!foreign.snapshot?.identity) throw new Error("fixture");
		foreign.snapshot.identity.tenantId = "another-tenant";
		expect(() =>
			createBudgetAdmissionAuthority({
				snapshot: snapshot(),
				priorEvents: [foreign],
			}),
		).toThrow("ownership mismatch");
		const duplicate = clone(BudgetAuthorityEventSchema, firstEvent);
		const firstReservation = duplicate.reservations[0];
		if (!firstReservation) throw new Error("fixture reservation missing");
		duplicate.reservations.push(firstReservation);
		expect(() =>
			createBudgetAdmissionAuthority({
				snapshot: snapshot(),
				priorEvents: [duplicate],
			}),
		).toThrow("duplicate journal");
		const corrupted = clone(BudgetAuthorityEventSchema, firstEvent);
		if (!corrupted.snapshot) throw new Error("fixture");
		corrupted.snapshot.reservedMicros = 0;
		expect(() =>
			createBudgetAdmissionAuthority({
				snapshot: snapshot(),
				priorEvents: [corrupted],
			}),
		).toThrow("exposure mismatch");
		const reassigned = snapshot();
		if (!reassigned.identity) throw new Error("fixture");
		reassigned.identity.budgetId = "unrelated";
		const unused = createBudgetAdmissionAuthority({ snapshot: snapshot() });
		expect(() => unused.configure(reassigned, 0, NOW)).toThrow("ownership");
	});
	it("reserves the liability bound and retains unknown charges", () => {
		const authority = createBudgetAdmissionAuthority({ snapshot: snapshot() });
		const request = input(authority);
		expect(authority.reserve(request).reservedMicros).toBe(60);
		expect(authority.reserve(request).reservationId).toBe("first");
		authority.uncertain("first");
		expect(authority.read(NOW).reservedMicros).toBe(60);
		expect(() => authority.reserve(input(authority, "second"))).toThrow(
			"budget exhausted",
		);
		expect(() =>
			authority.settle("first", 30, {
				usageEvidenceRef: "",
				sourceStoppedEvidenceRef: "stop",
			}),
		).toThrow("evidence required");
		authority.settle("first", 30, {
			usageEvidenceRef: "usage:verified",
			sourceStoppedEvidenceRef: "stop:verified",
		});
		expect(authority.read(NOW)).toMatchObject({
			spentMicros: 30,
			reservedMicros: 0,
		});
	});
	it("rejects estimates without a bound, mismatched quote replay and zero budgets", () => {
		const authority = createBudgetAdmissionAuthority({ snapshot: snapshot(0) });
		expect(() => authority.reserve(input(authority))).toThrow(
			"budget exhausted",
		);
		const missing = quote();
		missing.liabilityBoundMicros = undefined;
		expect(() =>
			authority.reserve(input(authority, "estimate", missing)),
		).toThrow("liability bound");
		const funded = createBudgetAdmissionAuthority({ snapshot: snapshot() });
		funded.reserve(input(funded));
		const changed = quote();
		changed.yardId = "yard:b";
		expect(() => funded.reserve(input(funded, "first", changed))).toThrow(
			"replay differs",
		);
	});
	it("retains zero-cash commitments across period rollover and preserves spent account watermarks", () => {
		const base = snapshot();
		base.providerAccounts = [
			create(BudgetProviderAccountSchema, {
				providerAccountId: "payer",
				limitMicros: 100,
				spentMicros: 40,
			}),
		];
		const authority = createBudgetAdmissionAuthority({ snapshot: base });
		const free = quote("free", 0, 0);
		free.providerAccounts = [
			create(ProviderAccountExposureSchema, {
				providerAccountId: "payer",
				liabilityMicros: 0,
			}),
		];
		authority.reserve(input(authority, "free-hold", free));
		const period = snapshot();
		if (!period.identity) throw new Error("fixture identity");
		period.identity.periodId = "2026-11";
		expect(() =>
			authority.configure(period, authority.read(NOW).seq, NOW),
		).toThrow("outstanding or uncertain");
		authority.release("free-hold", true, "never-dispatched");
		const erased = snapshot();
		if (!erased.identity) throw new Error("fixture identity");
		erased.identity.policyRevision = "r2";
		expect(() =>
			authority.configure(erased, authority.read(NOW).seq, NOW),
		).toThrow("spent provider-account");
		expect(authority.read(NOW).providerAccounts[0]?.spentMicros).toBe(40);
	});
	it("separates cap revisions and periods without resetting live commitments", () => {
		const authority = createBudgetAdmissionAuthority({ snapshot: snapshot() });
		authority.reserve(input(authority));
		const period = snapshot();
		if (!period.identity) throw new Error("fixture");
		period.identity.periodId = "2026-11";
		expect(() => authority.configure(period, 1, NOW)).toThrow(
			"outstanding or uncertain",
		);
		const revised = snapshot(10);
		if (!revised.identity) throw new Error("fixture");
		revised.identity.policyRevision = "r2";
		authority.configure(revised, 1, NOW);
		expect(authority.read(NOW)).toMatchObject({
			limitMicros: 10,
			reservedMicros: 60,
		});
		expect(() => authority.reserve(input(authority, "second"))).toThrow(
			"budget exhausted",
		);
		expect(() => authority.reserve(input(authority, "first"))).toThrow(
			"superseded",
		);
	});
	it("records actual overruns and prevents subsequent paid admission", () => {
		const authority = createBudgetAdmissionAuthority({ snapshot: snapshot() });
		authority.reserve(input(authority));
		authority.settle("first", 120, {
			usageEvidenceRef: "usage:120",
			sourceStoppedEvidenceRef: "retired",
		});
		expect(authority.read(NOW).spentMicros).toBe(120);
		expect(() => authority.reserve(input(authority, "second"))).toThrow(
			"budget exhausted",
		);
	});
	it("serializes independent SQLite connections and reopens uncertain commitments", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-budget-authority-"));
		const path = join(directory, "budget.sqlite");
		const first = createSqliteBudgetAdmissionAuthority({
			path,
			snapshot: snapshot(),
			now: () => NOW,
		});
		const second = createSqliteBudgetAdmissionAuthority({
			path,
			snapshot: snapshot(),
			now: () => NOW,
		});
		try {
			const stale = input(second, "second");
			first.reserve(input(first));
			expect(() => second.reserve(stale)).toThrow("sequence conflict");
			expect(() => second.reserve(input(second, "second"))).toThrow(
				"budget exhausted",
			);
			first.uncertain("first");
			const reopened = createSqliteBudgetAdmissionAuthority({
				path,
				snapshot: snapshot(),
				now: () => NOW,
			});
			try {
				expect(reopened.lookup("first")?.status).toBe("uncertain");
				expect(reopened.read(NOW).reservedMicros).toBe(60);
				expect(() => reopened.reserve(input(reopened, "second"))).toThrow(
					"budget exhausted",
				);
			} finally {
				reopened.close();
			}
		} finally {
			first.close();
			second.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("atomically fences free allocations across otherwise free deployments", () => {
		const initial = snapshot(0);
		initial.entitlements = [
			create(BudgetEntitlementSchema, {
				bucketId: "account-free",
				unit: "runner-ms",
				periodId: "2026-10",
				remainingUnits: 100,
				observedAt: "2026-10-29T00:00:00Z",
				validUntil: "2026-11-01T00:00:00Z",
			}),
		];
		const authority = createBudgetAdmissionAuthority({ snapshot: initial });
		const free = quote("free", 0, 0);
		free.entitlementClaims = [
			create(EntitlementClaimSchema, {
				bucketId: "account-free",
				unit: "runner-ms",
				units: 70,
			}),
		];
		authority.reserve(input(authority, "a", free));
		authority.uncertain("a");
		expect(() => authority.reserve(input(authority, "b", free))).toThrow(
			"entitlement exhausted",
		);
		expect(() =>
			authority.settle("a", 0, {
				usageEvidenceRef: "meter",
				sourceStoppedEvidenceRef: "retired",
			}),
		).toThrow("complete account and entitlement");
		authority.settle("a", 0, {
			usageEvidenceRef: "meter",
			sourceStoppedEvidenceRef: "retired",
			entitlementClaims: [
				create(EntitlementClaimSchema, {
					bucketId: "account-free",
					unit: "runner-ms",
					units: 50,
				}),
			],
		});
		expect(authority.read(NOW).entitlements[0]).toMatchObject({
			remainingUnits: 50,
			reservedUnits: 0,
		});
		expect(() => authority.reserve(input(authority, "b", free))).toThrow(
			"entitlement exhausted",
		);
	});
	it("enforces provider-account ceilings independently of the parent budget", () => {
		const initial = snapshot(1000);
		initial.providerAccounts = [
			create(BudgetProviderAccountSchema, {
				providerAccountId: "aws-account",
				limitMicros: 70,
			}),
		];
		const authority = createBudgetAdmissionAuthority({ snapshot: initial });
		const scoped = quote("scoped", 30, 40);
		scoped.providerAccounts = [
			create(ProviderAccountExposureSchema, {
				providerAccountId: "aws-account",
				liabilityMicros: 40,
			}),
		];
		authority.reserve(input(authority, "a", scoped));
		expect(() => authority.reserve(input(authority, "b", scoped))).toThrow(
			"provider-account budget",
		);
		expect(() =>
			authority.reserve(input(authority, "unscoped", quote())),
		).toThrow("exposure evidence required");
		expect(authority.read(NOW).reservedMicros).toBe(40);
		authority.settle("a", 20, {
			usageEvidenceRef: "usage",
			sourceStoppedEvidenceRef: "stopped",
			providerAccounts: [
				create(ProviderAccountExposureSchema, {
					providerAccountId: "aws-account",
					liabilityMicros: 20,
				}),
			],
		});
		expect(authority.read(NOW).providerAccounts[0]).toMatchObject({
			spentMicros: 20,
			reservedMicros: 0,
		});
	});
	it("protects recovery reserves and unresolved external charges from every caller", () => {
		const initial = snapshot(100);
		initial.unresolvedMicros = 30;
		initial.recoveryReserveMicros = 30;
		const authority = createBudgetAdmissionAuthority({ snapshot: initial });
		expect(() => authority.reserve(input(authority))).toThrow(
			"budget exhausted",
		);
		const next = snapshot(100);
		next.recoveryReserveMicros = 30;
		expect(() => authority.configure(next, 0, NOW)).toThrow(
			"requires evidence",
		);
		authority.configure(next, 0, NOW, {
			liabilityResolutionEvidenceRef: "provider:no-charge-confirmed",
		});
		expect(authority.reserve(input(authority)).reservedMicros).toBe(60);
	});
});

describe("Yard-first economic gate", () => {
	it("selects the affordable whole-request quote and pins admission before receipt", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-yard-budget-"));
		const authority = createSqliteBudgetAdmissionAuthority({
			path: join(directory, "budget.sqlite"),
			snapshot: snapshot(100),
			now: () => NOW,
		});
		try {
			const request = buildDeploymentRequestFromParts({
				bindleName: "shop",
				ownerTenantId: "tenant",
				providerId: LOCAL_HOST_PROVIDER_ID,
				resources: [
					{ resourceId: "api", port: "hobo:http-service", features: [] },
				],
			});
			const a = localYardInstance({
				yardId: "yard:a",
				ownerTenantId: "tenant",
				providerId: LOCAL_HOST_PROVIDER_ID,
			});
			const b = localYardInstance({
				yardId: "yard:b",
				ownerTenantId: "tenant",
				providerId: LOCAL_HOST_PROVIDER_ID,
			});
			const quotes = [quote("expensive", 80, 110), quote("affordable", 30, 40)];
			for (let index = 0; index < quotes.length; index++) {
				const q = quotes[index];
				if (!q) throw new Error("fixture");
				q.yardId = index === 0 ? "yard:a" : "yard:b";
				q.providerId = LOCAL_HOST_PROVIDER_ID;
				q.requestDigest = contentHashOf(request);
			}
			const deps = {
				brokerId: "broker",
				catalog: createLocalHostCatalog(),
				seedLocalYard: false,
				priorEvents: [a, b].flatMap((yard) => [
					yardEvent(YARD_EVENTS.Registered, { yard }),
					yardEvent(YARD_EVENTS.Ready, { yardId: yard.yardId }),
				]),
				hostingBudget: { authority, quotes, now: () => NOW },
			};
			const noPolicy = await resolveBindleDeployment(request, deps);
			expect(noPolicy.outcome).toBe("rejected");
			expect(authority.read(NOW).reservedMicros).toBe(0);
			const result = await resolveBindleDeployment(request, {
				...deps,
				authorizeHosting: allowHosting,
			});
			expect(result.outcome).toBe("resolved");
			expect(result.receipt?.selectedYardId).toBe("yard:b");
			expect(result.receipt?.budgetReservation?.reservedMicros).toBe(40);
			expect(authority.read(NOW).reservedMicros).toBe(40);
			expect(
				result.placements.every(
					(placement) => placement.providerId === LOCAL_HOST_PROVIDER_ID,
				),
			).toBe(true);
			const blocked = await resolveBindleDeployment(
				{ ...request, requestId: "another" },
				{
					brokerId: "broker",
					catalog: createLocalHostCatalog(),
					seedLocalYard: false,
					priorEvents: result.events,
					hostingBudget: { authority, quotes: [], now: () => NOW },
				},
			);
			expect(blocked.outcome).toBe("rejected");
			expect(blocked.receipt).toBeUndefined();
		} finally {
			authority.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("does not fabricate a remote Yard from the local zero-config seed", async () => {
		const request = buildDeploymentRequestFromParts({
			bindleName: "shop",
			providerId: "aws",
			allowGeneration: false,
			resources: [],
		});
		const result = await resolveBindleDeployment(request, {
			brokerId: "broker",
			catalog: createLocalHostCatalog(),
		});
		expect(result.outcome).toBe("rejected");
		expect(Object.keys(result.foldState.yards)).toEqual([]);
	});
});

describe("live metered authorization", () => {
	it("does not turn unknown charges or regressed observations into headroom", () => {
		const billing = {
			quota: "deploy",
			quotaUsed: 0,
			quotaLimit: 100,
			budgetUsd: 100,
			spendCapUsd: 100,
		};
		let rows: { type: string; data: { costUsd?: number } }[] = [
			{ type: "meter.UsageRecorded", data: {} },
		];
		const plane = createMeteredBillingPlane(() => rows);
		expect(
			plane.authorize({ requestId: "unknown", spendEstimateUsd: 1, billing })
				.ok,
		).toBe(false);
		rows = [{ type: "meter.UsageRecorded", data: { costUsd: 50 } }];
		expect(
			plane.authorize({ requestId: "known", spendEstimateUsd: 1, billing }).ok,
		).toBe(true);
		rows = [];
		expect(
			plane.authorize({ requestId: "regressed", spendEstimateUsd: 1, billing })
				.ok,
		).toBe(false);
	});
	it("reads current spend and atomically holds outstanding authorizations", () => {
		const rows = [{ type: "meter.UsageRecorded", data: { costUsd: 30 } }];
		const billing = {
			quota: "deploy",
			quotaUsed: 0,
			quotaLimit: 100,
			budgetUsd: 100,
			spendCapUsd: 100,
		};
		const plane = createMeteredBillingPlane(() => rows);
		expect(
			plane.authorize({ requestId: "a", spendEstimateUsd: 50, billing }).ok,
		).toBe(true);
		expect(
			plane.authorize({ requestId: "b", spendEstimateUsd: 50, billing }).ok,
		).toBe(false);
		rows.push({ type: "meter.UsageRecorded", data: { costUsd: 25 } });
		expect(
			plane.authorize({ requestId: "c", spendEstimateUsd: 1, billing }).ok,
		).toBe(false);
	});
	it("zero budgets require an explicit unlimited mode", () => {
		const plane = createMeteredBillingPlane([]);
		const billing = {
			quota: "deploy",
			quotaUsed: 0,
			quotaLimit: 1,
			budgetUsd: 0,
			spendCapUsd: 0,
		};
		expect(
			plane.authorize({ requestId: "a", spendEstimateUsd: 1, billing }).ok,
		).toBe(false);
		expect(
			plane.authorize({
				requestId: "b",
				spendEstimateUsd: 1,
				billing: { ...billing, budgetUnlimited: true, spendCapUnlimited: true },
			}).ok,
		).toBe(true);
	});
});
