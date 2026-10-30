import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clone, create } from "@bufbuild/protobuf";
import {
	BudgetLedgerSnapshotSchema,
	createSqliteBudgetAdmissionAuthority,
	HostingQuoteSchema,
	ProviderAccountExposureSchema,
} from "@hobo/broker";
import { afterEach, describe, expect, it } from "vitest";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	JobSchema,
	type Lease,
	OfferSchema,
} from "../src/_generated/ci_pb.js";
import { parsePipeline } from "../src/execution.js";
import {
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
	createCiSharedBudgetHooks,
} from "../src/shared-budget.js";
import { LeaseStore } from "../src/store.js";

const NOW = "2026-10-30T12:00:00Z";
const UNTIL = "2026-10-31T00:00:00Z";
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
function setup(enforcement: "strict" | "conservative" = "conservative") {
	const directory = mkdtempSync(join(tmpdir(), "hobo-ci-store-parent-"));
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
	const parent = createSqliteBudgetAdmissionAuthority({
		path: join(directory, "parent.sqlite"),
		now: () => NOW,
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant",
				budgetId: "shared",
				periodId: "p1",
				policyRevision: "r1",
			},
			limitMicros: 300,
			observedAt: NOW,
			validUntil: UNTIL,
			providerAccounts: [
				{ providerAccountId: "owned", limitMicros: 300 },
				{ providerAccountId: "owned-b", limitMicros: 300 },
			],
		}),
	});
	cleanup.push(() => parent.close());
	const account = create(AccountSchema, {
		id: "ci",
		budgetMicros: 300,
		maxRuntimeMinutes: 1,
		startupMinutes: 1,
		budgetPolicy: {
			schemaVersion: "hobo.budget-policy/v1",
			tenantId: "tenant",
			budgetId: "shared",
			periodId: "p1",
			revision: "r1",
			workloads: ["hosting", "ci"],
			currency: "USD",
			limitMicros: 300,
			objective: "min-cost",
			enforcement,
			periodKind: "manual",
			constraints: [
				{ key: "work.concurrent", workload: "ci", unit: "count", maximum: 10 },
				{ key: "ci.attempts", workload: "ci", unit: "count", maximum: 3 },
				{
					key: "ci.queue.duration",
					workload: "ci",
					unit: "ms",
					maximum: 60000,
				},
				{ key: "work.duration", workload: "ci", unit: "ms", maximum: 120000 },
			],
		},
		offers: [
			create(OfferSchema, {
				id: "native",
				provider: "github",
				providerAccountId: "owned",
				budgetMicros: 300,
				priceMicrosPerMinute: 100,
				concurrency: 10,
				enabled: true,
				bridgeAcknowledged: true,
				runsOn: "ubuntu-24.04",
				observedAt: NOW,
				validUntil: UNTIL,
				sourceUrl: "https://example.test/usage",
			}),
		],
	});
	const config = create(ConfigurationSchema, { accounts: [account] });
	const pipeline = parsePipeline(
		JSON.stringify({
			id: "build",
			accountId: "ci",
			timeoutSeconds: 30,
			steps: [{ id: "test", argv: ["true"] }],
		}),
	);
	return { directory, parent, account, config, pipeline };
}
function quoteLease(lease: Lease) {
	return create(HostingQuoteSchema, {
		quoteId: `quote:${ciReservationId(lease)}`,
		yardId: `ci:${lease.accountId}`,
		providerId: lease.provider,
		ownerTenantId: lease.budgetTenantId,
		currency: "USD",
		totalMicros: lease.reservedPaidMicros,
		liabilityBoundMicros: lease.reservedPaidMicros,
		observedAt: NOW,
		validUntil: UNTIL,
		components: [
			{ name: "full-native-exposure", costMicros: lease.reservedPaidMicros },
		],
		requestDigest: ciRequestDigest(lease),
		financialPlanHash: ciFinancialPlanHash(lease),
		providerAccounts: [
			{
				providerAccountId: lease.providerAccountId,
				liabilityMicros: lease.reservedPaidMicros,
			},
		],
	});
}

describe("real SQLite CI and parent authority composition", () => {
	it.each([
		"before-open",
		"native-mutation",
	] as const)("rejects %s authorization at the persisted queue deadline while retaining the claimed hold", (phase) => {
		const h = setup();
		const hooks = createCiSharedBudgetHooks({
			authority: h.parent,
			quoteLease,
			now: () => NOW,
		});
		const store = new LeaseStore(":memory:", undefined, {
			sharedBudget: hooks,
		});
		cleanup.push(() => store.close());
		store.configure(h.config, 0, NOW);
		const lease = store.reservePipeline(
			h.account,
			h.pipeline,
			"digest",
			["native"],
			NOW,
		);
		if (!lease) throw new Error("missing lease");
		store.transition(
			lease.id,
			["reserved"],
			(entry) => {
				entry.state = "running";
			},
			"ci.PipelineStarted",
			NOW,
		);
		expect(lease.queueDeadlineAt).toBe("2026-10-30T12:01:00.000Z");
		expect(
			store.authorizePipelineStart(
				lease.id,
				h.account,
				h.pipeline,
				lease.queueDeadlineAt,
				phase,
			),
		).toBe(false);
		expect(h.parent.lookup(ciReservationId(lease))).toMatchObject({
			status: phase === "native-mutation" ? "uncertain" : "held",
			reservedMicros: 200,
		});
		expect(h.parent.lookup(ciReservationId(lease))?.executionDigest).not.toBe(
			"",
		);
	});
	it.each([
		50, 51,
	])("retains an ineligible payer's all-of cost guard (spent=%s) through pipeline admission and claim", (spent) => {
		const h = setup();
		const original = h.account.offers[0];
		if (!original) throw new Error("missing fixture offer");
		const other = clone(OfferSchema, original);
		other.id = "unbound";
		other.providerAccountId = "owned-b";
		other.spentMicros = spent;
		h.account.offers.push(other);
		h.account.budgetPolicy = {
			...h.account.budgetPolicy,
			constraints: [
				{
					key: "provider.cost",
					workload: "ci",
					unit: "USD.micros",
					target: "owned-b",
					maximum: 50,
				},
			],
		};
		const store = new LeaseStore(":memory:", undefined, {
			sharedBudget: createCiSharedBudgetHooks({
				authority: h.parent,
				quoteLease,
				now: () => NOW,
			}),
		});
		cleanup.push(() => store.close());
		store.configure(h.config, 0, NOW);
		const lease = store.reservePipeline(
			h.account,
			h.pipeline,
			"digest",
			["native"],
			NOW,
		);
		if (spent > 50) {
			expect(lease).toBeUndefined();
			expect(h.parent.read(NOW).reservedMicros).toBe(0);
			return;
		}
		if (!lease) throw new Error("legal multi-provider reservation was refused");
		expect(lease.offerId).toBe("native");
		expect(
			store.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "running";
				},
				"ci.PipelineStarted",
				NOW,
			)?.state,
		).toBe("running");
		expect(
			store.authorizePipelineStart(
				lease.id,
				h.account,
				h.pipeline,
				NOW,
				"native-mutation",
			),
		).toBe(true);
		expect(h.parent.lookup(ciReservationId(lease))?.executionDigest).not.toBe(
			"",
		);
	});
	it.each([
		"pipeline",
		"runner",
	])("queues %s demand when hosting exhausts the parent, then admits the same intent after proven release", (kind) => {
		const h = setup();
		h.config.connections = [
			create(ConnectionSchema, {
				accountId: h.account.id,
				repository: "example/repository",
				repositoryId: 1,
				installationId: 1,
				bridgeWorkflow: "hobo-ci-host.yml",
				bridgeRef: "hobo-ci-v1",
				bridgeSha: "0".repeat(40),
				dispatcherActorId: 1,
				runnerGroupId: 1,
				allowedEvents: ["push"],
				allowedRefs: ["refs/heads/main"],
				trustedRepositoryAcknowledged: true,
			}),
		];
		const snapshot = h.parent.read(NOW);
		if (!snapshot.identity) throw new Error("fixture");
		h.parent.reserve({
			reservationId: "hosting:headroom",
			requestDigest: "hosting:request",
			identity: snapshot.identity,
			expectedSeq: snapshot.seq,
			now: NOW,
			quote: create(HostingQuoteSchema, {
				quoteId: "hosting:quote",
				yardId: "hosting",
				providerId: "github",
				ownerTenantId: "tenant",
				currency: "USD",
				totalMicros: 200,
				liabilityBoundMicros: 200,
				observedAt: NOW,
				validUntil: UNTIL,
				requestDigest: "hosting:request",
				components: [{ name: "hosting-liability", costMicros: 200 }],
				providerAccounts: [
					{ providerAccountId: "owned", liabilityMicros: 200 },
				],
			}),
		});
		const attempts: Lease[] = [];
		const hooks = createCiSharedBudgetHooks({
			authority: h.parent,
			quoteLease: (lease) => {
				attempts.push(lease);
				return quoteLease(lease);
			},
			mode: "conservative",
			now: () => NOW,
		});
		const store = new LeaseStore(":memory:", undefined, {
			sharedBudget: hooks,
		});
		cleanup.push(() => store.close());
		store.configure(h.config, 0, NOW);
		const demand = create(JobSchema, {
			id: 1,
			runId: 10,
			runAttempt: 1,
			repositoryId: 1,
			repository: "example/repository",
			installationId: 1,
			action: "queued",
			name: "test job",
			memoryClass: "heavy",
			memoryMb: 4096,
		});
		if (kind === "runner") store.queue(demand, NOW);
		const reserve = () =>
			kind === "pipeline"
				? store.reservePipeline(
						h.account,
						h.pipeline,
						"digest",
						["native"],
						NOW,
					)
				: store.reserve(h.account, demand, NOW);
		expect(reserve()).toBeUndefined();
		expect(store.all()).toEqual([]);
		expect(h.parent.read(NOW).reservedMicros).toBe(200);
		if (kind === "runner")
			expect(store.pendingJobs().map((job) => job.id)).toEqual([1]);
		h.parent.release("hosting:headroom", true, "native:hosting-never-started");
		const admitted = reserve();
		expect(admitted).toMatchObject({
			budgetAdmissionAttempt: 1,
			reservedPaidMicros: 200,
			state: "reserved",
		});
		const deniedAttempt = attempts[0];
		if (!admitted || !deniedAttempt)
			throw new Error("missing attempted intent");
		expect(ciReservationId(admitted)).toBe(ciReservationId(deniedAttempt));
		expect(h.parent.read(NOW).reservedMicros).toBe(200);
		expect(reserve()?.id).toBe(admitted.id);
		expect(store.all()).toHaveLength(1);
		if (kind === "runner") {
			expect(store.pendingJobs()).toEqual([]);
			expect(admitted).toMatchObject({
				jobName: "test job",
				memoryClass: "heavy",
				memoryMb: 4096,
			});
			expect(
				store.transition(
					admitted.id,
					["reserved"],
					(entry) => {
						entry.state = "dispatching";
					},
					"ci.DispatchRequested",
					NOW,
				),
			).toMatchObject({ state: "dispatching", dispatchingAt: NOW });
		}
	});
	it("refuses a common policy without a shared authority", () => {
		const h = setup();
		const store = new LeaseStore(":memory:");
		cleanup.push(() => store.close());
		store.configure(h.config, 0, NOW);
		expect(
			store.reservePipeline(h.account, h.pipeline, "digest", ["native"], NOW),
		).toBeUndefined();
		expect(store.all()).toEqual([]);
		expect(h.parent.read(NOW).reservedMicros).toBe(0);
	});
	it("refuses strict admission before either commit when hooks lack independently verified native bounds", () => {
		const h = setup("strict");
		const hooks = createCiSharedBudgetHooks({
			authority: h.parent,
			quoteLease,
			now: () => NOW,
		});
		const store = new LeaseStore(":memory:", undefined, {
			sharedBudget: hooks,
		});
		cleanup.push(() => store.close());
		store.configure(h.config, 0, NOW);
		expect(() =>
			store.reservePipeline(h.account, h.pipeline, "digest", ["native"], NOW),
		).toThrow("bound");
		expect(store.all()).toEqual([]);
		expect(h.parent.read(NOW).reservedMicros).toBe(0);
	});
	it("retains an orphan parent hold after local commit failure and reuses it on exact retry", () => {
		const h = setup();
		const database = new DatabaseSync(join(h.directory, "ci.sqlite"));
		const hooks = createCiSharedBudgetHooks({
			authority: h.parent,
			quoteLease,
			mode: "conservative",
			now: () => NOW,
		});
		const store = new LeaseStore(":memory:", database, { sharedBudget: hooks });
		cleanup.push(() => store.close());
		store.configure(h.config, 0, NOW);
		database.exec(
			"CREATE TRIGGER reject_lease BEFORE INSERT ON leases BEGIN SELECT RAISE(FAIL, 'injected CI commit failure'); END",
		);
		expect(() =>
			store.reservePipeline(h.account, h.pipeline, "digest", ["native"], NOW),
		).toThrow("injected CI commit failure");
		expect(store.all()).toEqual([]);
		expect(h.parent.read(NOW).reservedMicros).toBe(200);
		database.exec("DROP TRIGGER reject_lease");
		const lease = store.reservePipeline(
			h.account,
			h.pipeline,
			"digest",
			["native"],
			NOW,
		);
		expect(lease?.reservedPaidMicros).toBe(200);
		expect(lease?.budgetAdmissionAttempt).toBe(1);
		expect(h.parent.read(NOW).reservedMicros).toBe(200);
		expect(store.all()).toHaveLength(1);
	});
	it("funds a new admission generation after proven unused cancellation and provider repricing", () => {
		const h = setup();
		const database = new DatabaseSync(":memory:");
		const store = new LeaseStore(":memory:", database, {
			sharedBudget: createCiSharedBudgetHooks({
				authority: h.parent,
				quoteLease,
				mode: "conservative",
				now: () => NOW,
				verifyUnused: (lease, evidenceRef) =>
					evidenceRef === `unused:${lease.id}` &&
					store.get(lease.id)?.state === "cancelled" &&
					store
						.events()
						.some(
							(event) =>
								event.type === "ci.LeaseCancelled" &&
								event.leaseId === lease.id,
						),
			}),
		});
		cleanup.push(() => store.close());
		store.configure(h.config, 0, NOW);
		const first = store.reservePipeline(
			h.account,
			h.pipeline,
			"digest",
			["native"],
			NOW,
		);
		if (!first) throw new Error("missing first admission");
		store.transition(
			first.id,
			["reserved"],
			(entry) => {
				entry.state = "cancelled";
			},
			"ci.LeaseCancelled",
			NOW,
		);
		store.releaseUnusedSharedBudget(first.id, `unused:${first.id}`, NOW);
		expect(store.get(first.id)?.budgetReleaseEvidenceRef).toContain(
			`ci-parent-release:${ciReservationId(first)}:`,
		);
		expect(h.parent.read(NOW).reservedMicros).toBe(0);
		const current = h.config.accounts[0];
		const oldOffer = current?.offers[0];
		if (!current || !oldOffer) throw new Error("fixture");
		current.offers = [
			create(OfferSchema, {
				...oldOffer,
				id: "native-b",
				providerAccountId: "owned-b",
				priceMicrosPerMinute: 50,
			}),
		];
		store.configure(h.config, 1, NOW);
		const second = store.reservePipeline(
			h.account,
			h.pipeline,
			"digest",
			["native-b"],
			NOW,
		);
		expect(second).toMatchObject({
			budgetAdmissionAttempt: 2,
			providerAccountId: "owned-b",
			reservedPaidMicros: 100,
		});
		expect(h.parent.read(NOW).reservedMicros).toBe(100);
		if (!second) throw new Error("missing second admission");
		expect(ciReservationId(second)).not.toBe(ciReservationId(first));
	});
	it("re-evaluates the actual published liability instead of only the lower routing estimate", () => {
		const h = setup();
		if (!h.account.budgetPolicy) throw new Error("fixture");
		h.account.budgetPolicy.constraints = [
			{ key: "work.cost", workload: "ci", unit: "USD.micros", maximum: 250 },
		];
		const hooks = createCiSharedBudgetHooks({
			authority: h.parent,
			quoteLease: (lease) => {
				const quote = quoteLease(lease);
				quote.liabilityBoundMicros = 300;
				const payer = quote.providerAccounts[0];
				if (!payer) throw new Error("fixture");
				payer.liabilityMicros = 300;
				return quote;
			},
			mode: "conservative",
			now: () => NOW,
		});
		const store = new LeaseStore(":memory:", undefined, {
			sharedBudget: hooks,
		});
		cleanup.push(() => store.close());
		store.configure(h.config, 0, NOW);
		expect(
			store.reservePipeline(h.account, h.pipeline, "digest", ["native"], NOW),
		).toBeUndefined();
		expect(store.all()).toEqual([]);
		expect(h.parent.read(NOW).reservedMicros).toBe(0);
	});
	it("blocks fixed-window rollover until a cancelled parent hold has a positive persisted release receipt", () => {
		const h = setup();
		if (!h.account.budgetPolicy) throw new Error("fixture");
		h.account.budgetPolicy.periodKind = "fixed-window";
		h.account.budgetPolicy.periodStartsAtMs = Date.parse(NOW) - 3600000;
		h.account.budgetPolicy.periodEndsAtMs = Date.parse(NOW) + 3600000;
		let loseReleaseAck = true;
		const actual = createCiSharedBudgetHooks({
			authority: h.parent,
			quoteLease,
			mode: "conservative",
			now: () => NOW,
			verifyUnused: (lease, evidenceRef) =>
				evidenceRef === `unused:${lease.id}` &&
				store.get(lease.id)?.state === "cancelled",
		});
		const store = new LeaseStore(":memory:", undefined, {
			sharedBudget: {
				...actual,
				releaseUnused(lease, evidenceRef) {
					const receipt = actual.releaseUnused(lease, evidenceRef);
					if (loseReleaseAck)
						throw new Error("lost parent release acknowledgement");
					return receipt;
				},
			},
		});
		cleanup.push(() => store.close());
		store.configure(h.config, 0, NOW);
		const lease = store.reservePipeline(
			h.account,
			h.pipeline,
			"digest",
			["native"],
			NOW,
		);
		if (!lease) throw new Error("missing lease");
		const next = clone(ConfigurationSchema, h.config);
		const policy = next.accounts[0]?.budgetPolicy;
		if (!policy) throw new Error("fixture");
		policy.periodId = "p2";
		policy.revision = "r2";
		policy.periodStartsAtMs = Date.parse(NOW) + 3600000;
		policy.periodEndsAtMs = Date.parse(NOW) + 7200000;
		expect(() => store.configure(next, 1, NOW)).toThrow(
			"liabilities remain active",
		);
		store.transition(
			lease.id,
			["reserved"],
			(entry) => {
				entry.state = "cancelled";
			},
			"ci.LeaseCancelled",
			NOW,
		);
		expect(() => store.configure(next, 1, NOW)).toThrow(
			"liabilities remain active",
		);
		expect(() =>
			store.transition(
				lease.id,
				["cancelled"],
				(entry) => {
					entry.budgetReleaseEvidenceRef = "invented";
				},
				"ci.Forged",
				NOW,
			),
		).toThrow("immutable");
		expect(() =>
			store.releaseUnusedSharedBudget(lease.id, `unused:${lease.id}`, NOW),
		).toThrow("lost parent release acknowledgement");
		expect(h.parent.read(NOW).reservedMicros).toBe(0);
		expect(store.get(lease.id)?.budgetReleaseEvidenceRef).toBe("");
		expect(() => store.configure(next, 1, NOW)).toThrow(
			"liabilities remain active",
		);
		loseReleaseAck = false;
		store.releaseUnusedSharedBudget(lease.id, `unused:${lease.id}`, NOW);
		store.configure(next, 1, NOW);
		store.rebuild();
		expect(store.get(lease.id)?.budgetReleaseEvidenceRef).toContain(
			"ci-parent-release:",
		);
		store.configure(next, 2, NOW);
		const retired = clone(ConfigurationSchema, h.config);
		const oldPolicy = retired.accounts[0]?.budgetPolicy;
		if (!oldPolicy) throw new Error("fixture");
		oldPolicy.revision = "r3";
		expect(() => store.configure(retired, 3, NOW)).toThrow(
			"retired budget period",
		);
		const downgraded = clone(ConfigurationSchema, next);
		const current = downgraded.accounts[0];
		if (!current) throw new Error("fixture");
		current.budgetPolicy = undefined;
		expect(() => store.configure(downgraded, 3, NOW)).toThrow(
			"cannot be removed",
		);
	});
	it("propagates an unknown lost parent reservation acknowledgement and retains its orphan hold", () => {
		const h = setup();
		let loseAck = true;
		const actual = createCiSharedBudgetHooks({
			authority: h.parent,
			quoteLease,
			mode: "conservative",
			now: () => NOW,
		});
		const store = new LeaseStore(":memory:", undefined, {
			sharedBudget: {
				...actual,
				reserve(lease, measurements) {
					const receipt = actual.reserve(lease, measurements);
					if (loseAck)
						throw new Error("unknown parent reservation acknowledgement");
					return receipt;
				},
			},
		});
		cleanup.push(() => store.close());
		store.configure(h.config, 0, NOW);
		expect(() =>
			store.reservePipeline(h.account, h.pipeline, "digest", ["native"], NOW),
		).toThrow("unknown parent reservation acknowledgement");
		expect(store.all()).toEqual([]);
		expect(h.parent.read(NOW).reservedMicros).toBe(200);
		loseAck = false;
		expect(
			store.reservePipeline(h.account, h.pipeline, "digest", ["native"], NOW),
		).toMatchObject({ budgetAdmissionAttempt: 1, reservedPaidMicros: 200 });
		expect(h.parent.read(NOW).reservedMicros).toBe(200);
		expect(store.all()).toHaveLength(1);
	});
	it("reconciles a claimed parent orphan left reserved by claim acknowledgement expiry only with positive final usage", () => {
		const h = setup();
		let clock = NOW;
		const late = "2026-11-01T00:00:00Z";
		const authority = {
			...h.parent,
			claimExecution(input: Parameters<typeof h.parent.claimExecution>[0]) {
				const receipt = h.parent.claimExecution(input);
				clock = late;
				return receipt;
			},
		};
		const hooks = createCiSharedBudgetHooks({
			authority,
			quoteLease,
			mode: "conservative",
			now: () => clock,
			verifyFinalUsage: (lease, evidence) =>
				lease.paidMicros === 0 &&
				evidence.usageEvidenceRef === "native:invoice:zero" &&
				evidence.sourceStoppedEvidenceRef === "native:operation-terminal" &&
				evidence.providerAccounts?.length === 1 &&
				evidence.providerAccounts[0]?.providerAccountId === "owned" &&
				evidence.providerAccounts[0].liabilityMicros === 0,
		});
		const store = new LeaseStore(":memory:", undefined, {
			sharedBudget: hooks,
		});
		cleanup.push(() => store.close());
		store.configure(h.config, 0, NOW);
		const lease = store.reservePipeline(
			h.account,
			h.pipeline,
			"digest",
			["native"],
			NOW,
		);
		if (!lease) throw new Error("missing lease");
		let effects = 0;
		expect(() => {
			store.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "running";
				},
				"ci.PipelineStarted",
				NOW,
			);
			effects++;
		}).toThrow();
		expect(effects).toBe(0);
		expect(store.get(lease.id)?.state).toBe("reserved");
		expect(h.parent.lookup(ciReservationId(lease))?.executionDigest).not.toBe(
			"",
		);
		const evidence = {
			usageEvidenceRef: "native:invoice:zero",
			sourceStoppedEvidenceRef: "native:operation-terminal",
			providerAccounts: [
				create(ProviderAccountExposureSchema, {
					providerAccountId: "owned",
					liabilityMicros: 0,
				}),
			],
		};
		expect(() =>
			store.reconcileSharedBudget(
				lease.id,
				0,
				{ ...evidence, usageEvidenceRef: "wrong-proof" },
				late,
			),
		).toThrow("native final usage");
		expect(store.get(lease.id)?.state).toBe("reserved");
		expect(h.parent.read(late).reservedMicros).toBe(200);
		expect(
			store.reconcileSharedBudget(lease.id, 0, evidence, late),
		).toMatchObject({
			state: "completed",
			usageProvenance: "provider-final",
			paidMicros: 0,
		});
		expect(h.parent.lookup(ciReservationId(lease))).toMatchObject({
			status: "settled",
			actualMicros: 0,
		});
		expect(h.parent.read(late).reservedMicros).toBe(0);
		expect(
			store.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "running";
				},
				"ci.PipelineStarted",
				late,
			),
		).toBeUndefined();
	});
});
