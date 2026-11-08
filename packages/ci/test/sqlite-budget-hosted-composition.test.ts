import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
	createCiSharedBudgetHooks,
} from "../src/shared-budget.js";
import { SqliteCiStore } from "../src/sqlite-store.js";

const NOW = "2026-10-30T12:00:00Z";
const UNTIL = "2026-10-31T00:00:00Z";
const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
function setup(withHooks = true, ownedLimit = 300) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-sqlite-parent-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const parent = createSqliteBudgetAdmissionAuthority({
		path: join(dir, "parent.sqlite"),
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
				{ providerAccountId: "owned", limitMicros: ownedLimit },
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
			enforcement: "conservative",
			periodKind: "manual",
			constraints: [
				{ key: "ci.attempts", workload: "ci", unit: "count", maximum: 3 },
				{
					key: "ci.queue.duration",
					workload: "ci",
					unit: "ms",
					maximum: 60000,
				},
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
	const config = create(ConfigurationSchema, {
		accounts: [account],
		connections: [
			create(ConnectionSchema, {
				accountId: "ci",
				repository: "Org/Repo",
				repositoryId: 101,
				installationId: 10,
				runnerGroupId: 1,
				bridgeWorkflow: "hobo-ci-host.yml",
				bridgeRef: "hobo-ci-v1",
				bridgeSha: "0".repeat(40),
				dispatcherActorId: 1,
				allowedEvents: ["push"],
				allowedRefs: ["refs/heads/main"],
				trustedRepositoryAcknowledged: true,
			}),
		],
	});
	const job = create(JobSchema, {
		id: 123,
		runId: 456,
		runAttempt: 1,
		repositoryId: 101,
		installationId: 10,
		repository: "Org/Repo",
		labels: ["hobo"],
		action: "queued",
	});
	const quoteLease = (lease: Lease) =>
		create(HostingQuoteSchema, {
			quoteId: `quote:${ciReservationId(lease)}`,
			yardId: `ci:${lease.accountId}`,
			providerId: lease.provider,
			ownerTenantId: lease.budgetTenantId,
			currency: "USD",
			totalMicros: lease.reservedPaidMicros,
			liabilityBoundMicros: lease.reservedPaidMicros,
			observedAt: NOW,
			validUntil: UNTIL,
			components: [{ name: "native", costMicros: lease.reservedPaidMicros }],
			requestDigest: ciRequestDigest(lease),
			financialPlanHash: ciFinancialPlanHash(lease),
			providerAccounts: [
				{
					providerAccountId: lease.providerAccountId,
					liabilityMicros: lease.reservedPaidMicros,
				},
			],
		});
	const hooks = createCiSharedBudgetHooks({
		authority: parent,
		quoteLease,
		now: () => NOW,
		verifyUnused: (_lease, proof) => proof === "verified-unused",
		verifyFinalUsage: (_lease, proof) =>
			proof.usageEvidenceRef === "final" &&
			proof.sourceStoppedEvidenceRef === "stopped",
	});
	const store = new SqliteCiStore(
		join(dir, "ci.sqlite"),
		withHooks ? { sharedBudget: hooks } : {},
	);
	cleanup.push(() => store.close());
	return { store, parent, account, config, job, dir };
}

describe("hosted SQLite store shared budget admission", () => {
	it("fails closed when common policy has no shared authority", async () => {
		const { store, account, config, job, parent } = setup(false);
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		expect(await store.reserve(account, job, NOW)).toBeUndefined();
		expect(parent.read(NOW).reservedMicros).toBe(0);
	});
	it("persists a hold, pins the deadline, and refuses dispatch at expiry", async () => {
		const { store, account, config, job, parent } = setup();
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		const lease = await store.reserve(account, job, NOW);
		if (!lease) throw new Error("missing lease");
		expect(lease).toMatchObject({
			budgetId: "shared",
			providerAccountId: "owned",
			reservedPaidMicros: 200,
			queueDeadlineAt: "2026-10-30T12:01:00.000Z",
		});
		expect(parent.read(NOW).reservedMicros).toBe(200);
		await expect(
			store.transition(
				lease.id,
				["reserved"],
				(x) => {
					x.state = "dispatching";
				},
				"ci.DispatchRequested",
				lease.queueDeadlineAt,
			),
		).rejects.toThrow();
		expect((await store.get(lease.id))?.state).toBe("reserved");
		expect(parent.read(NOW).reservedMicros).toBe(200);
	});
	it("claims before effects and keeps uncertain usage until verified settlement", async () => {
		const { store, account, config, job, parent } = setup();
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		const lease = await store.reserve(account, job, NOW);
		if (!lease) throw new Error("missing lease");
		await store.transition(
			lease.id,
			["reserved"],
			(x) => {
				x.state = "dispatching";
			},
			"ci.DispatchRequested",
			NOW,
		);
		expect((await store.settle(lease.id, 42, 1, NOW))?.state).toBe("uncertain");
		expect(parent.read(NOW).reservedMicros).toBe(200);
		await expect(
			store.reconcileSharedBudget(
				lease.id,
				100,
				{ usageEvidenceRef: "fake", sourceStoppedEvidenceRef: "stopped" },
				NOW,
			),
		).rejects.toThrow();
		expect(
			(
				await store.reconcileSharedBudget(
					lease.id,
					100,
					{
						usageEvidenceRef: "final",
						sourceStoppedEvidenceRef: "stopped",
						providerAccounts: [
							create(ProviderAccountExposureSchema, {
								providerAccountId: "owned",
								liabilityMicros: 100,
							}),
						],
					},
					NOW,
				)
			).state,
		).toBe("completed");
		expect(parent.read(NOW).reservedMicros).toBe(0);
	});
	it("releases a cancelled preclaim hold only with verified unused evidence", async () => {
		const { store, account, config, job, parent } = setup();
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		const lease = await store.reserve(account, job, NOW);
		if (!lease) throw new Error("missing lease");
		await store.cancelAndRequeue(lease.id, job, NOW);
		await expect(
			store.releaseUnusedSharedBudget(lease.id, "unverified", NOW),
		).rejects.toThrow();
		expect(parent.read(NOW).reservedMicros).toBe(200);
		await store.releaseUnusedSharedBudget(lease.id, "verified-unused", NOW);
		expect(parent.read(NOW).reservedMicros).toBe(0);
	});
	it("funds an isolated worker before its claim and keeps deadline and payer identity", async () => {
		const { store, account, config, job, parent } = setup();
		const box = account.offers[0];
		if (!box) throw new Error("fixture");
		box.id = "box";
		box.provider = "kubernetes";
		box.backend = "isolated-container";
		box.runsOn = "hobo-isolated-worker";
		box.priceMicrosPerMinute = 0;
		box.budgetMicros = 0;
		config.connections = [
			create(ConnectionSchema, {
				accountId: "ci",
				repository: "Org/Repo",
				repositoryId: 101,
				installationId: 10,
				runnerGroupId: 1,
				isolatedOnly: true,
				acceptAllMatchingRepositoryJobs: true,
				trustedRepositoryAcknowledged: true,
				publicRepositoryAcknowledged: true,
			}),
		];
		job.isolatedRequired = true;
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		const lease = await store.reserve(account, job, NOW);
		if (!lease) throw new Error("missing isolated lease");
		expect(lease).toMatchObject({
			provider: "kubernetes",
			providerAccountId: "owned",
			budgetId: "shared",
			queueDeadlineAt: "2026-10-30T12:01:00.000Z",
		});
		await store.transition(
			lease.id,
			["reserved"],
			(entry) => {
				entry.state = "dispatching";
			},
			"ci.DispatchRequested",
			NOW,
		);
		expect(parent.lookup(ciReservationId(lease))?.executionDigest).not.toBe("");
	});
	it("refuses a persisted shared reservation after restart without its authority", async () => {
		const { store, account, config, job, parent, dir } = setup();
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		const lease = await store.reserve(account, job, NOW);
		if (!lease) throw new Error("missing lease");
		const reopened = new SqliteCiStore(join(dir, "ci.sqlite"));
		cleanup.push(() => reopened.close());
		await expect(
			reopened.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "dispatching";
				},
				"ci.DispatchRequested",
				NOW,
			),
		).rejects.toThrow();
		expect(parent.read(NOW).reservedMicros).toBe(200);
	});
	it("falls back after definitive parent denial to a different funded provider account", async () => {
		const { store, account, config, job, parent } = setup(true, 0);
		const first = account.offers[0];
		if (!first) throw new Error("fixture");
		first.priceMicrosPerMinute = 50;
		const other = clone(OfferSchema, first);
		other.id = "other";
		other.providerAccountId = "owned-b";
		other.priceMicrosPerMinute = 100;
		account.offers.push(other);
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		const lease = await store.reserve(account, job, NOW);
		expect(lease).toMatchObject({
			offerId: "other",
			providerAccountId: "owned-b",
			reservedPaidMicros: 200,
		});
		expect(parent.read(NOW).reservedMicros).toBe(200);
	});
	it("keeps nonselected offer accounting context for provider-scoped policy controls", async () => {
		const { store, account, config, job } = setup();
		const first = account.offers[0];
		if (!first || !account.budgetPolicy) throw new Error("fixture");
		const other = clone(OfferSchema, first);
		other.id = "other";
		other.providerAccountId = "owned-b";
		other.spentMicros = 30;
		other.priceMicrosPerMinute = 120;
		account.offers.push(other);
		account.budgetPolicy.constraints.push({
			key: "provider.cost",
			workload: "ci",
			unit: "USD.micros",
			target: "owned-b",
			maximum: 50,
		});
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		const lease = await store.reserve(account, job, NOW);
		expect(lease?.offerId).toBe("native");
		if (!lease) throw new Error("missing lease");
		expect(
			(
				await store.transition(
					lease.id,
					["reserved"],
					(entry) => {
						entry.state = "dispatching";
					},
					"ci.DispatchRequested",
					NOW,
				)
			)?.state,
		).toBe("dispatching");
	});
	it("cancels a reserved ARC lease when isolation is newly required without releasing its hold", async () => {
		const { store, account, config, job, parent } = setup();
		const offer = account.offers[0];
		if (!offer) throw new Error("fixture");
		offer.provider = "kubernetes";
		offer.backend = "gh-actions";
		offer.runsOn = "arc-pool";
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		const lease = await store.reserve(account, job, NOW);
		if (!lease) throw new Error("missing ARC lease");
		job.isolatedRequired = true;
		expect(await store.reserve(account, job, NOW)).toBeUndefined();
		expect((await store.get(lease.id))?.state).toBe("cancelled");
		expect((await store.pendingJobs())[0]?.isolatedRequired).toBe(true);
		expect(parent.read(NOW).reservedMicros).toBe(200);
	});
});
