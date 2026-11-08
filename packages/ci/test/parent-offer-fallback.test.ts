import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	type BudgetAdmissionAuthority,
	type BudgetLedgerSnapshot,
	BudgetLedgerSnapshotSchema,
	type BudgetReservation,
	createPostgresBudgetAdmissionAuthority,
	createSqliteBudgetAdmissionAuthority,
	HostingQuoteSchema,
} from "@hobo/broker";
import { Pool } from "pg";
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
import { PostgresCiStore } from "../src/postgres-store.js";
import {
	type AsyncBudgetAdmissionAuthority,
	type CiSharedBudgetOptions,
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
	createCiAsyncSharedBudgetHooks,
	createCiSharedBudgetHooks,
} from "../src/shared-budget.js";
import { LeaseStore } from "../src/store.js";

const NOW = "2026-10-30T12:00:00Z";
const UNTIL = "2026-10-31T00:00:00Z";
const connectionURL = process.env.HOBO_TEST_POSTGRES_URL;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

interface Scenario {
	attempts: Lease[];
	admit(): Promise<Lease | undefined>;
	all(): Promise<Lease[]>;
	reservedEvents(): Promise<number>;
	readParent(): Promise<BudgetLedgerSnapshot>;
	lookupParent(id: string): Promise<BudgetReservation | undefined>;
	reserveHosting(): Promise<void>;
	allowAcknowledgement(): void;
}
function fixture(remainingUnits: number) {
	const budgetId = randomUUID();
	const snapshot = create(BudgetLedgerSnapshotSchema, {
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
			{ providerAccountId: "owned-a", limitMicros: 300 },
			{ providerAccountId: "owned-b", limitMicros: 300 },
		],
		entitlements: [
			{
				bucketId: "native-minutes",
				unit: "micro-minutes",
				periodId: "p1",
				remainingUnits,
				observedAt: NOW,
				validUntil: UNTIL,
			},
		],
	});
	const first = create(OfferSchema, {
		id: "free-a",
		provider: "github",
		providerAccountId: "owned-a",
		budgetMicros: 300,
		freeMinutes: 2,
		priceMicrosPerMinute: 100,
		concurrency: 10,
		enabled: true,
		bridgeAcknowledged: true,
		runsOn: "ubuntu-24.04",
		observedAt: NOW,
		validUntil: UNTIL,
		sourceUrl: "https://example.test/native-usage",
	});
	const account = create(AccountSchema, {
		id: "ci",
		budgetMicros: 300,
		maxRuntimeMinutes: 1,
		startupMinutes: 1,
		budgetPolicy: {
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
					target: "owned-a",
					unit: "USD.micros",
					maximum: 300,
				},
			],
		},
		offers: [
			first,
			create(OfferSchema, {
				...first,
				id: "paid-b",
				providerAccountId: "owned-b",
				freeMinutes: 0,
			}),
		],
	});
	const config = create(ConfigurationSchema, {
		accounts: [account],
		connections: [
			create(ConnectionSchema, {
				accountId: "ci",
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
		],
	});
	const job = create(JobSchema, {
		id: 1,
		runId: 10,
		runAttempt: 1,
		repositoryId: 1,
		repository: "example/repository",
		installationId: 1,
		action: "queued",
	});
	const pipeline = parsePipeline(
		JSON.stringify({
			id: "build",
			accountId: "ci",
			timeoutSeconds: 30,
			steps: [{ id: "test", argv: ["true"] }],
		}),
	);
	return { snapshot, config, account, job, pipeline };
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
		requestDigest: ciRequestDigest(lease),
		financialPlanHash: ciFinancialPlanHash(lease),
		components: [
			{
				name: "complete-native-liability",
				costMicros: lease.reservedPaidMicros,
			},
		],
		providerAccounts: [
			{
				providerAccountId: lease.providerAccountId,
				liabilityMicros: lease.reservedPaidMicros,
			},
		],
		entitlementClaims: lease.reservedFreeMinutes
			? [
					{
						bucketId: "native-minutes",
						unit: "micro-minutes",
						units: lease.reservedFreeMinutes * 1000000,
					},
				]
			: [],
	});
}
const allocationCoverage: NonNullable<
	CiSharedBudgetOptions["verifyAllocationCoverage"]
> = (lease, quote, ledger) =>
	quote.entitlementClaims.length === 1 &&
	quote.entitlementClaims[0]?.bucketId === "native-minutes" &&
	quote.entitlementClaims[0].unit === "micro-minutes" &&
	quote.entitlementClaims[0].units === lease.reservedFreeMinutes * 1000000 &&
	ledger.entitlements.some(
		(bucket) =>
			bucket.bucketId === "native-minutes" &&
			bucket.unit === "micro-minutes" &&
			bucket.periodId === lease.budgetPeriodId,
	);

function parentControls(
	authority: BudgetAdmissionAuthority | AsyncBudgetAdmissionAuthority,
) {
	return {
		readParent: async () => authority.read(NOW),
		lookupParent: async (id: string) => authority.lookup(id),
		async reserveHosting() {
			const snapshot = await authority.read(NOW);
			if (!snapshot.identity) throw new Error("fixture");
			await authority.reserve({
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
					totalMicros: 250,
					liabilityBoundMicros: 250,
					observedAt: NOW,
					validUntil: UNTIL,
					requestDigest: "hosting:request",
					components: [{ name: "hosting-native-liability", costMicros: 250 }],
					providerAccounts: [
						{ providerAccountId: "owned-b", liabilityMicros: 250 },
					],
				}),
			});
		},
	};
}
async function sqliteScenario(
	pipeline: boolean,
	credits: number,
	loseAcknowledgement: boolean,
): Promise<Scenario> {
	const f = fixture(credits);
	const directory = await mkdtemp(join(tmpdir(), "hobo-ci-offer-fallback-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const parent = createSqliteBudgetAdmissionAuthority({
		path: join(directory, "parent.sqlite"),
		snapshot: f.snapshot,
		now: () => NOW,
	});
	cleanup.push(() => parent.close());
	const attempts: Lease[] = [];
	const actual = createCiSharedBudgetHooks({
		authority: parent,
		quoteLease: (lease) => {
			attempts.push(lease);
			return quoteLease(lease);
		},
		mode: "conservative",
		verifyAllocationCoverage: allocationCoverage,
		now: () => NOW,
	});
	const store = new LeaseStore(join(directory, "ci.sqlite"), undefined, {
		sharedBudget: {
			...actual,
			reserve(lease, measurements) {
				const receipt = actual.reserve(lease, measurements);
				if (loseAcknowledgement)
					throw new Error("unknown parent write acknowledgement");
				return receipt;
			},
		},
	});
	cleanup.push(() => store.close());
	store.configure(f.config, 0, NOW);
	if (!pipeline) store.queue(f.job, NOW);
	return {
		attempts,
		admit: async () =>
			pipeline
				? store.reservePipeline(
						f.account,
						f.pipeline,
						"digest",
						["free-a", "paid-b"],
						NOW,
					)
				: store.reserve(f.account, f.job, NOW),
		all: async () => store.all(),
		reservedEvents: async () =>
			store.events().filter((event) => event.type === "ci.LeaseReserved")
				.length,
		...parentControls(parent),
		allowAcknowledgement() {
			loseAcknowledgement = false;
		},
	};
}
async function postgresScenario(
	credits: number,
	loseAcknowledgement: boolean,
): Promise<Scenario> {
	const f = fixture(credits);
	const nativePool = new Pool({ connectionString: connectionURL, max: 5 });
	cleanup.push(() => nativePool.end());
	const parent = createPostgresBudgetAdmissionAuthority({
		pool: nativePool,
		snapshot: f.snapshot,
		now: () => NOW,
	});
	const attempts: Lease[] = [];
	const actual = createCiAsyncSharedBudgetHooks({
		authority: parent,
		quoteLease: (lease) => {
			attempts.push(lease);
			return quoteLease(lease);
		},
		mode: "conservative",
		verifyAllocationCoverage: allocationCoverage,
		now: () => NOW,
	});
	const store = new PostgresCiStore(nativePool, randomUUID(), {
		sharedBudget: {
			...actual,
			async reserve(lease, measurements) {
				const receipt = await actual.reserve(lease, measurements);
				if (loseAcknowledgement)
					throw new Error("unknown parent write acknowledgement");
				return receipt;
			},
		},
	});
	await store.configure(f.config, 0, NOW);
	await store.queue(f.job, NOW);
	return {
		attempts,
		admit: () => store.reserve(f.account, f.job, NOW),
		all: () => store.all(),
		reservedEvents: async () =>
			(await store.events()).filter(
				(event) => event.type === "ci.LeaseReserved",
			).length,
		...parentControls(parent),
		allowAcknowledgement() {
			loseAcknowledgement = false;
		},
	};
}
function acceptance(
	label: string,
	setup: (credits: number, loseAck: boolean) => Promise<Scenario>,
) {
	describe(label, () => {
		it("uses funded B after A's locally advertised free allocation is exhausted in the parent", async () => {
			const s = await setup(0, false);
			const lease = await s.admit();
			expect(lease).toMatchObject({
				offerId: "paid-b",
				providerAccountId: "owned-b",
				reservedPaidMicros: 200,
				budgetAdmissionAttempt: 1,
			});
			expect(s.attempts.map((entry) => entry.offerId)).toEqual([
				"free-a",
				"paid-b",
			]);
			expect(await s.all()).toHaveLength(1);
			expect(await s.reservedEvents()).toBe(1);
			expect((await s.readParent()).reservedMicros).toBe(200);
			if (!lease) throw new Error("missing lease");
			expect(
				(await s.lookupParent(ciReservationId(lease)))?.providerAccounts[0]
					?.providerAccountId,
			).toBe("owned-b");
		});
		it("queues after each eligible offer has a definitive denial without creating a lease or incrementing admission generation", async () => {
			const s = await setup(0, false);
			await s.reserveHosting();
			expect(await s.admit()).toBeUndefined();
			expect(s.attempts.map((entry) => entry.offerId)).toEqual([
				"free-a",
				"paid-b",
			]);
			expect(s.attempts.map((entry) => entry.budgetAdmissionAttempt)).toEqual([
				1, 1,
			]);
			expect(await s.all()).toEqual([]);
			expect(await s.reservedEvents()).toBe(0);
			expect((await s.readParent()).reservedMicros).toBe(250);
		});
		it("never tries B after an unknown A acknowledgement and adopts A's retained intent on exact retry", async () => {
			const s = await setup(2000000, true);
			await expect(s.admit()).rejects.toThrow(
				"unknown parent write acknowledgement",
			);
			expect(s.attempts.map((entry) => entry.offerId)).toEqual(["free-a"]);
			expect(await s.all()).toEqual([]);
			const attempted = s.attempts[0];
			if (!attempted) throw new Error("missing attempted intent");
			expect((await s.lookupParent(ciReservationId(attempted)))?.status).toBe(
				"held",
			);
			expect((await s.readParent()).entitlements[0]?.reservedUnits).toBe(
				2000000,
			);
			s.allowAcknowledgement();
			expect(await s.admit()).toMatchObject({
				offerId: "free-a",
				budgetAdmissionAttempt: 1,
			});
			expect(s.attempts.map((entry) => entry.offerId)).toEqual([
				"free-a",
				"free-a",
			]);
			expect(await s.all()).toHaveLength(1);
			expect(await s.reservedEvents()).toBe(1);
			expect((await s.readParent()).entitlements[0]?.reservedUnits).toBe(
				2000000,
			);
		});
	});
}
acceptance(
	"SQLite native pipeline parent-aware offer fallback",
	(credits, loseAck) => sqliteScenario(true, credits, loseAck),
);
acceptance("SQLite runner parent-aware offer fallback", (credits, loseAck) =>
	sqliteScenario(false, credits, loseAck),
);
describe.skipIf(!connectionURL)("real PostgreSQL", () =>
	acceptance("runner parent-aware offer fallback", postgresScenario),
);
