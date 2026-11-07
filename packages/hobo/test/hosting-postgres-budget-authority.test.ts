import { createHash, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	BudgetLedgerSnapshotSchema,
	createPostgresBudgetAdmissionAuthority,
	HostingQuoteSchema,
	ProviderAccountExposureSchema,
} from "@hobo/broker";
import {
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
	createCiAsyncSharedBudgetHooks,
	LeaseSchema,
} from "@hobo/ci";
import {
	createHostingPlanningPass,
	type HostingPlanningInput,
	type SharedHostingBudgetAuthority,
} from "@hobo/cloud";
import {
	canonicalBudgetPolicyJson,
	type JsonObject,
	parseBudgetPolicy,
} from "@hobo/core";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createHostingBudgetAuthorityBridge } from "../src/hosting-budget-authority.js";

const connectionString = process.env.HOBO_TEST_POSTGRES_URL;
const NOW = "2026-10-30T12:00:00.000Z";
const AT = Date.parse(NOW);
const END = AT + 3_600_000;
const UNTIL = new Date(AT + 86_400_000).toISOString();
const PLAN_HASH = `sha256:${"a".repeat(64)}`;
const pools: Pool[] = [];
afterEach(async () => {
	await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

async function fixture() {
	const budgetId = randomUUID();
	let clock = AT;
	const now = () => new Date(clock).toISOString();
	const applicationName = `hosting-bridge-test:${randomUUID()}`;
	const policy: JsonObject = {
		schemaVersion: "hobo.budget-policy/v1",
		tenantId: "tenant",
		budgetId,
		periodId: "period",
		revision: "r1",
		workloads: ["hosting", "ci"],
		currency: "USD",
		limitMicros: 100,
		objective: "min-cost",
		enforcement: "strict",
		periodKind: "manual",
		constraints: [],
	};
	const snapshot = create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "tenant",
			budgetId,
			periodId: "period",
			policyRevision: "r1",
		},
		limitMicros: 100,
		observedAt: NOW,
		validUntil: UNTIL,
		providerAccounts: [
			{ providerAccountId: "native:account", limitMicros: 100 },
		],
	});
	const hostPool = new Pool({
		connectionString,
		max: 2,
		application_name: applicationName,
	});
	const ciPool = new Pool({ connectionString, max: 2 });
	pools.push(hostPool, ciPool);
	const hostAuthority = createPostgresBudgetAdmissionAuthority({
		pool: hostPool,
		snapshot,
		now,
	});
	const ciAuthority = createPostgresBudgetAdmissionAuthority({
		pool: ciPool,
		snapshot,
		now,
	});
	await Promise.all([hostAuthority.initialize(), ciAuthority.initialize()]);
	async function evidence(): Promise<HostingPlanningInput> {
		const current = await hostAuthority.read(now());
		const budget = {
			tenantId: "tenant",
			budgetId,
			scopeId: "camp:prod",
			periodId: "period",
			policyRevision: "r1",
			ledgerSeq: current.seq,
			currency: "USD",
			periodStartMs: AT - 1000,
			periodEndMs: Date.parse(UNTIL),
			capMicros: current.limitMicros,
			settledMicros: current.spentMicros,
			committedMicros: current.externalCommittedMicros + current.reservedMicros,
			unresolvedMicros: current.unresolvedMicros,
			recoveryReserveMicros: current.recoveryReserveMicros,
			observedAtMs: Date.parse(current.observedAt),
			validUntilMs: Date.parse(current.validUntil),
			providerAccountId: "",
		};
		return {
			budget,
			budgetPolicy: policy,
			nowMs: clock,
			horizonEndMs: END,
			maxObservationAgeMs: 86_400_000,
			usages: [
				{
					resourceName: "app",
					unit: "request",
					expectedQuantity: 1,
					boundedQuantity: 1,
				},
			],
			entitlements: [],
			providerBudgets: current.providerAccounts.map((account) => ({
				...budget,
				budgetId: "payer",
				scopeId: account.providerAccountId,
				providerAccountId: account.providerAccountId,
				capMicros: account.limitMicros,
				settledMicros: account.spentMicros,
				committedMicros:
					account.externalCommittedMicros + account.reservedMicros,
				unresolvedMicros: 0,
				recoveryReserveMicros: 0,
			})),
			quotes: [
				{
					id: "native:hosting-quote",
					resourceName: "app",
					definitionId: "host",
					providerId: "host",
					providerAccountId: "native:account",
					currency: "USD",
					rateMicros: 60,
					billingUnit: "request",
					billingPeriodMs: 0,
					source: "native:trusted-pricing",
					observedAtMs: AT,
					validUntilMs: Date.parse(UNTIL),
					liabilityEndsAtMs: END,
					entitlementId: "",
					minimumQuantity: 0,
					roundUpQuantity: false,
					fixedCostMicros: 0,
					transitionCostMicros: 0,
				},
			],
		};
	}
	let hostActualMicros = 40;
	const bridge = createHostingBudgetAuthorityBridge({
		authority: hostAuthority,
		scopeId: "camp:prod",
		nowMs: () => clock,
		resolve: evidence,
		revalidate: evidence,
		settlement: async (request) => {
			if (
				request.evidenceRef !== "native:hosting-final" ||
				request.sourceStoppedEvidenceRef !== "native:hosting-stopped"
			)
				throw new Error("authoritative hosting usage is not final");
			return {
				actualMicros: hostActualMicros,
				usageEvidenceRef: request.evidenceRef,
				sourceStoppedEvidenceRef: request.sourceStoppedEvidenceRef,
				providerAccounts: [
					create(ProviderAccountExposureSchema, {
						providerAccountId: "native:account",
						liabilityMicros: hostActualMicros,
					}),
				],
			};
		},
	});
	const lease = create(LeaseSchema, {
		id: "ci-execution",
		accountId: "ci-account",
		offerId: "runner",
		provider: "github",
		providerAccountId: "native:account",
		jobId: 1,
		originalRunId: 10,
		runAttempt: 1,
		repositoryId: 2,
		installationId: 3,
		repository: "org/repo",
		state: "reserved",
		reservedMinutes: 1,
		reservedPaidMicros: 60,
		priceMicrosPerMinute: 60,
		budgetTenantId: "tenant",
		budgetId,
		budgetPeriodId: "period",
		budgetPolicyRevision: "r1",
		budgetPolicyDigest: canonicalBudgetPolicyJson(parseBudgetPolicy(policy)),
		budgetAdmissionAttempt: 1,
		createdAt: NOW,
	});
	const ci = createCiAsyncSharedBudgetHooks({
		authority: ciAuthority,
		now,
		quoteLease: (row) =>
			create(HostingQuoteSchema, {
				quoteId: `native:${ciReservationId(row)}`,
				yardId: `ci:${row.accountId}`,
				providerId: row.provider,
				ownerTenantId: row.budgetTenantId,
				currency: "USD",
				totalMicros: row.reservedPaidMicros,
				liabilityBoundMicros: row.reservedPaidMicros,
				observedAt: NOW,
				validUntil: UNTIL,
				components: [
					{
						name: "complete-native-runner",
						costMicros: row.reservedPaidMicros,
					},
				],
				requestDigest: ciRequestDigest(row),
				financialPlanHash: ciFinancialPlanHash(row),
				providerAccounts: [
					{
						providerAccountId: row.providerAccountId,
						liabilityMicros: row.reservedPaidMicros,
					},
				],
			}),
		verifyProviderLiabilityBound: (row, quote, at) =>
			row.providerAccountId === "native:account" &&
			quote.providerAccounts[0]?.providerAccountId === row.providerAccountId &&
			quote.liabilityBoundMicros === 60 &&
			at === NOW,
		verifyFinalUsage: (_, refs) =>
			refs.usageEvidenceRef === "native:ci-final" &&
			refs.sourceStoppedEvidenceRef === "native:ci-stopped",
	});
	async function proposal() {
		const pass = createHostingPlanningPass(await evidence());
		pass.commit("app", {
			id: "host",
			providerId: "host",
			port: "compute",
			features: [],
			regions: [],
			specificity: 1,
			priority: 0,
			cost: { sku: "host", marginalPrice: "0.00006", unit: "request" },
			satisfies: () => ({ kind: "full" }),
		});
		return pass.commitment();
	}
	return {
		bridge,
		ci,
		lease,
		hostAuthority,
		ciAuthority,
		proposal,
		hostPool,
		ciPool,
		applicationName,
		partitionId: createHash("sha256")
			.update(JSON.stringify(["tenant", budgetId]))
			.digest("hex"),
		setClock: (value: number) => {
			clock = value;
		},
		setHostActual: (value: number) => {
			hostActualMicros = value;
		},
	};
}

async function settleHosting(
	bridge: SharedHostingBudgetAuthority,
	identity: Parameters<SharedHostingBudgetAuthority["lookup"]>[0],
	actualMicros: number,
) {
	expect(
		await bridge.claimExecution({
			...identity,
			financialPlanHash: PLAN_HASH,
			executionDigest: "hosting:execution",
		}),
	).toEqual({ ok: true });
	expect(
		await bridge.claimExecution({
			...identity,
			financialPlanHash: PLAN_HASH,
			executionDigest: "hosting:another",
		}),
	).toMatchObject({ ok: false });
	await bridge.uncertain({ ...identity, reason: "acknowledgement lost" });
	expect(await bridge.lookup(identity)).toMatchObject({
		status: "uncertain",
		reservedMicros: 60,
		executionDigest: "hosting:execution",
	});
	expect(
		await bridge.settle({
			...identity,
			settledMicros: actualMicros,
			evidenceRef: "unknown",
			sourceStoppedEvidenceRef: "unknown",
		}),
	).toMatchObject({ ok: false });
	expect(await bridge.lookup(identity)).toMatchObject({
		status: "uncertain",
		reservedMicros: 60,
	});
	const observed = {
		...identity,
		settledMicros: actualMicros,
		evidenceRef: "native:hosting-final",
		sourceStoppedEvidenceRef: "native:hosting-stopped",
	};
	expect(await bridge.settle(observed)).toEqual({ ok: true });
	expect(await bridge.settle(observed)).toEqual({ ok: true });
	expect(await bridge.lookup(identity)).toMatchObject({
		status: "settled",
		settledMicros: actualMicros,
	});
}

describe.skipIf(!connectionString)(
	"real PostgreSQL hosting and CI authority composition",
	() => {
		it("rechecks the trusted clock after a real PostgreSQL lock wait expires the funding window", async () => {
			const fx = await fixture();
			const commitment = await fx.proposal();
			const blocker = await fx.hostPool.connect();
			let locked = false;
			let pending: ReturnType<typeof fx.bridge.reserve> | undefined;
			try {
				await blocker.query("BEGIN");
				locked = true;
				await blocker.query(
					"SELECT id FROM hobo_budget_partitions WHERE id=$1 FOR UPDATE",
					[fx.partitionId],
				);
				pending = fx.bridge.reserve({
					reservationId: "hosting:late",
					planHash: PLAN_HASH,
					commitment,
				});
				await expect
					.poll(
						async () => {
							const result = await fx.ciPool.query<{ waiting: boolean }>(
								"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting",
								[fx.applicationName],
							);
							return result.rows[0]?.waiting;
						},
						{ timeout: 3000, interval: 20 },
					)
					.toBe(true);
				fx.setClock(END);
				await blocker.query("COMMIT");
				locked = false;
				expect(await pending).toMatchObject({
					ok: false,
					reason: expect.stringContaining("authorization expired"),
				});
				expect(
					await fx.hostAuthority.read(new Date(END).toISOString()),
				).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
			} finally {
				if (locked) await blocker.query("ROLLBACK");
				blocker.release();
				await pending;
			}
		}, 10_000);
		it("races actual hosting bridge against CI hooks, then settles/replays both without a second balance or duplicate holds", async () => {
			const fx = await fixture();
			const commitment = await fx.proposal();
			const request = {
				reservationId: "hosting:race",
				planHash: PLAN_HASH,
				commitment,
			};
			const [hosting, ci] = await Promise.allSettled([
				fx.bridge.reserve(request),
				fx.ci.reserve(fx.lease),
			]);
			if (hosting.status !== "fulfilled")
				throw new Error("hosting bridge failed to classify admission");
			expect(Number(hosting.value.ok) + Number(ci.status === "fulfilled")).toBe(
				1,
			);
			expect(await fx.hostAuthority.read(NOW)).toMatchObject({
				reservedMicros: 60,
				spentMicros: 0,
			});
			expect(await fx.ciAuthority.read(NOW)).toMatchObject({
				reservedMicros: 60,
				spentMicros: 0,
			});
			if (hosting.value.ok) {
				expect(await fx.bridge.reserve(request)).toEqual(hosting.value);
				await settleHosting(
					fx.bridge,
					{
						reservationId: request.reservationId,
						tenantId: "tenant",
						commitmentHash: commitment.commitmentHash,
					},
					40,
				);
				expect(await fx.ciAuthority.read(NOW)).toMatchObject({
					spentMicros: 40,
					reservedMicros: 0,
				});
				await fx.ci.reserve(fx.lease);
			} else {
				await fx.ci.reserve(fx.lease);
				await fx.ci.claim(fx.lease);
				await fx.ci.uncertain(fx.lease);
				fx.lease.paidMicros = 40;
				const evidence = {
					usageEvidenceRef: "native:ci-final",
					sourceStoppedEvidenceRef: "native:ci-stopped",
					providerAccounts: [
						create(ProviderAccountExposureSchema, {
							providerAccountId: "native:account",
							liabilityMicros: 40,
						}),
					],
				};
				await fx.ci.settle(fx.lease, evidence);
				await fx.ci.settle(fx.lease, evidence);
				expect(await fx.hostAuthority.read(NOW)).toMatchObject({
					spentMicros: 40,
					reservedMicros: 0,
				});
				const next = await fx.proposal();
				const nextRequest = {
					reservationId: "hosting:after-ci",
					planHash: PLAN_HASH,
					commitment: next,
				};
				expect(await fx.bridge.reserve(nextRequest)).toMatchObject({
					ok: true,
				});
				expect(await fx.bridge.reserve(nextRequest)).toMatchObject({
					ok: true,
				});
				fx.setHostActual(30);
				await settleHosting(
					fx.bridge,
					{
						reservationId: nextRequest.reservationId,
						tenantId: "tenant",
						commitmentHash: next.commitmentHash,
					},
					30,
				);
			}
			if (hosting.value.ok) {
				await fx.ci.claim(fx.lease);
				await fx.ci.uncertain(fx.lease);
				fx.lease.paidMicros = 30;
				const evidence = {
					usageEvidenceRef: "native:ci-final",
					sourceStoppedEvidenceRef: "native:ci-stopped",
					providerAccounts: [
						create(ProviderAccountExposureSchema, {
							providerAccountId: "native:account",
							liabilityMicros: 30,
						}),
					],
				};
				await fx.ci.settle(fx.lease, evidence);
				await fx.ci.settle(fx.lease, evidence);
			}
			expect(await fx.hostAuthority.read(NOW)).toMatchObject({
				spentMicros: 70,
				reservedMicros: 0,
			});
			expect(await fx.ciAuthority.read(NOW)).toMatchObject({
				spentMicros: 70,
				reservedMicros: 0,
			});
		}, 20_000);
	},
);
