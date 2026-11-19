import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createIacFinancialServices,
	createSqliteBudgetAdmissionAuthority,
	HostingPolicyProofSchema,
	type IacFinancialServicesOptions,
	IacTargetLiabilityEvidenceSchema,
	type IacUnpricedAuthorizationInput,
	IacUnpricedPolicyProofSchema,
	IacUnpricedScopeProofSchema,
} from "../../../broker/src/index.js";
import { createDirectRoutePort } from "../../../dispatcher/src/iac-route.js";
import { createSqliteIacRouteAuthority } from "../../../dispatcher/src/iac-route-sqlite.js";
import { rankIacTargets } from "../../../dispatcher/src/iac-target-routing.js";
import {
	makeScenario,
	perUnitCharge,
	usage,
	workload,
} from "../../../pricing/test/fixtures.js";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	type IacProgram,
} from "../src/index.js";
import { testStateOwnership } from "./route-fixture.js";

const NOW = "2026-01-02T00:00:00Z";
const END = "2026-01-31T23:59:59Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
type Widget = Resource<"Demo.Widget", { size: number }, { id: string }>;
const Widget = Resource<Widget>("Demo.Widget");
const program: IacProgram = {
	programId: "run-1",
	deploymentId: "deployment-a",
	resourceId: "application",
	provider: "sandbox",
	driver: "external",
	action: "apply",
	stackName: "Demo",
	operationGeneration: "generation-1",
};
let directory = "";
let previousHome: string | undefined;
let previousTelemetry: string | undefined;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "hobo-alchemy-budget-"));
	previousHome = process.env.ALCHEMY_HOME;
	previousTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
	process.env.ALCHEMY_HOME = join(directory, "auth");
	process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
});
afterEach(() => {
	if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
	else process.env.ALCHEMY_HOME = previousHome;
	if (previousTelemetry === undefined)
		delete process.env.ALCHEMY_TELEMETRY_DISABLED;
	else process.env.ALCHEMY_TELEMETRY_DISABLED = previousTelemetry;
	rmSync(directory, { recursive: true, force: true });
});

function fixture(withPricing: boolean, allowUnpriced = false) {
	let effects = 0;
	let liabilityRequests = 0;
	let exposureAtEffect:
		| { reservedMicros: number; unbounded: number }
		| undefined;
	const stack = Stack(
		"Demo",
		{
			providers: Provider.succeed(Widget, {
				reconcile: ({ news }) =>
					Effect.sync(() => {
						effects++;
						const snapshot = authority.read(NOW);
						exposureAtEffect = {
							reservedMicros: snapshot.reservedMicros,
							unbounded: snapshot.unboundedExposureCount,
						};
						return { id: `widget-${news.size}` };
					}),
				delete: () => Effect.void,
			}),
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			yield* Widget("widget", { size: 1 });
			return {};
		}),
	);
	const authorityOptions: Parameters<
		typeof createSqliteBudgetAdmissionAuthority
	>[0] = {
		path: join(directory, "budget.sqlite"),
		now: () => NOW,
		iacPricedSettlementTrust: { verify: () => false },
		unpricedScopeTrust: {
			verify: (proof) => proof.signature === "scope-signature",
			isCurrent: (proof) => proof.signature === "scope-signature",
			settlement: () => false,
		},
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant-a",
				budgetId: "hosting",
				periodId: "2026-01",
				policyRevision: "r1",
			},
			limitMicros: 3_000_000,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: END,
			providerAccounts: [
				create(BudgetProviderAccountSchema, {
					providerAccountId: "account-a",
					limitMicros: 3_000_000,
				}),
			],
		}),
	};
	const authority = createSqliteBudgetAdmissionAuthority(authorityOptions);
	const scenario = makeScenario({
		charges: [perUnitCharge("runtime", "minute", "0.25")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
	const authorizeUnpriced = (input: IacUnpricedAuthorizationInput) => ({
		gate: { effect: "allow" as const, reasons: [], events: [] },
		proof: create(IacUnpricedPolicyProofSchema, {
			requestDigest: input.requestDigest,
			inventoryHash: input.inventoryHash,
			identity: input.identity,
			policyHash: "policy:1",
			effect: "allow",
			evidenceRef: "unpriced-approval:1",
			obligationsSatisfied: true,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: END,
		}),
		scopeProof: create(IacUnpricedScopeProofSchema, {
			identity: input.identity,
			providerAccountIds: ["account-a"],
			authorityRef: "scope-authority",
			evidenceRef: "exclusive:1",
			ownershipEpoch: "epoch:1",
			observedAt: "2026-01-01T00:00:00Z",
			exclusiveUntilSettled: true,
			noSharedEntitlements: true,
			signature: "scope-signature",
		}),
	});
	const financialOptions: IacFinancialServicesOptions = {
		authority,
		now: () => NOW,
		verifyLiability: () => true,
		issueLiability: ({ inventory, priced }) => {
			liabilityRequests++;
			return create(IacTargetLiabilityEvidenceSchema, {
				evidenceRef: "bound:1",
				targetId: inventory.targetId,
				tenantId: inventory.tenantId,
				planDigest: inventory.planDigest,
				inventoryHash: priced.inventoryHash,
				modelHash: priced.modelHash,
				quoteHash: priced.quote.quoteHash,
				maximumMicros: 1_500_000,
				observedAt: "2026-01-01T00:00:00Z",
				validUntil: END,
				providerAccounts: [
					{ providerAccountId: "account-a", liabilityMicros: 1_500_000 },
				],
			});
		},
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
	};
	const configuredOptions: IacFinancialServicesOptions = allowUnpriced
		? { ...financialOptions, unpriced: { authorize: authorizeUnpriced } }
		: financialOptions;
	const financial = createIacFinancialServices(
		withPricing
			? {
					...configuredOptions,
					pricing: {
						modelId: "terms",
						revision: "1",
						scenario,
						bindings: [{ resourceId: "widget", candidateIndex: 0 }],
					},
				}
			: configuredOptions,
	);
	const routeAuthority = createSqliteIacRouteAuthority({
		path: join(directory, "route.sqlite"),
		verifyOperation: () => true,
	});
	const route = createDirectRoutePort({
		authority: routeAuthority,
		hashInventory: (plan: Parameters<typeof financial.assess>[0]) => {
			const hash = financial.assess(plan).inventoryHash;
			if (!hash) throw new Error("inventory hash missing");
			return hash;
		},
	});
	const provider = createAlchemyIacProvider<
		Record<string, never>,
		Provider.Provider<Widget>,
		ReturnType<typeof financial.assess>
	>({
		stack,
		target: alchemyTarget({
			targetId: "yard-a",
			tenantId: "tenant-a",
			stackName: "Demo",
			stage: "test",
			programResourceId: "application",
			sourceDigest: DIGEST,
			inventoryEvidenceRef: "inventory:1",
			resources: [
				{
					resourceId: "widget",
					resourceType: "Demo.Widget",
					providerId: "sandbox",
					providerAccountRef: "account-a",
					productId: "sandbox",
				},
			],
		}),
		stateOwnership: testStateOwnership,
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: join(directory, "runtime"),
		route,
		resolveRoute: ({ requestId }) => ({
			requestId: requestId ?? "request-1",
			operation: {
				operationId: `sha256:${"f".repeat(64)}`,
				authorization: "host:proof",
			},
		}),
		composite: {
			proofRef: "host:fixture",
			environmentDigest: `sha256:${"e".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: ({ scope, effects, sourceClaims }) =>
				scope.length === 1 && effects.length === 0 && sourceClaims.length === 0,
		},
		financial,
	});
	return {
		provider,
		authority,
		routeAuthority,
		scenario,
		reopenAuthority: () =>
			createSqliteBudgetAdmissionAuthority(authorityOptions),
		effects: () => effects,
		exposureAtEffect: () => exposureAtEffect,
		liabilityRequests: () => liabilityRequests,
	};
}

describe("external Alchemy pricing with the HoBo budget authority", () => {
	it("ranks a supplied model before reserving its verified liability for apply", async () => {
		const f = fixture(true);
		try {
			const assessment = await f.provider.assessPricing(program);
			if (
				assessment.pricing.state.case !== "model" ||
				!assessment.pricing.state.value.scenario
			)
				throw new Error("pricing missing");
			const { action, at, horizon } = assessment.pricing.state.value.scenario;
			const ranking = rankIacTargets({
				tenantId: "tenant-a",
				workloadRef: "workload:1",
				action,
				at,
				horizon,
				candidates: [
					{
						workloadRef: "workload:1",
						inventory: assessment.inventory,
						pricing: assessment.pricing,
					},
				],
			});
			expect(ranking).toMatchObject({
				coverage: "complete",
				ranking: [{ targetId: "yard-a" }],
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
			expect(f.authority.read(NOW).reservedMicros).toBe(0);
			const selected = ranking.ranking[0];
			if (!selected) throw new Error("ranking missing");
			const { targetId, inventoryHash, modelHash, quoteHash } = selected;
			const result = await f.provider.applyWithAdmission(program, "request-1", {
				targetId,
				inventoryHash,
				modelHash,
				quoteHash,
			});
			expect(result.admission).toMatchObject({
				status: "admitted",
				budget: { evaluation: "allowed", reservation: "held" },
			});
			expect(f.effects()).toBe(1);
			expect(f.exposureAtEffect()).toEqual({
				reservedMicros: 1_500_000,
				unbounded: 0,
			});
			expect(f.authority.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			f.authority.close();
			f.routeAuthority.close();
		}
	});

	it("excludes unknown pricing from ranking but permits explicit unpriced admission with a durable exposure hold", async () => {
		const f = fixture(false, true);
		try {
			const assessment = await f.provider.assessPricing(program);
			const { action, at, horizon } = f.scenario;
			const ranking = rankIacTargets({
				tenantId: "tenant-a",
				workloadRef: "workload:1",
				action,
				at,
				horizon,
				candidates: [
					{
						workloadRef: "workload:1",
						inventory: assessment.inventory,
						pricing: assessment.pricing,
					},
				],
			});
			expect(ranking).toMatchObject({
				ranking: [],
				rejected: [{ targetId: "yard-a", code: "PRICING_MODEL_UNAVAILABLE" }],
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
			const result = await f.provider.applyWithAdmission(program, "request-1");
			expect(result.admission).toMatchObject({
				status: "admitted",
				budget: { evaluation: "bypassed", reservation: "held" },
				reservation: { unboundedExposure: true },
			});
			expect(f.liabilityRequests()).toBe(0);
			expect(f.effects()).toBe(1);
			expect(f.exposureAtEffect()).toEqual({ reservedMicros: 0, unbounded: 1 });
			expect(f.authority.read(NOW).unboundedExposureCount).toBe(1);
			const reopened = f.reopenAuthority();
			try {
				expect(reopened.read(NOW).unboundedExposureCount).toBe(1);
			} finally {
				reopened.close();
			}
		} finally {
			f.authority.close();
			f.routeAuthority.close();
		}
	});

	it("denies an unavailable model before liability, budget reservation or provider effects", async () => {
		const f = fixture(false);
		try {
			const assessment = await f.provider.assessPricing(program);
			expect(assessment).toMatchObject({
				pricing: { state: { case: "unavailable" } },
				quote: { ok: false, code: "PRICING_MODEL_UNAVAILABLE" },
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
			await expect(f.provider.apply(program)).rejects.toMatchObject({
				code: "PRICING_MODEL_UNAVAILABLE",
				admission: {
					status: "denied",
					budget: { evaluation: "unavailable", reservation: "not-created" },
				},
			});
			expect(f.liabilityRequests()).toBe(0);
			expect(f.authority.read(NOW).reservedMicros).toBe(0);
			expect(f.effects()).toBe(0);
		} finally {
			f.authority.close();
			f.routeAuthority.close();
		}
	});
});
