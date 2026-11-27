import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { create, fromJsonString } from "@bufbuild/protobuf";
import {
	BudgetLedgerSnapshotSchema,
	createIacFinancialServices,
	createSqliteBudgetAdmissionAuthority,
	HostingPolicyProofSchema,
	IacTargetLiabilityEvidenceSchema,
} from "@hobo-labs/broker";
import { QuoteScenarioSchema } from "@hobo-labs/pricing";

const now = "2026-01-02T00:00:00Z";
const end = "2026-01-31T23:59:59Z";
const plan = {
	targetId: "yard-a",
	tenantId: "tenant-a",
	planDigest: `sha256:${"a".repeat(64)}`,
	operation: "deploy" as const,
	evidenceRef: "inventory:1",
	resources: [
		{
			resourceId: "resource-a",
			providerId: "sandbox",
			providerAccountRef: "account-a",
			productId: "sandbox",
		},
	],
};
const authority = createSqliteBudgetAdmissionAuthority({
	path: join(process.cwd(), "financial-acceptance.sqlite"),
	now: () => now,
	iacPricedSettlementTrust: { verify: () => false },
	snapshot: create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "tenant-a",
			budgetId: "hosting",
			periodId: "2026-01",
			policyRevision: "r1",
		},
		limitMicros: 2_000_000,
		observedAt: "2026-01-01T00:00:00Z",
		validUntil: end,
		providerAccounts: [
			{ providerAccountId: "account-a", limitMicros: 3_000_000 },
		],
	}),
});
try {
	const unknown = createIacFinancialServices({ authority, now: () => now });
	const missing = unknown.assess(plan);
	assert.equal(missing.quote.ok, false);
	if (missing.quote.ok) throw new Error("missing pricing was quoted");
	assert.equal(missing.quote.code, "PRICING_MODEL_UNAVAILABLE");
	assert.deepEqual(missing.admissionPath, {
		kind: "unavailable",
		code: "PRICING_MODEL_UNAVAILABLE",
	});
	assert.deepEqual(missing.budget, {
		evaluation: "not-evaluated",
		reservation: "not-created",
	});
	assert.equal(missing.providerCoverage.providers[0]?.status, "unavailable");
	const denied = await unknown.admit("unknown-attempt", plan);
	assert.equal(denied.status, "denied");
	assert.equal(denied.code, "PRICING_MODEL_UNAVAILABLE");
	assert.equal(authority.read(now).reservedMicros, 0);

	const scenario = fromJsonString(
		QuoteScenarioSchema,
		await readFile(join(process.cwd(), "financial-scenario.json"), "utf8"),
	);
	const financial = createIacFinancialServices({
		authority,
		now: () => now,
		pricing: {
			modelId: "terms",
			revision: "1",
			scenario,
			bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
		},
		verifyLiability: async () => true,
		authorize: async (input) => ({
			gate: { effect: "allow", reasons: [], events: [] },
			proof: create(HostingPolicyProofSchema, {
				requestDigest: input.requestDigest,
				quoteId: input.quote.quoteId,
				identity: input.identity,
				effect: "allow",
				policyHash: "sha256:policy",
				evidenceRef: "policy:1",
				obligationsSatisfied: true,
			}),
		}),
		issueLiability: ({ priced }) =>
			create(IacTargetLiabilityEvidenceSchema, {
				evidenceRef: "evidence:provider-bound",
				targetId: plan.targetId,
				tenantId: plan.tenantId,
				planDigest: plan.planDigest,
				inventoryHash: priced.inventoryHash,
				modelHash: priced.modelHash,
				quoteHash: priced.quote.quoteHash,
				maximumMicrosExact: 1_500_000n,
				observedAt: "2026-01-01T00:00:00Z",
				validUntil: end,
				providerAccounts: [
					{ providerAccountId: "account-a", liabilityMicros: 1_500_000 },
				],
			}),
	});
	const assessment = financial.assess(plan);
	assert.equal(assessment.quote.ok, true);
	assert.equal(assessment.admissionPath.kind, "bounded-budget");
	const coverage = assessment.providerCoverage.providers[0];
	assert.equal(coverage?.providerId, "sandbox");
	assert.equal(coverage?.status, "quoted");
	if (coverage?.status !== "quoted") throw new Error("provider was not quoted");
	assert.deepEqual(coverage.model, {
		source: "developer-supplied",
		modelId: "terms",
		revision: "1",
	});
	assert.deepEqual(assessment.budget, {
		evaluation: "not-evaluated",
		reservation: "not-created",
	});
	const admitted = await financial.admit("priced-attempt", plan);
	assert.equal(admitted.status, "admitted");
	assert.equal(admitted.budget?.evaluation, "allowed");
	assert.equal(admitted.budget?.reservation, "held");
	assert.equal(authority.read(now).reservedMicros, 1_500_000);
	const exhausted = await financial.admit("over-budget-attempt", plan);
	assert.equal(exhausted.status, "denied");
	assert.equal(exhausted.code, "budget.exhausted");
	assert.equal(authority.read(now).reservedMicros, 1_500_000);
} finally {
	authority.close();
}
