import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { clone, create } from "@bufbuild/protobuf";
import {
	BudgetLedgerSnapshotSchema,
	createPostgresBudgetAdmissionAuthority,
	HostingQuoteSchema,
	ProviderAccountExposureSchema,
} from "@hobo/broker";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConfigurationSchema,
	JobSchema,
	type Lease,
	OfferSchema,
} from "../src/_generated/ci_pb.js";
import { parseConfiguration } from "../src/config.js";
import { PostgresCiStore } from "../src/postgres-store.js";
import {
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
	createCiAsyncSharedBudgetHooks,
} from "../src/shared-budget.js";

const NOW = "2026-10-30T12:00:00Z";
const UNTIL = "2026-10-31T00:00:00Z";
const connectionURL = process.env.HOBO_TEST_POSTGRES_URL;
const pools: Pool[] = [];
afterEach(async () => {
	await Promise.all(pools.splice(0).map((pool) => pool.end()));
});
function pool() {
	const result = new Pool({ connectionString: connectionURL, max: 5 });
	pools.push(result);
	return result;
}
async function configuration() {
	const config = parseConfiguration(
		await readFile(
			new URL(
				"../data-models/fixtures/valid/configuration.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const account = config.accounts[0];
	const offer = account?.offers[0];
	if (!account || !offer) throw new Error("fixture");
	account.budgetMicros = 300;
	account.maxRuntimeMinutes = 1;
	account.startupMinutes = 1;
	offer.enabled = true;
	offer.bridgeAcknowledged = true;
	offer.priceMicrosPerMinute = 100;
	offer.budgetMicros = 300;
	offer.concurrency = 10;
	offer.observedAt = NOW;
	offer.validUntil = UNTIL;
	return { config, account, offer };
}
function job(id = 1) {
	return create(JobSchema, {
		id,
		runId: 10,
		runAttempt: 1,
		repositoryId: 1,
		repository: "example/repository",
		installationId: 1,
		action: "queued",
	});
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
		financialPlanHash: ciFinancialPlanHash(lease),
		requestDigest: ciRequestDigest(lease),
		providerAccounts: [
			{
				providerAccountId: lease.providerAccountId,
				liabilityMicros: lease.reservedPaidMicros,
			},
		],
	});
}

/** Run against an isolated real PostgreSQL server; row locking is the subject of this lane. */
describe.skipIf(!connectionURL)(
	"PostgreSQL authoritative CI lease composition",
	() => {
		it.each([
			"running",
			"uncertain",
		] as const)("persists isolated retirement for %s without reclaiming or releasing its shared hold", async (state) => {
			const nativePool = pool();
			const budgetId = randomUUID();
			const { config, account, offer } = await configuration();
			offer.provider = "hobo-box-worker";
			offer.backend = "isolated-container";
			offer.runsOn = "hobo-isolated-worker";
			offer.priceMicrosPerMinute = 0;
			offer.freeMinutes = 0;
			offer.budgetMicros = 0;
			account.budgetPolicy = {
				schemaVersion: "hobo.budget-policy/v1",
				tenantId: "tenant",
				budgetId,
				periodId: "p1",
				revision: "r1",
				workloads: ["hosting", "ci"],
				currency: "USD",
				limitMicros: 300,
				objective: "min-cost",
				enforcement: "conservative",
				periodKind: "manual",
				constraints: [],
			};
			const parent = createPostgresBudgetAdmissionAuthority({
				pool: nativePool,
				now: () => NOW,
				snapshot: create(BudgetLedgerSnapshotSchema, {
					identity: {
						tenantId: "tenant",
						budgetId,
						periodId: "p1",
						policyRevision: "r1",
					},
					limitMicros: 300,
					observedAt: NOW,
					validUntil: UNTIL,
					providerAccounts: [
						{ providerAccountId: offer.providerAccountId, limitMicros: 300 },
					],
				}),
			});
			const hooks = createCiAsyncSharedBudgetHooks({
				authority: parent,
				quoteLease,
				now: () => NOW,
			});
			const store = new PostgresCiStore(nativePool, randomUUID(), {
				sharedBudget: hooks,
			});
			await store.configure(config, 0, NOW);
			const demand = job();
			demand.isolatedRequired = true;
			demand.queueDeadlineAt = "2026-10-30T12:01:00Z";
			const lease = await store.reserve(account, demand, NOW);
			if (!lease) throw new Error("missing isolated lease");
			await store.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "running";
					entry.sandboxName = `hobo-${entry.id}`;
					entry.sandboxSessionId = "session-1";
					entry.sandboxStage = "running";
				},
				"ci.RunnerStarted",
				NOW,
			);
			if (state === "uncertain")
				await store.transition(
					lease.id,
					["running"],
					(entry) => {
						entry.state = "uncertain";
					},
					"ci.RunnerUncertain",
					NOW,
				);
			const hold = await parent.lookup(ciReservationId(lease));
			expect(hold?.status).toBe(state === "uncertain" ? "uncertain" : "held");
			vi.spyOn(hooks, "claim").mockRejectedValue(
				new Error("authority unavailable"),
			);
			vi.spyOn(hooks, "uncertain").mockRejectedValue(
				new Error("authority unavailable"),
			);
			const expired = demand.queueDeadlineAt;
			await expect(
				store.transition(
					lease.id,
					[state],
					(entry) => {
						entry.sandboxStage = "stopping";
						entry.runnerId = 99;
					},
					"ci.SandboxStopRequested",
					expired,
				),
			).rejects.toThrow();
			expect((await store.get(lease.id))?.sandboxStage).toBe("running");
			await store.transition(
				lease.id,
				[state],
				(entry) => {
					entry.sandboxStage = "stopping";
				},
				"ci.SandboxStopRequested",
				expired,
			);
			await store.transition(
				lease.id,
				[state],
				(entry) => {
					entry.sandboxStage = "stopped";
				},
				"ci.SandboxStopped",
				expired,
			);
			await store.transition(
				lease.id,
				[state],
				(entry) => {
					entry.usageCompletedAt = expired;
				},
				"ci.SandboxRemoved",
				expired,
			);
			expect(await store.get(lease.id)).toMatchObject({
				state,
				sandboxStage: "stopped",
				usageCompletedAt: expired,
			});
			expect(await parent.lookup(ciReservationId(lease))).toEqual(hold);
		});
		it.each([
			"kubernetes",
			"hobo-box-worker",
		])("retains a valid isolated %s reservation on redelivery", async (provider) => {
			const nativePool = pool();
			const { config, account, offer } = await configuration();
			offer.provider = provider;
			offer.backend = "isolated-container";
			offer.runsOn = "hobo-isolated-worker";
			offer.freeMinutes = 0;
			offer.priceMicrosPerMinute = 0;
			offer.budgetMicros = 0;
			const store = new PostgresCiStore(nativePool, randomUUID());
			await store.configure(config, 0, NOW);
			const demand = job();
			demand.isolatedRequired = true;
			const reserved = await store.reserve(account, demand, NOW);
			expect(reserved?.provider).toBe(provider);
			expect((await store.reserve(account, demand, NOW))?.id).toBe(
				reserved?.id,
			);
		});
		it("preserves an ineligible payer's cost measurements during runner admission and claim", async () => {
			const nativePool = pool();
			const budgetId = randomUUID();
			const { config, account, offer } = await configuration();
			const other = clone(OfferSchema, offer);
			other.id = "unbound-native";
			other.providerAccountId = "other-account";
			other.provider = "dagger";
			other.backend = "dagger";
			other.spentMicros = 50;
			account.offers.push(other);
			account.budgetPolicy = {
				schemaVersion: "hobo.budget-policy/v1",
				tenantId: "tenant",
				budgetId,
				periodId: "p1",
				revision: "r1",
				workloads: ["hosting", "ci"],
				currency: "USD",
				limitMicros: 300,
				objective: "min-cost",
				enforcement: "conservative",
				periodKind: "manual",
				constraints: [
					{
						key: "provider.cost",
						workload: "ci",
						unit: "USD.micros",
						target: "other-account",
						maximum: 50,
					},
				],
			};
			const parent = createPostgresBudgetAdmissionAuthority({
				pool: nativePool,
				now: () => NOW,
				snapshot: create(BudgetLedgerSnapshotSchema, {
					identity: {
						tenantId: "tenant",
						budgetId,
						periodId: "p1",
						policyRevision: "r1",
					},
					limitMicros: 300,
					observedAt: NOW,
					validUntil: UNTIL,
					providerAccounts: [
						{ providerAccountId: offer.providerAccountId, limitMicros: 300 },
						{ providerAccountId: "other-account", limitMicros: 300 },
					],
				}),
			});
			const store = new PostgresCiStore(nativePool, randomUUID(), {
				sharedBudget: createCiAsyncSharedBudgetHooks({
					authority: parent,
					quoteLease,
					now: () => NOW,
				}),
			});
			await store.configure(config, 0, NOW);
			const demand = job();
			demand.name = "test job";
			demand.memoryClass = "heavy";
			demand.memoryMb = 4096;
			const lease = await store.reserve(account, demand, NOW);
			if (!lease) throw new Error("legal multi-provider runner was refused");
			expect(lease).toMatchObject({
				offerId: offer.id,
				jobName: "test job",
				memoryClass: "heavy",
				memoryMb: 4096,
			});
			expect(
				await store.transition(
					lease.id,
					["reserved"],
					(entry) => {
						entry.state = "dispatching";
					},
					"ci.DispatchRequested",
					NOW,
				),
			).toMatchObject({ state: "dispatching", dispatchingAt: NOW });
			expect(
				(await parent.lookup(ciReservationId(lease)))?.executionDigest,
			).not.toBe("");
		});
		it.each([
			"bridge",
			"arc",
		])("retains an unclaimed shared hold when %s is revoked for isolation until trusted unused proof", async (kind) => {
			const nativePool = pool();
			const budgetId = randomUUID();
			const { config, account, offer } = await configuration();
			if (kind === "arc") {
				offer.provider = "kubernetes";
				offer.backend = "gh-actions";
				offer.runsOn = "arc-test";
			}
			account.budgetPolicy = {
				schemaVersion: "hobo.budget-policy/v1",
				tenantId: "tenant",
				budgetId,
				periodId: "p1",
				revision: "r1",
				workloads: ["hosting", "ci"],
				currency: "USD",
				limitMicros: 300,
				objective: "min-cost",
				enforcement: "conservative",
				periodKind: "manual",
				constraints: [],
			};
			const parent = createPostgresBudgetAdmissionAuthority({
				pool: nativePool,
				now: () => NOW,
				snapshot: create(BudgetLedgerSnapshotSchema, {
					identity: {
						tenantId: "tenant",
						budgetId,
						periodId: "p1",
						policyRevision: "r1",
					},
					limitMicros: 300,
					observedAt: NOW,
					validUntil: UNTIL,
					providerAccounts: [
						{ providerAccountId: offer.providerAccountId, limitMicros: 300 },
					],
				}),
			});
			let independentlyConfirmed = false;
			const store = new PostgresCiStore(nativePool, randomUUID(), {
				sharedBudget: createCiAsyncSharedBudgetHooks({
					authority: parent,
					quoteLease,
					now: () => NOW,
					verifyUnused: (lease, evidence) =>
						independentlyConfirmed && evidence === `unused:${lease.id}`,
				}),
			});
			await store.configure(config, 0, NOW);
			const demand = job();
			const lease = await store.reserve(account, demand, NOW);
			if (!lease) throw new Error("missing reserved runner");
			demand.isolatedRequired = true;
			expect(await store.reserve(account, demand, NOW)).toBeUndefined();
			expect((await store.get(lease.id))?.state).toBe("cancelled");
			expect(await parent.lookup(ciReservationId(lease))).toMatchObject({
				status: "held",
				reservedMicros: 200,
				executionDigest: "",
			});
			await expect(
				store.releaseUnusedSharedBudget(lease.id, `unused:${lease.id}`, NOW),
			).rejects.toThrow("durable cancelled-before-claim");
			expect((await parent.lookup(ciReservationId(lease)))?.status).toBe(
				"held",
			);
			independentlyConfirmed = true;
			await store.releaseUnusedSharedBudget(
				lease.id,
				`unused:${lease.id}`,
				NOW,
			);
			expect((await parent.lookup(ciReservationId(lease)))?.status).toBe(
				"released",
			);
		});
		it("serializes budget contention and rejects a stale caller after durable cap revocation", async () => {
			const partition = randomUUID();
			const first = new PostgresCiStore(pool(), partition);
			const second = new PostgresCiStore(pool(), partition);
			const { config, account } = await configuration();
			await first.configure(config, 0, NOW);
			const results = await Promise.all([
				first.reserve(account, job(1), NOW),
				second.reserve(account, job(2), NOW),
			]);
			expect(results.filter(Boolean)).toHaveLength(1);
			const changed = clone(ConfigurationSchema, config);
			const current = changed.accounts[0];
			if (!current) throw new Error("fixture");
			current.budgetMicros = 0;
			await second.configure(changed, 1, NOW);
			expect(await first.reserve(account, job(3), NOW)).toBeUndefined();
		});
		it("preserves removed native spending history across store recreation", async () => {
			const partition = randomUUID();
			const first = new PostgresCiStore(pool(), partition);
			const { config, account, offer } = await configuration();
			account.spentMicros = 100;
			account.usageObservedAt = NOW;
			offer.spentMicros = 100;
			await first.configure(config, 0, NOW);
			const removed = clone(ConfigurationSchema, config);
			const current = removed.accounts[0];
			if (!current) throw new Error("fixture");
			current.offers = [];
			await first.configure(removed, 1, NOW);
			const reopened = new PostgresCiStore(pool(), partition);
			await expect(reopened.configure(config, 2, NOW)).rejects.toThrow(
				"revival",
			);
			offer.observedAt = "2026-10-30T12:01:00Z";
			offer.spentMicros = 0;
			await expect(
				reopened.configure(config, 2, offer.observedAt),
			).rejects.toThrow("watermark");
		});
		it("expires only reserved jobs and preserves started holds after deadline", async () => {
			const s = new PostgresCiStore(pool(), randomUUID());
			const { config, account } = await configuration();
			await s.configure(config, 0, NOW);
			const queued = job();
			queued.queueDeadlineAt = "2026-10-30T12:01:00Z";
			await s.queue(queued, NOW);
			const lease = await s.reserve(account, queued, NOW);
			if (!lease) throw new Error("missing lease");
			expect(await s.expireQueued(queued, queued.queueDeadlineAt)).toBe(true);
			expect((await s.get(lease.id))?.state).toBe("cancelled");
			const active = job(2);
			active.queueDeadlineAt = queued.queueDeadlineAt;
			const held = await s.reserve(account, active, NOW);
			if (!held) throw new Error("missing lease");
			await s.transition(
				held.id,
				["reserved"],
				(entry) => {
					entry.state = "dispatching";
				},
				"ci.HostDispatching",
				NOW,
			);
			expect(await s.expireQueued(active, queued.queueDeadlineAt)).toBe(false);
			expect((await s.get(held.id))?.state).toBe("dispatching");
		});
		it("uses the real parent authority, retains estimates, and reconciles actual final overspend", async () => {
			const nativePool = pool();
			const budgetId = randomUUID();
			const { config, account, offer } = await configuration();
			account.budgetPolicy = {
				schemaVersion: "hobo.budget-policy/v1",
				tenantId: "tenant",
				budgetId,
				periodId: "p1",
				revision: "r1",
				workloads: ["hosting", "ci"],
				currency: "USD",
				limitMicros: 300,
				objective: "min-cost",
				enforcement: "conservative",
				periodKind: "manual",
				constraints: [],
			};
			const parent = createPostgresBudgetAdmissionAuthority({
				pool: nativePool,
				now: () => NOW,
				snapshot: create(BudgetLedgerSnapshotSchema, {
					identity: {
						tenantId: "tenant",
						budgetId,
						periodId: "p1",
						policyRevision: "r1",
					},
					limitMicros: 300,
					observedAt: NOW,
					validUntil: UNTIL,
					providerAccounts: [
						{ providerAccountId: offer.providerAccountId, limitMicros: 300 },
					],
				}),
			});
			const hooks = createCiAsyncSharedBudgetHooks({
				authority: parent,
				quoteLease,
				mode: "conservative",
				now: () => NOW,
				verifyFinalUsage: (_lease, evidence) =>
					evidence.usageEvidenceRef === "native:invoice:1" &&
					evidence.sourceStoppedEvidenceRef === "native:stopped:1",
			});
			const s = new PostgresCiStore(nativePool, randomUUID(), {
				sharedBudget: hooks,
			});
			await s.configure(config, 0, NOW);
			const lease = await s.reserve(account, job(), NOW);
			if (!lease) throw new Error("missing lease");
			expect((await parent.read(NOW)).reservedMicros).toBe(200);
			await s.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "dispatching";
				},
				"ci.HostDispatching",
				NOW,
			);
			expect(await s.settle(lease.id, 99, 1, NOW)).toMatchObject({
				state: "uncertain",
				usageProvenance: "estimated",
			});
			expect((await parent.read(NOW)).reservedMicros).toBe(200);
			const evidence = {
				usageEvidenceRef: "native:invoice:1",
				sourceStoppedEvidenceRef: "native:stopped:1",
				providerAccounts: [
					create(ProviderAccountExposureSchema, {
						providerAccountId: offer.providerAccountId,
						liabilityMicros: 250,
					}),
				],
			};
			expect(
				await s.reconcileSharedBudget(lease.id, 250, evidence, NOW),
			).toMatchObject({
				state: "completed",
				paidMicros: 250,
				usageProvenance: "provider-final",
			});
			expect(await parent.read(NOW)).toMatchObject({
				reservedMicros: 0,
				spentMicros: 250,
			});
			expect(
				(await s.events()).filter((event) => event.type === "ci.BudgetOverrun"),
			).toHaveLength(1);
			await s.reconcileSharedBudget(lease.id, 250, evidence, NOW);
			expect(
				(await s.events()).filter((event) => event.type === "ci.BudgetOverrun"),
			).toHaveLength(1);
		});
		it("persists positive unused parent release before allowing period rollover", async () => {
			const nativePool = pool();
			const budgetId = randomUUID();
			const partition = randomUUID();
			const { config, account, offer } = await configuration();
			account.budgetPolicy = {
				schemaVersion: "hobo.budget-policy/v1",
				tenantId: "tenant",
				budgetId,
				periodId: "p1",
				revision: "r1",
				workloads: ["hosting", "ci"],
				currency: "USD",
				limitMicros: 300,
				objective: "min-cost",
				enforcement: "conservative",
				periodKind: "manual",
				constraints: [],
			};
			const parent = createPostgresBudgetAdmissionAuthority({
				pool: nativePool,
				now: () => NOW,
				snapshot: create(BudgetLedgerSnapshotSchema, {
					identity: {
						tenantId: "tenant",
						budgetId,
						periodId: "p1",
						policyRevision: "r1",
					},
					limitMicros: 300,
					observedAt: NOW,
					validUntil: UNTIL,
					providerAccounts: [
						{ providerAccountId: offer.providerAccountId, limitMicros: 300 },
					],
				}),
			});
			const hooks = createCiAsyncSharedBudgetHooks({
				authority: parent,
				quoteLease,
				mode: "conservative",
				now: () => NOW,
				verifyUnused: (lease, evidenceRef) =>
					lease.state === "cancelled" && evidenceRef === `unused:${lease.id}`,
			});
			const s = new PostgresCiStore(nativePool, partition, {
				sharedBudget: hooks,
			});
			await s.configure(config, 0, NOW);
			const lease = await s.reserve(account, job(), NOW);
			if (!lease) throw new Error("missing lease");
			await s.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "cancelled";
				},
				"ci.LeaseCancelled",
				NOW,
			);
			const next = clone(ConfigurationSchema, config);
			const nextPolicy = next.accounts[0]?.budgetPolicy;
			if (!nextPolicy) throw new Error("fixture");
			nextPolicy.periodId = "p2";
			nextPolicy.revision = "r2";
			await expect(s.configure(next, 1, NOW)).rejects.toThrow(
				"liabilities remain active",
			);
			await s.releaseUnusedSharedBudget(lease.id, `unused:${lease.id}`, NOW);
			expect((await s.get(lease.id))?.budgetReleaseEvidenceRef).toContain(
				`ci-parent-release:${ciReservationId(lease)}:`,
			);
			await s.configure(next, 1, NOW);
			const reopened = new PostgresCiStore(pool(), partition, {
				sharedBudget: hooks,
			});
			expect(
				(await reopened.get(lease.id))?.budgetReleaseEvidenceRef,
			).toContain("ci-parent-release:");
			await reopened.configure(next, 2, NOW);
		});
		it("keeps demand queued after hosting consumes shared headroom and reuses the same intent when funding returns", async () => {
			const nativePool = pool();
			const budgetId = randomUUID();
			const { config, account, offer } = await configuration();
			account.budgetPolicy = {
				schemaVersion: "hobo.budget-policy/v1",
				tenantId: "tenant",
				budgetId,
				periodId: "p1",
				revision: "r1",
				workloads: ["hosting", "ci"],
				currency: "USD",
				limitMicros: 300,
				objective: "min-cost",
				enforcement: "conservative",
				periodKind: "manual",
				constraints: [],
			};
			const parent = createPostgresBudgetAdmissionAuthority({
				pool: nativePool,
				now: () => NOW,
				snapshot: create(BudgetLedgerSnapshotSchema, {
					identity: {
						tenantId: "tenant",
						budgetId,
						periodId: "p1",
						policyRevision: "r1",
					},
					limitMicros: 300,
					observedAt: NOW,
					validUntil: UNTIL,
					providerAccounts: [
						{ providerAccountId: offer.providerAccountId, limitMicros: 300 },
					],
				}),
			});
			const snapshot = await parent.read(NOW);
			if (!snapshot.identity) throw new Error("fixture");
			await parent.reserve({
				reservationId: "hosting:headroom",
				requestDigest: "hosting:request",
				identity: snapshot.identity,
				expectedSeq: snapshot.seq,
				now: NOW,
				quote: create(HostingQuoteSchema, {
					quoteId: "hosting:quote",
					yardId: "hosting",
					providerId: offer.provider,
					ownerTenantId: "tenant",
					currency: "USD",
					totalMicros: 200,
					liabilityBoundMicros: 200,
					observedAt: NOW,
					validUntil: UNTIL,
					requestDigest: "hosting:request",
					components: [{ name: "hosting-liability", costMicros: 200 }],
					providerAccounts: [
						{
							providerAccountId: offer.providerAccountId,
							liabilityMicros: 200,
						},
					],
				}),
			});
			const attempts: Lease[] = [];
			const hooks = createCiAsyncSharedBudgetHooks({
				authority: parent,
				quoteLease: (lease) => {
					attempts.push(lease);
					return quoteLease(lease);
				},
				mode: "conservative",
				now: () => NOW,
			});
			const s = new PostgresCiStore(nativePool, randomUUID(), {
				sharedBudget: hooks,
			});
			await s.configure(config, 0, NOW);
			const demand = job();
			await s.queue(demand, NOW);
			expect(await s.reserve(account, demand, NOW)).toBeUndefined();
			expect(await s.all()).toEqual([]);
			expect((await s.pendingJobs()).map((entry) => entry.id)).toEqual([1]);
			expect((await parent.read(NOW)).reservedMicros).toBe(200);
			await parent.release(
				"hosting:headroom",
				true,
				"native:hosting-never-started",
			);
			const admitted = await s.reserve(account, demand, NOW);
			expect(admitted).toMatchObject({
				budgetAdmissionAttempt: 1,
				reservedPaidMicros: 200,
				state: "reserved",
			});
			const deniedAttempt = attempts[0];
			if (!admitted || !deniedAttempt)
				throw new Error("missing attempted intent");
			expect(ciReservationId(admitted)).toBe(ciReservationId(deniedAttempt));
			expect((await s.reserve(account, demand, NOW))?.id).toBe(admitted.id);
			expect(await s.all()).toHaveLength(1);
			expect(await s.pendingJobs()).toEqual([]);
			expect((await parent.read(NOW)).reservedMicros).toBe(200);
		});
	},
);
