import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	createTargetPricingInventory,
	quoteTargetPricing,
	targetPricingModel,
} from "@hobo/pricing";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
	makeScenario,
	perUnitCharge,
	usage,
	workload,
} from "../../pricing/test/fixtures.js";
import {
	admitIacTarget,
	BudgetLedgerSnapshotSchema,
	createPostgresBudgetAdmissionAuthority,
	HostingPolicyProofSchema,
	IacTargetLiabilityEvidenceSchema,
} from "../src/index.js";

const url = process.env.HOBO_TEST_POSTGRES_URL;
const now = "2026-01-02T00:00:00Z";
const end = "2026-01-31T23:59:59Z";

describe.skipIf(url === undefined)(
	"shared asynchronous IaC budget authority",
	() => {
		it("admits at most one execution across independent PostgreSQL clients", async () => {
			const pools = [
				new Pool({ connectionString: url }),
				new Pool({ connectionString: url }),
			] as const;
			const suffix = randomUUID();
			const snapshot = create(BudgetLedgerSnapshotSchema, {
				identity: {
					tenantId: "tenant-a",
					budgetId: `iac-${suffix}`,
					periodId: "2026-01",
					policyRevision: "r1",
				},
				limitMicros: 3_000_000,
				observedAt: "2026-01-01T00:00:00Z",
				validUntil: end,
				providerAccounts: [
					{ providerAccountId: "account-a", limitMicros: 3_000_000 },
				],
			});
			const authorities = pools.map((pool) =>
				createPostgresBudgetAdmissionAuthority({
					pool,
					snapshot,
					now: () => now,
					iacPricedSettlementTrust: { verify: () => false },
				}),
			);
			try {
				const planDigest = `sha256:${"a".repeat(64)}`;
				const inventory = createTargetPricingInventory({
					targetId: "yard-a",
					tenantId: "tenant-a",
					planDigest,
					complete: true,
					evidenceRef: "inventory:1",
					operation: "deploy",
					resources: [
						{
							resourceId: "service",
							providerId: "sandbox",
							providerAccountRef: "account-a",
							productId: "sandbox",
						},
					],
				});
				const scenario = makeScenario({
					charges: [perUnitCharge("runtime", "minute", "0.25")],
					candidate: [
						workload("agreement-a", [usage("minute", "4", "minute")]),
					],
				});
				const pricing = targetPricingModel({
					modelId: "terms",
					revision: "1",
					planDigest,
					scenario,
					bindings: [{ resourceId: "service", candidateIndex: 0 }],
				});
				const priced = quoteTargetPricing(inventory, pricing);
				if (!priced.ok) throw new Error(priced.reason);
				const evidence = create(IacTargetLiabilityEvidenceSchema, {
					evidenceRef: "bound:1",
					targetId: "yard-a",
					tenantId: "tenant-a",
					planDigest,
					inventoryHash: priced.inventoryHash,
					modelHash: priced.modelHash,
					quoteHash: priced.quote.quoteHash,
					maximumMicrosExact: 1_500_000n,
					observedAt: "2026-01-01T00:00:00Z",
					validUntil: end,
					providerAccounts: [
						{ providerAccountId: "account-a", liabilityMicros: 1_500_000 },
					],
				});
				const input = {
					requestId: `request-${suffix}`,
					inventory,
					pricing,
					evidence,
				};
				const run = (authority: (typeof authorities)[number]) =>
					admitIacTarget(input, {
						authority,
						now: () => now,
						verifyLiability: () => true,
						authorize: ({ requestDigest, quote, identity }) => ({
							gate: { effect: "allow", reasons: [], events: [] },
							proof: create(HostingPolicyProofSchema, {
								requestDigest,
								quoteId: quote.quoteId,
								identity,
								effect: "allow",
								policyHash: "policy:1",
								evidenceRef: "gate:1",
								obligationsSatisfied: true,
							}),
						}),
					});
				const [first, second] = authorities;
				if (first === undefined || second === undefined)
					throw new Error("authority missing");
				const withoutTrust = createPostgresBudgetAdmissionAuthority({
					pool: pools[0],
					snapshot,
					now: () => now,
				});
				expect(await run(withoutTrust)).toMatchObject({
					status: "denied",
					code: "budget.settlement-unavailable",
					budget: { evaluation: "unavailable", reservation: "not-created" },
				});
				expect((await withoutTrust.read(now)).reservedMicros).toBe(0);
				const decisions = await Promise.all([run(first), run(second)]);
				expect(
					decisions.filter((decision) => decision.status === "admitted"),
				).toHaveLength(1);
				expect(
					decisions.filter((decision) => decision.status !== "admitted")[0]
						?.status,
				).toMatch(/^(replay|uncertain)$/u);
				expect((await first.read(now)).reservedMicros).toBe(1_500_000);
			} finally {
				await Promise.all(pools.map((pool) => pool.end()));
			}
		});
	},
);
