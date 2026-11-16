import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	createTargetPricingInventory,
	quoteTargetPricing,
	targetPricingModel,
	targetPricingUnavailable,
} from "@hobo/pricing";
import { afterEach, describe, expect, it } from "vitest";
import {
	makeScenario,
	perUnitCharge,
	usage,
	workload,
} from "../../pricing/test/fixtures.js";
import {
	admitIacTarget,
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createSqliteBudgetAdmissionAuthority,
	HostingPolicyProofSchema,
	IacTargetLiabilityEvidenceSchema,
} from "../src/index.js";

const NOW = "2026-01-02T00:00:00Z";
const END = "2026-01-31T23:59:59Z";
const PLAN = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function fixture() {
	const scenario = makeScenario({
		charges: [perUnitCharge("runtime", "minute", "0.25")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
	const inventory = createTargetPricingInventory({
		targetId: "yard-a",
		tenantId: "tenant-a",
		planDigest: PLAN,
		complete: true,
		evidenceRef: "inventory:1",
		resources: [
			{
				resourceId: "resource-a",
				providerId: "sandbox",
				providerAccountRef: "account-a",
				productId: "sandbox",
			},
		],
	});
	const pricing = targetPricingModel({
		modelId: "terms",
		revision: "1",
		planDigest: PLAN,
		scenario,
		bindings: [{ resourceId: "resource-a", candidateIndex: 0 }],
	});
	const result = quoteTargetPricing(inventory, pricing);
	if (!result.ok) throw new Error(result.reason);
	const evidence = create(IacTargetLiabilityEvidenceSchema, {
		evidenceRef: "evidence:provider-bound",
		targetId: "yard-a",
		tenantId: "tenant-a",
		planDigest: PLAN,
		inventoryHash: result.inventoryHash,
		modelHash: result.modelHash,
		quoteHash: result.quote.quoteHash,
		maximumMicros: 1_500_000,
		observedAt: "2026-01-01T00:00:00Z",
		validUntil: END,
		providerAccounts: [
			{ providerAccountId: "account-a", liabilityMicros: 1_500_000 },
		],
	});
	return { inventory, pricing, evidence };
}

function authority(limit = 3_000_000) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-iac-budget-"));
	directories.push(dir);
	const ledger = createSqliteBudgetAdmissionAuthority({
		path: join(dir, "budget.sqlite"),
		now: () => NOW,
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant-a",
				budgetId: "hosting",
				periodId: "2026-01",
				policyRevision: "r1",
			},
			limitMicros: limit,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: END,
			providerAccounts: [
				create(BudgetProviderAccountSchema, {
					providerAccountId: "account-a",
					limitMicros: limit,
				}),
			],
		}),
	});
	return ledger;
}

function dependencies(ledger: ReturnType<typeof authority>) {
	return {
		authority: ledger,
		now: () => NOW,
		verifyLiability: async () => true,
		authorize: async (input: {
			requestDigest: string;
			quote: { quoteId: string };
			identity: {
				tenantId: string;
				budgetId: string;
				periodId: string;
				policyRevision: string;
			};
		}) => ({
			gate: { effect: "allow" as const, reasons: [], events: [] },
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
	};
}

describe("provider-neutral IaC target budget admission", () => {
	it("refuses an unknown price before any financial hold is created", async () => {
		const ledger = authority();
		try {
			const request = fixture();
			request.pricing = targetPricingUnavailable("no pricing model");
			const decision = await admitIacTarget(
				{ requestId: "unknown", ...request },
				dependencies(ledger),
			);
			expect(decision).toMatchObject({
				status: "denied",
				code: "PRICING_MODEL_UNAVAILABLE",
				budget: { evaluation: "unavailable", reservation: "not-created" },
			});
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("reserves the authenticated bound and claims exactly one execution", async () => {
		const ledger = authority();
		try {
			const request = { requestId: "priced", ...fixture() };
			const result = await admitIacTarget(request, dependencies(ledger));
			expect(result).toMatchObject({
				status: "admitted",
				budget: { evaluation: "allowed", reservation: "held" },
				quote: { totalMicros: 1_000_000, liabilityBoundMicros: 1_500_000 },
				reservation: { reservedMicros: 1_500_000 },
			});
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
			expect(await admitIacTarget(request, dependencies(ledger))).toMatchObject(
				{ status: "replay", code: "EXECUTION_ALREADY_CLAIMED" },
			);
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it.each([
		"wrong-plan",
		"expired",
		"unverified",
		"too-small",
	] as const)("refuses %s liability evidence without a hold", async (kind) => {
		const ledger = authority();
		try {
			const request = { requestId: `bad-${kind}`, ...fixture() };
			if (kind === "wrong-plan")
				request.evidence.planDigest = `sha256:${"b".repeat(64)}`;
			if (kind === "expired") request.evidence.validUntil = NOW;
			if (kind === "too-small") request.evidence.maximumMicros = 1;
			const deps = dependencies(ledger);
			if (kind === "unverified") deps.verifyLiability = async () => false;
			expect(await admitIacTarget(request, deps)).toMatchObject({
				status: "denied",
			});
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("does not reserve when a budget policy requires approval", async () => {
		const ledger = authority();
		try {
			const deps = dependencies(ledger);
			const allow = deps.authorize;
			deps.authorize = async (input) => {
				const result = await allow(input);
				return {
					...result,
					gate: { ...result.gate, effect: "require-approval" },
				};
			};
			expect(
				await admitIacTarget({ requestId: "approval", ...fixture() }, deps),
			).toMatchObject({ status: "denied", code: "POLICY_NOT_ALLOWED" });
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("returns a definitive budget refusal before making a hold", async () => {
		const ledger = authority(1_000_000);
		try {
			const decision = await admitIacTarget(
				{ requestId: "exhausted", ...fixture() },
				dependencies(ledger),
			);
			expect(decision).toMatchObject({
				status: "denied",
				code: "provider.exhausted",
				budget: { evaluation: "denied", reservation: "not-created" },
			});
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it("fails closed when evidence verification is unavailable", async () => {
		const ledger = authority();
		try {
			const deps = dependencies(ledger);
			deps.verifyLiability = async () => {
				throw new Error("offline");
			};
			expect(
				await admitIacTarget({ requestId: "offline", ...fixture() }, deps),
			).toMatchObject({
				status: "denied",
				code: "LIABILITY_VERIFIER_UNAVAILABLE",
			});
			expect(ledger.read(NOW).reservedMicros).toBe(0);
		} finally {
			ledger.close();
		}
	});

	it.each([
		"reserve",
		"claimExecution",
	] as const)("reports an uncertain outcome when %s commits but loses its acknowledgement", async (operation) => {
		const ledger = authority();
		try {
			const deps = dependencies(ledger);
			const wrapped = { ...ledger };
			if (operation === "reserve")
				wrapped.reserve = (input) => {
					ledger.reserve(input);
					throw new Error("lost response");
				};
			else
				wrapped.claimExecution = (input) => {
					ledger.claimExecution(input);
					throw new Error("lost response");
				};
			deps.authority = wrapped;
			const decision = await admitIacTarget(
				{ requestId: `lost-${operation}`, ...fixture() },
				deps,
			);
			expect(decision).toMatchObject({
				status: "uncertain",
				budget: { evaluation: "unavailable" },
			});
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it("claims at most one execution for concurrent identical requests", async () => {
		const ledger = authority();
		try {
			const request = { requestId: "concurrent", ...fixture() };
			const decisions = await Promise.all([
				admitIacTarget(request, dependencies(ledger)),
				admitIacTarget(request, dependencies(ledger)),
			]);
			expect(
				decisions.filter((decision) => decision.status === "admitted"),
			).toHaveLength(1);
			expect(
				decisions.filter((decision) => decision.status !== "admitted")[0]
					?.status,
			).toMatch(/^(replay|uncertain)$/u);
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it("uses an asynchronous durable authority without authorizing a replay", async () => {
		const ledger = authority();
		try {
			const asyncAuthority = {
				persistence: "durable-cas" as const,
				read: async (at: string) => ledger.read(at),
				lookup: async (id: string) => ledger.lookup(id),
				reserve: async (input: Parameters<typeof ledger.reserve>[0]) =>
					ledger.reserve(input),
				claimExecution: async (
					input: Parameters<typeof ledger.claimExecution>[0],
				) => ledger.claimExecution(input),
				settle: async (...args: Parameters<typeof ledger.settle>) =>
					ledger.settle(...args),
				uncertain: async (id: string) => ledger.uncertain(id),
				release: async (...args: Parameters<typeof ledger.release>) =>
					ledger.release(...args),
			};
			const deps = { ...dependencies(ledger), authority: asyncAuthority };
			const request = { requestId: "async-authority", ...fixture() };
			expect(await admitIacTarget(request, deps)).toMatchObject({
				status: "admitted",
				budget: { evaluation: "allowed", reservation: "held" },
			});
			expect(await admitIacTarget(request, deps)).toMatchObject({
				status: "replay",
				code: "EXECUTION_ALREADY_CLAIMED",
			});
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it("does not admit when another worker claims between the ledger read and claim", async () => {
		const ledger = authority();
		try {
			const deps = dependencies(ledger);
			const wrapped = { ...ledger };
			wrapped.claimExecution = (input) => {
				ledger.claimExecution(input); // A competing worker commits using the same prior sequence.
				return ledger.claimExecution(input);
			};
			deps.authority = wrapped;
			const decision = await admitIacTarget(
				{ requestId: "claim-race", ...fixture() },
				deps,
			);
			expect(decision).toMatchObject({
				status: "uncertain",
				code: "EXECUTION_CLAIM_UNCERTAIN",
				budget: { reservation: "held" },
			});
			expect(ledger.lookup("iac:claim-race")?.executionDigest).toMatch(
				/^sha256:/u,
			);
			expect(ledger.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			ledger.close();
		}
	});

	it("uses one durable request across target fallback and refuses a later duplicate", async () => {
		const ledger = authority(1_200_000);
		try {
			const first = fixture();
			const second = fixture();
			second.inventory.targetId = "yard-b";
			const repriced = quoteTargetPricing(second.inventory, second.pricing);
			if (!repriced.ok) throw new Error(repriced.reason);
			second.evidence.targetId = "yard-b";
			second.evidence.inventoryHash = repriced.inventoryHash;
			second.evidence.maximumMicros = 1_000_000;
			const account = second.evidence.providerAccounts[0];
			if (account === undefined) throw new Error("fixture account missing");
			account.liabilityMicros = 1_000_000;
			const deps = dependencies(ledger);
			expect(
				await admitIacTarget({ requestId: "shared-route", ...first }, deps),
			).toMatchObject({ status: "denied", code: "provider.exhausted" });
			expect(
				await admitIacTarget({ requestId: "shared-route", ...second }, deps),
			).toMatchObject({ status: "admitted" });
			expect(
				await admitIacTarget({ requestId: "shared-route", ...first }, deps),
			).toMatchObject({
				status: "uncertain",
				code: "RESERVATION_OUTCOME_UNKNOWN",
			});
			expect(
				await admitIacTarget({ requestId: "shared-route", ...second }, deps),
			).toMatchObject({ status: "replay", code: "EXECUTION_ALREADY_CLAIMED" });
			expect(ledger.read(NOW).reservedMicros).toBe(1_000_000);
		} finally {
			ledger.close();
		}
	});
});
