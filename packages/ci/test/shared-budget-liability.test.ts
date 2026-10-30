import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, create } from "@bufbuild/protobuf";
import {
	BudgetAdmissionDeniedError,
	BudgetLedgerSnapshotSchema,
	createPostgresBudgetAdmissionAuthority,
	createSqliteBudgetAdmissionAuthority,
	HostingQuoteSchema,
} from "@hobo/broker";
import { canonicalBudgetPolicyJson, parseBudgetPolicy } from "@hobo/core";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
	AccountSchema,
	ConfigurationSchema,
	LeaseSchema,
	OfferSchema,
} from "../src/_generated/ci_pb.js";
import { parsePipeline } from "../src/execution.js";
import {
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
	createCiAsyncSharedBudgetHooks,
	createCiSharedBudgetHooks,
} from "../src/shared-budget.js";
import { LeaseStore } from "../src/store.js";

const NOW = "2026-10-30T12:00:00Z";
const UNTIL = "2026-10-31T00:00:00Z";

describe("native liability and local CI reservation agree", () => {
	it.skipIf(!process.env.HOBO_TEST_POSTGRES_URL)(
		"rejects a larger async native bound before changing the PostgreSQL authority",
		async () => {
			const pool = new Pool({
				connectionString: process.env.HOBO_TEST_POSTGRES_URL,
			});
			const budgetId = randomUUID();
			const parent = createPostgresBudgetAdmissionAuthority({
				pool,
				now: () => NOW,
				snapshot: create(BudgetLedgerSnapshotSchema, {
					identity: {
						tenantId: "tenant",
						budgetId,
						periodId: "p1",
						policyRevision: "r1",
					},
					limitMicros: 1000,
					observedAt: NOW,
					validUntil: UNTIL,
					providerAccounts: [
						{ providerAccountId: "native-account", limitMicros: 1000 },
					],
				}),
			});
			try {
				const lease = create(LeaseSchema, {
					id: "lease",
					accountId: "ci",
					offerId: "native",
					provider: "github",
					providerAccountId: "native-account",
					pipelineId: "build",
					pipelineDigest: "immutable-plan",
					runAttempt: 1,
					budgetAdmissionAttempt: 1,
					reservedMinutes: 1,
					reservedPaidMicros: 40,
					priceMicrosPerMinute: 40,
					budgetTenantId: "tenant",
					budgetId,
					budgetPeriodId: "p1",
					budgetPolicyRevision: "r1",
					budgetPolicyDigest: canonicalBudgetPolicyJson(
						parseBudgetPolicy({
							schemaVersion: "hobo.budget-policy/v1",
							tenantId: "tenant",
							budgetId,
							periodId: "p1",
							revision: "r1",
							workloads: ["hosting", "ci"],
							currency: "USD",
							limitMicros: 1000,
							objective: "min-cost",
							enforcement: "strict",
							periodKind: "manual",
							constraints: [],
						}),
					),
				});
				const hooks = createCiAsyncSharedBudgetHooks({
					authority: parent,
					now: () => NOW,
					verifyProviderLiabilityBound: () => true,
					quoteLease: (row) =>
						create(HostingQuoteSchema, {
							quoteId: `quote:${ciReservationId(row)}`,
							yardId: `ci:${row.accountId}`,
							providerId: row.provider,
							ownerTenantId: row.budgetTenantId,
							currency: "USD",
							totalMicros: 40,
							liabilityBoundMicros: 60,
							observedAt: NOW,
							validUntil: UNTIL,
							components: [{ name: "complete", costMicros: 40 }],
							requestDigest: ciRequestDigest(row),
							financialPlanHash: ciFinancialPlanHash(row),
							providerAccounts: [
								{
									providerAccountId: row.providerAccountId,
									liabilityMicros: 60,
								},
							],
						}),
				});
				await parent.initialize();
				await expect(hooks.reserve(lease)).rejects.toBeInstanceOf(
					BudgetAdmissionDeniedError,
				);
				expect(await parent.lookup(ciReservationId(lease))).toBeUndefined();
				expect(await parent.read(NOW)).toMatchObject({
					seq: 0,
					reservedMicros: 0,
				});
			} finally {
				await pool.end();
			}
		},
	);
	it("refuses native60 against local50/quoted40, then counts the full refreshed60 in future local holds", () => {
		let now = NOW;
		const directory = mkdtempSync(join(tmpdir(), "hobo-ci-liability-"));
		const parent = createSqliteBudgetAdmissionAuthority({
			path: join(directory, "parent.sqlite"),
			now: () => now,
			snapshot: create(BudgetLedgerSnapshotSchema, {
				identity: {
					tenantId: "tenant",
					budgetId: "shared",
					periodId: "p1",
					policyRevision: "r1",
				},
				limitMicros: 1000,
				observedAt: NOW,
				validUntil: UNTIL,
				providerAccounts: [
					{ providerAccountId: "native-account", limitMicros: 1000 },
				],
			}),
		});
		const quotedLocalReservations: number[] = [];
		const hooks = createCiSharedBudgetHooks({
			authority: parent,
			now: () => now,
			verifyProviderLiabilityBound: () => true,
			quoteLease: (lease) => {
				quotedLocalReservations.push(lease.reservedPaidMicros);
				return create(HostingQuoteSchema, {
					quoteId: `quote:${ciReservationId(lease)}`,
					yardId: `ci:${lease.accountId}`,
					providerId: lease.provider,
					ownerTenantId: lease.budgetTenantId,
					currency: "USD",
					totalMicros: lease.reservedPaidMicros,
					liabilityBoundMicros: 60,
					observedAt: NOW,
					validUntil: UNTIL,
					components: [
						{
							name: "complete-native-liability",
							costMicros: lease.reservedPaidMicros,
						},
					],
					requestDigest: ciRequestDigest(lease),
					financialPlanHash: ciFinancialPlanHash(lease),
					providerAccounts: [
						{ providerAccountId: lease.providerAccountId, liabilityMicros: 60 },
					],
				});
			},
		});
		const store = new LeaseStore(join(directory, "leases.sqlite"), undefined, {
			sharedBudget: hooks,
		});
		try {
			const config = create(ConfigurationSchema, {
				accounts: [
					create(AccountSchema, {
						id: "ci",
						budgetMicros: 50,
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
							limitMicros: 1000,
							objective: "min-cost",
							enforcement: "strict",
							periodKind: "manual",
							constraints: [],
						},
						offers: [
							create(OfferSchema, {
								id: "native",
								provider: "github",
								providerAccountId: "native-account",
								enabled: true,
								runsOn: "ubuntu-24.04",
								priceMicrosPerMinute: 20,
								budgetMicros: 50,
								concurrency: 10,
								observedAt: NOW,
								validUntil: UNTIL,
								sourceUrl: "https://rates.example.test/current",
								bridgeAcknowledged: true,
							}),
						],
					}),
				],
			});
			const account = config.accounts[0];
			if (!account) throw new Error("fixture account missing");
			const pipeline = parsePipeline(
				JSON.stringify({
					id: "build",
					accountId: account.id,
					timeoutSeconds: 60,
					steps: [{ id: "test", argv: ["true"] }],
				}),
			);
			store.configure(config, 0, NOW);
			expect(
				store.reservePipeline(
					account,
					pipeline,
					"build-digest",
					["native"],
					NOW,
				),
			).toBeUndefined();
			expect(
				store.reservePipeline(
					account,
					pipeline,
					"build-digest",
					["native"],
					NOW,
				),
			).toBeUndefined();
			expect(quotedLocalReservations).toEqual([40, 40]);
			expect(parent.read(NOW)).toMatchObject({ seq: 0, reservedMicros: 0 });
			expect(store.all()).toEqual([]);
			const refreshed = clone(ConfigurationSchema, config);
			const updated = refreshed.accounts[0];
			const offer = updated?.offers[0];
			if (!updated || !offer) throw new Error("fixture rate card missing");
			updated.budgetMicros = 100;
			offer.budgetMicros = 100;
			offer.priceMicrosPerMinute = 30;
			now = "2026-10-30T12:00:01Z";
			offer.observedAt = now;
			store.configure(refreshed, 1, now);
			const admitted = store.reservePipeline(
				updated,
				pipeline,
				"build-digest",
				["native"],
				now,
			);
			expect(admitted).toMatchObject({
				reservedPaidMicros: 60,
				budgetAdmissionAttempt: 1,
			});
			expect(parent.read(NOW).reservedMicros).toBe(60);
			const later = parsePipeline(
				JSON.stringify({
					id: "later",
					accountId: updated.id,
					timeoutSeconds: 60,
					steps: [{ id: "test", argv: ["true"] }],
				}),
			);
			expect(
				store.reservePipeline(updated, later, "later-digest", ["native"], now),
			).toBeUndefined();
			expect(parent.read(NOW).reservedMicros).toBe(60);
			expect(store.all()).toHaveLength(1);
		} finally {
			store.close();
			parent.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
