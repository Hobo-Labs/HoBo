import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Providers } from "@alchemy.run/rivet";
import { RunnerPool } from "@alchemy.run/rivet/Cloud";
import { create } from "@bufbuild/protobuf";
import {
	type IacProgram as CloudIacProgram,
	createInProcessExecutor,
	iacProgramFor,
} from "@hobo/cloud";
import { inMemoryState, Resource, Stack } from "alchemy";
import { layer } from "alchemy/Alchemist";
import { map } from "alchemy/Output";
import { collection, succeed } from "alchemy/Provider";
import { gen, sync } from "effect/Effect";
import { effect, provide } from "effect/Layer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createIacFinancialServices,
	createSqliteBudgetAdmissionAuthority,
	HostingPolicyProofSchema,
	type IacFinancialPlan,
	IacTargetLiabilityEvidenceSchema,
} from "../packages/broker/src/index.js";
import type { IacRoutePermit } from "../packages/dispatcher/src/iac-route.js";
import { createDirectRoutePort } from "../packages/dispatcher/src/iac-route.js";
import { createSqliteIacRouteAuthority } from "../packages/dispatcher/src/iac-route-sqlite.js";
import {
	executeRankedIacTargets,
	type IacRoutingAdmission,
	type IacRoutingExpectation,
	rankIacTargets,
} from "../packages/dispatcher/src/iac-target-routing.js";
import {
	AlchemyIacError,
	alchemyTarget,
	createAlchemyIacProvider,
	type IacProgram,
} from "../packages/iac/iac-alchemy/src/index.js";
import type {
	FinancialDecision,
	IacRouteContext,
} from "../packages/iac/iac-alchemy/src/port.js";
import {
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./iac-alchemy-pricing-fixture.js";

const NOW = "2026-01-02T00:00:00Z";
const END = "2026-01-31T23:59:59Z";
let dir = "";
let oldAlchemyHome: string | undefined;
let oldTelemetry: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hobo-alchemy-provider-"));
	oldAlchemyHome = process.env.ALCHEMY_HOME;
	oldTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
	process.env.ALCHEMY_HOME = join(dir, "auth");
	process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
});
afterEach(() => {
	if (oldAlchemyHome === undefined) delete process.env.ALCHEMY_HOME;
	else process.env.ALCHEMY_HOME = oldAlchemyHome;
	if (oldTelemetry === undefined) delete process.env.ALCHEMY_TELEMETRY_DISABLED;
	else process.env.ALCHEMY_TELEMETRY_DISABLED = oldTelemetry;
	rmSync(dir, { recursive: true, force: true });
});

type Demo = Resource<"Demo.Widget", { size: number }, { id: string }>;
const Widget = Resource<Demo>("Demo.Widget");
const testOperation = {
	operationId: `sha256:${"f".repeat(64)}`,
	authorization: "host:proof",
};
const testStateOwnership = {
	backendRef: "test:state",
	ownershipEpoch: "test:epoch",
	verify: () => true,
};
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

function executorProgram(value: IacProgram): CloudIacProgram {
	return {
		programId: value.programId,
		deploymentId: value.deploymentId,
		resourceId: value.resourceId,
		provider: value.provider,
		driver: value.driver,
		action: value.action,
		stackName: value.stackName,
		operationGeneration: value.operationGeneration ?? "generation-1",
	} satisfies CloudIacProgram;
}

function setup(
	options: {
		withPricing?: boolean;
		failApply?: boolean;
		badAdmission?: boolean;
		targetId?: string;
		stackName?: string;
		liabilityMicros?: number;
		size?: () => number;
		rivet?: boolean;
		output?: "resource" | "invalid" | "mapped";
		outputRegion?: () => boolean;
		workDir?: string;
	} = {},
) {
	const work = options.workDir ?? mkdtempSync(join(dir, "fixture-"));
	let applied = 0;
	let deleted = 0;
	let issued = 0;
	const operations: string[] = [];
	const rivetStack = Stack(
		options.stackName ?? "Demo",
		{
			providers: effect(Providers, collection([RunnerPool])).pipe(
				provide(
					succeed(RunnerPool, {
						reconcile: ({ news }) =>
							sync(() => {
								applied++;
								if (options.failApply)
									throw new Error("provider outcome unknown");
								return {
									name: "default",
									cluster: news.cluster,
									region: "test-region",
									buildId: "test-build",
									digest: "test-digest",
								};
							}),
						delete: () =>
							sync(() => {
								deleted++;
							}),
					}),
				),
			),
			state: inMemoryState(),
		},
		gen(function* () {
			const pool = yield* RunnerPool("runner", {
				cluster: "test-cluster",
				main: "./dist/node.mjs",
				rivetkitVersion: "3.0.0",
				machineType: "e2-small",
				nodeCount: 1,
				env: { RIVET_NAMESPACE: "test", RIVET_POOL: "default" },
			});
			if (options.output === "resource")
				return {
					poolName: options.outputRegion?.() ? pool.region : pool.name,
				};
			if (options.output === "mapped")
				return {
					poolName: map(pool.name, (name) => name.toUpperCase()),
				};
			if (options.output === "invalid") return { nodeCount: 1 };
			return {};
		}),
	);
	const widgetStack = Stack(
		options.stackName ?? "Demo",
		{
			providers: succeed(Widget, {
				reconcile: ({ news }) =>
					sync(() => {
						applied++;
						if (options.failApply) throw new Error("provider outcome unknown");
						return { id: `widget-${news.size}` };
					}),
				delete: () =>
					sync(() => {
						deleted++;
					}),
			}),
			state: inMemoryState(),
		},
		gen(function* () {
			yield* Widget("widget", { size: options.size?.() ?? 1 });
			return {};
		}),
	);
	const authority = createSqliteBudgetAdmissionAuthority({
		path: join(work, "budget.sqlite"),
		now: () => NOW,
		iacPricedSettlementTrust: { verify: () => true },
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
	});
	const target = alchemyTarget({
		targetId: options.targetId ?? "yard-a",
		tenantId: "tenant-a",
		stackName: options.stackName ?? "Demo",
		stage: "test",
		programResourceId: "application",
		sourceDigest: `sha256:${"a".repeat(64)}`,
		inventoryEvidenceRef: "inventory:1",
		resources: [
			{
				resourceId: options.rivet ? "runner" : "widget",
				resourceType: options.rivet ? "RivetCloud.RunnerPool" : "Demo.Widget",
				providerId: options.rivet ? "rivet-cloud" : "sandbox",
				providerAccountRef: "account-a",
				productId: options.rivet ? "runner-e2-small" : "sandbox",
			},
		],
	});
	const scenario = makeScenario({
		charges: [perUnitCharge("runtime", "minute", "0.25")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
	if (options.rivet) {
		const product = scenario.catalog?.products[0];
		const agreement = scenario.state?.agreements[0];
		const candidate = scenario.candidate[0];
		if (!product || !agreement || !candidate)
			throw new Error("fixture incomplete");
		product.id = "runner-e2-small";
		product.providerId = "rivet-cloud";
		agreement.productId = product.id;
		candidate.productRef = product.id;
		rehashScenario(scenario);
	}
	const pricing =
		options.withPricing === false
			? undefined
			: {
					modelId: "terms",
					revision: "1",
					scenario,
					bindings: [
						{
							resourceId: options.rivet ? "runner" : "widget",
							candidateIndex: 0,
						},
					],
				};
	const financial = createIacFinancialServices({
		...(pricing === undefined ? undefined : { pricing }),
		authority,
		now: () => NOW,
		verifyLiability: async () => true,
		issueLiability: async ({ inventory, priced }) => {
			issued++;
			operations.push(inventory.operation ?? "unknown");
			return create(IacTargetLiabilityEvidenceSchema, {
				evidenceRef: "bound:1",
				targetId: inventory.targetId,
				tenantId: inventory.tenantId,
				planDigest: inventory.planDigest,
				inventoryHash: priced.inventoryHash,
				modelHash: priced.modelHash,
				quoteHash: priced.quote.quoteHash,
				maximumMicros: options.liabilityMicros ?? 1_500_000,
				observedAt: "2026-01-01T00:00:00Z",
				validUntil: END,
				providerAccounts: [
					{
						providerAccountId: "account-a",
						liabilityMicros: options.liabilityMicros ?? 1_500_000,
					},
				],
			});
		},
		authorize: async ({ requestDigest, quote, identity }) => ({
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
	const routeAuthority = createSqliteIacRouteAuthority({
		path: join(work, "route.sqlite"),
		verifyOperation: () => true,
	});
	const route = createDirectRoutePort({
		authority: routeAuthority,
		hashInventory: (plan: IacFinancialPlan) => {
			const hash = financial.assess(plan).inventoryHash;
			if (!hash) throw new Error("inventory hash missing");
			return hash;
		},
	});
	const providerBase = {
		target,
		stateOwnership: testStateOwnership,
		composite: {
			proofRef: "test:integration",
			environmentDigest: `sha256:${"e".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: () => true,
		},
		route,
		resolveRoute: (context: IacRouteContext) => ({
			requestId: context.requestId ?? "integration-request",
			operation: testOperation,
		}),
		runtimeLayer: layer(),
		runtimeDirectory: join(work, "runtime"),
		financial: options.badAdmission
			? {
					...financial,
					admit: async (requestId: string) => ({
						requestId,
						targetId: "yard-a",
						status: "admitted",
						code: "",
						message: "",
						reservation: { reservationId: "fake" },
						budget: { evaluation: "unavailable", reservation: "unknown" },
					}),
				}
			: financial,
	};
	const provider = options.rivet
		? createAlchemyIacProvider({ ...providerBase, stack: rivetStack })
		: createAlchemyIacProvider({ ...providerBase, stack: widgetStack });
	return {
		provider,
		authority,
		routeAuthority,
		workDir: work,
		applied: () => applied,
		deleted: () => deleted,
		issued: () => issued,
		operations: () => operations,
	};
}

type SetupFixture = ReturnType<typeof setup>;
type RankedExecutionCall = Omit<
	Parameters<typeof executeRankedIacTargets>[0],
	"authority" | "tenantId" | "operation"
>;

function routingAdmission(
	requestId: string,
	expected: IacRoutingExpectation,
	admission: FinancialDecision,
): IacRoutingAdmission {
	if (admission.budget === undefined)
		throw new Error(`admission budget missing for ${requestId}`);
	const parsed = {
		requestId,
		targetId: expected.targetId,
		status: admission.status,
		code: admission.status === "admitted" ? "" : admission.code,
		message: admission.message ?? "",
		budget: admission.budget,
		inventoryHash: expected.inventoryHash,
		modelHash: expected.modelHash,
		quoteHash: expected.quoteHash,
	};
	return admission.reservation === undefined
		? parsed
		: { ...parsed, reservation: admission.reservation };
}

class RoutedApplyFailure extends Error {
	readonly code: string;
	readonly requiresReconciliation: boolean;
	readonly executionOutcome: "not-started" | "completed" | "unknown";
	readonly reservationId: string | undefined;
	readonly admission: IacRoutingAdmission | undefined;

	constructor(
		error: AlchemyIacError,
		admission: IacRoutingAdmission | undefined,
	) {
		super(error.message);
		this.name = "RoutedApplyFailure";
		this.code = error.code;
		this.requiresReconciliation = error.requiresReconciliation;
		this.executionOutcome = error.executionOutcome;
		this.reservationId = error.reservationId;
		this.admission = admission;
	}
}

function adaptProviderApply(
	provider: SetupFixture["provider"],
	iacProgram: IacProgram,
) {
	return async (
		requestId: string,
		expected: IacRoutingExpectation,
		_permit: IacRoutePermit,
	) => {
		try {
			const result = await provider.applyWithAdmission(
				iacProgram,
				requestId,
				expected,
				_permit,
			);
			return {
				outputs: result.outputs ?? {},
				admission: routingAdmission(requestId, expected, result.admission),
			};
		} catch (error) {
			if (error instanceof AlchemyIacError) {
				throw new RoutedApplyFailure(
					error,
					error.admission === undefined
						? undefined
						: routingAdmission(requestId, expected, error.admission),
				);
			}
			throw error;
		}
	};
}

async function executeRanked(
	fixture: SetupFixture,
	input: RankedExecutionCall,
) {
	return executeRankedIacTargets({
		...input,
		authority: fixture.routeAuthority,
		tenantId: "tenant-a",
		operation: testOperation,
		candidates: input.candidates.map((candidate) => ({
			targetId: candidate.targetId,
			run: candidate.run,
		})),
	});
}

describe("Alchemy IaC provider against the real library", () => {
	it("uses the RivetKit major required by the external Rivet provider", () => {
		const require = createRequire(
			new URL("../packages/iac/iac-alchemy/package.json", import.meta.url),
		);
		const rivet = JSON.parse(
			readFileSync(require.resolve("@alchemy.run/rivet/package.json"), "utf8"),
		);
		const runtime = JSON.parse(
			readFileSync(
				new URL(
					"../packages/runtimes/runtime-rivet/package.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		expect(rivet.dependencies.rivetkit).toEqual(expect.any(String));
		expect(runtime.dependencies.rivetkit).toEqual(expect.any(String));
		expect(runtime.dependencies["@rivetkit/rivetkit-wasm"]).toEqual(
			expect.any(String),
		);
		expect(rivet.dependencies.rivetkit).toBe(runtime.dependencies.rivetkit);
		expect(runtime.dependencies["@rivetkit/rivetkit-wasm"]).toBe(
			rivet.dependencies.rivetkit,
		);
	});

	it("returns the real Rivet resource output through the IaC provider", async () => {
		const fixture = setup({ rivet: true, output: "resource" });
		try {
			await fixture.provider.preview(program);
			const result = await fixture.provider.applyWithAdmission(program);
			expect(result.outputs).toEqual({ poolName: "default" });
			expect(fixture.applied()).toBe(1);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("passes Rivet outputs through HoBo's injected IaC executor", async () => {
		const fixture = setup({ rivet: true, output: "resource" });
		try {
			const result = await createInProcessExecutor({
				iac: fixture.provider,
			}).run(executorProgram(program), {
				id: "scoped-token",
				scope: "test",
				ttlSeconds: 60,
				ambient: false,
			});
			expect(result).toMatchObject({
				status: "succeeded",
				outputs: { poolName: "default" },
			});
			expect(fixture.applied()).toBe(1);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("accepts the program generated by HoBo's resource actor", async () => {
		const generated = {
			...iacProgramFor(
				"deployment-a",
				{
					name: "application",
					port: "compute",
					provider: "sandbox",
					deps: [],
				},
				"apply",
				"tenant-a",
			),
			operationGeneration: "generation-actor",
		};
		const fixture = setup({
			rivet: true,
			output: "resource",
		});
		try {
			const result = await createInProcessExecutor({
				iac: fixture.provider,
			}).run(generated, {
				id: "scoped-token",
				scope: "test",
				ttlSeconds: 60,
				ambient: false,
			});
			expect(result).toMatchObject({
				status: "succeeded",
				outputs: { poolName: "default" },
			});
			expect(fixture.applied()).toBe(1);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("tells HoBo's executor not to retry an applied resource with invalid outputs", async () => {
		const fixture = setup({ rivet: true, output: "invalid" });
		try {
			const result = await createInProcessExecutor({
				iac: fixture.provider,
			}).run(executorProgram(program), {
				id: "scoped-token",
				scope: "test",
				ttlSeconds: 60,
				ambient: false,
			});
			expect(result).toMatchObject({
				status: "failed",
				classification: "fatal",
				reason: expect.stringContaining("APPLY_OUTPUT_UNREPRESENTABLE"),
			});
			expect(fixture.applied()).toBe(1);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("binds Rivet output references into the reviewed plan", async () => {
		let region = false;
		const fixture = setup({
			rivet: true,
			output: "resource",
			outputRegion: () => region,
		});
		try {
			await fixture.provider.preview(program);
			region = true;
			await expect(fixture.provider.apply(program)).rejects.toMatchObject({
				code: "PLAN_CHANGED",
			});
			expect(fixture.applied()).toBe(0);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(0);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("surfaces mapped Rivet output strings only after the mapper returns", async () => {
		const fixture = setup({ rivet: true, output: "mapped" });
		try {
			await fixture.provider.preview(program);
			const outputs = await fixture.provider.apply(program);
			expect(outputs).toEqual({ poolName: "DEFAULT" });
			expect(fixture.applied()).toBe(1);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("reports an unsupported output after apply without releasing the budget or retrying", async () => {
		const fixture = setup({ rivet: true, output: "invalid" });
		try {
			await fixture.provider.preview(program);
			await expect(
				fixture.provider.applyWithAdmission(program),
			).rejects.toMatchObject({
				code: "APPLY_OUTPUT_UNREPRESENTABLE",
				requiresReconciliation: true,
				executionOutcome: "completed",
				reservationId: expect.stringMatching(/^iac:/u),
			});
			expect(fixture.applied()).toBe(1);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
			await expect(fixture.provider.apply(program)).rejects.toMatchObject({
				code: "EXECUTION_ALREADY_CLAIMED",
				requiresReconciliation: true,
				reservationId: expect.stringMatching(/^iac:/u),
			});
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("reports the held budget and completed Rivet apply when routing cannot represent outputs", async () => {
		const fixture = setup({ rivet: true, output: "invalid" });
		try {
			const assessed = await fixture.provider.assessPricing(program);
			if (
				assessed.pricing.state.case !== "model" ||
				assessed.pricing.state.value.scenario === undefined
			)
				throw new Error("Rivet model missing");
			const { at, horizon, action } = assessed.pricing.state.value.scenario;
			const ranking = rankIacTargets({
				tenantId: "tenant-a",
				workloadRef: "rivet",
				at,
				horizon,
				action,
				candidates: [
					{
						workloadRef: "rivet",
						inventory: assessed.inventory,
						pricing: assessed.pricing,
					},
				],
			});
			const result = await executeRanked(fixture, {
				requestId: "rivet-output",
				ranking,
				candidates: [
					{
						targetId: "yard-a",
						run: adaptProviderApply(fixture.provider, program),
					},
				],
			});
			expect(result).toMatchObject({
				status: "uncertain",
				code: "APPLY_OUTPUT_UNREPRESENTABLE",
				executionOutcome: "completed",
				reservationId: "iac:rivet-output",
				budget: { evaluation: "allowed", reservation: "held" },
			});
			expect(fixture.applied()).toBe(1);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("assesses a real Rivet Cloud resource without inventing a price", async () => {
		const fixture = setup({ rivet: true, withPricing: false });
		try {
			const assessment = await fixture.provider.assessPricing(program);
			expect(assessment).toMatchObject({
				inventory: {
					complete: true,
					resources: [{ resourceId: "runner", providerId: "rivet-cloud" }],
				},
				pricing: { state: { case: "unavailable" } },
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
				diff: { changes: 1 },
			});
			await expect(fixture.provider.apply(program)).rejects.toMatchObject({
				code: "PRICING_MODEL_UNAVAILABLE",
				admission: {
					budget: { evaluation: "unavailable", reservation: "not-created" },
				},
			});
			expect(fixture.applied()).toBe(0);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(0);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("admits a real Rivet Cloud resource when a complete model and trusted bound are supplied", async () => {
		const fixture = setup({ rivet: true });
		try {
			const assessment = await fixture.provider.assessPricing(program);
			expect(assessment.quote).toMatchObject({ ok: true });
			const result = await fixture.provider.applyWithAdmission(program);
			expect(result.admission).toMatchObject({
				status: "admitted",
				budget: { evaluation: "allowed", reservation: "held" },
			});
			expect(fixture.applied()).toBe(1);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("routes around an unpriced Rivet target and reserves only the priced target", async () => {
		const unknown = setup({
			rivet: true,
			withPricing: false,
			targetId: "yard-unknown",
		});
		const priced = setup({ rivet: true, targetId: "yard-priced" });
		try {
			const a = await unknown.provider.assessPricing(program);
			const b = await priced.provider.assessPricing(program);
			if (
				b.pricing.state.case !== "model" ||
				b.pricing.state.value.scenario === undefined
			)
				throw new Error("priced Rivet model missing");
			const { at, horizon, action } = b.pricing.state.value.scenario;
			const ranking = rankIacTargets({
				tenantId: "tenant-a",
				workloadRef: "rivet-workload",
				at,
				horizon,
				action,
				candidates: [
					{
						workloadRef: "rivet-workload",
						inventory: a.inventory,
						pricing: a.pricing,
					},
					{
						workloadRef: "rivet-workload",
						inventory: b.inventory,
						pricing: b.pricing,
					},
				],
			});
			expect(ranking).toMatchObject({
				coverage: "partial",
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
				ranking: [{ targetId: "yard-priced" }],
				rejected: [
					{ targetId: "yard-unknown", code: "PRICING_MODEL_UNAVAILABLE" },
				],
			});
			expect(priced.authority.read(NOW).reservedMicros).toBe(0);
			const routed = await executeRanked(priced, {
				requestId: "rivet-route",
				ranking,
				candidates: [
					{
						targetId: "yard-priced",
						run: adaptProviderApply(priced.provider, program),
					},
				],
			});
			expect(routed).toMatchObject({
				status: "selected",
				targetId: "yard-priced",
				budget: { evaluation: "allowed", reservation: "held" },
			});
			expect(unknown.applied()).toBe(0);
			expect(priced.applied()).toBe(1);
			expect(priced.authority.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			unknown.routeAuthority.close();
			unknown.authority.close();
			priced.routeAuthority.close();
			priced.authority.close();
		}
	});

	it("previews, reserves and applies the same scoped plan once", async () => {
		const fixture = setup();
		try {
			expect(await fixture.provider.preview(program)).toMatchObject({
				changes: 1,
			});
			await fixture.provider.applyWithAdmission(program, "scoped-once");
			expect(fixture.applied()).toBe(1);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
			await fixture.provider.preview(program);
			await expect(
				fixture.provider.applyWithAdmission(program, "scoped-once"),
			).rejects.toMatchObject({
				code: "ROUTE_ALREADY_FINISHED",
			});
			expect(fixture.applied()).toBe(1);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("blocks a replayed route once the durable SQLite route finished", async () => {
		const fixture = setup();
		try {
			await fixture.provider.preview(program);
			await fixture.provider.applyWithAdmission(program, "claimed-once");
			await fixture.provider.preview(program);
			await expect(
				fixture.provider.applyWithAdmission(program, "claimed-once"),
			).rejects.toMatchObject({
				code: "ROUTE_ALREADY_FINISHED",
			});
			expect(fixture.applied()).toBe(1);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("refuses unpriced targets before invoking the provider", async () => {
		const fixture = setup({ withPricing: false });
		try {
			await fixture.provider.preview(program);
			await expect(fixture.provider.apply(program)).rejects.toMatchObject({
				code: "PRICING_MODEL_UNAVAILABLE",
				admission: {
					status: "denied",
					budget: { evaluation: "unavailable", reservation: "not-created" },
				},
			});
			expect(fixture.applied()).toBe(0);
			expect(fixture.issued()).toBe(0);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(0);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("exposes target pricing coverage for routing before admission", async () => {
		const fixture = setup({ withPricing: false });
		try {
			const assessed = await fixture.provider.assessPricing(program);
			expect(assessed).toMatchObject({
				inventory: { targetId: "yard-a", complete: true },
				pricing: { state: { case: "unavailable" } },
				quote: { ok: false, code: "PRICING_MODEL_UNAVAILABLE" },
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
			expect(fixture.issued()).toBe(0);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("ranks an assessed target and applies it only after budget admission", async () => {
		const fixture = setup();
		try {
			const assessed = await fixture.provider.assessPricing(program);
			if (
				assessed.pricing.state.case !== "model" ||
				assessed.pricing.state.value.scenario === undefined
			)
				throw new Error("pricing missing");
			const { at, horizon, action } = assessed.pricing.state.value.scenario;
			const ranking = rankIacTargets({
				tenantId: "tenant-a",
				workloadRef: "workload:1",
				action,
				at,
				horizon,
				candidates: [
					{
						workloadRef: "workload:1",
						inventory: assessed.inventory,
						pricing: assessed.pricing,
					},
				],
			});
			expect(ranking).toMatchObject({
				coverage: "complete",
				ranking: [{ targetId: "yard-a" }],
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
			expect(fixture.authority.read(NOW).reservedMicros).toBe(0);
			const routed = await executeRanked(fixture, {
				requestId: "route-1",
				ranking,
				candidates: [
					{
						targetId: "yard-a",
						run: adaptProviderApply(fixture.provider, program),
					},
				],
			});
			expect(routed).toMatchObject({
				status: "selected",
				targetId: "yard-a",
				budget: { evaluation: "allowed", reservation: "held" },
			});
			expect(fixture.applied()).toBe(1);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("falls back between real plans under one shared budget without a duplicate apply", async () => {
		const sharedWork = mkdtempSync(join(dir, "shared-route-"));
		const first = setup({
			targetId: "yard-a",
			liabilityMicros: 3_500_000,
			workDir: sharedWork,
		});
		const second = setup({
			targetId: "yard-b",
			liabilityMicros: 1_500_000,
			workDir: sharedWork,
		});
		try {
			const a = await first.provider.assessPricing(program);
			const b = await second.provider.assessPricing(program);
			if (
				a.pricing.state.case !== "model" ||
				a.pricing.state.value.scenario === undefined
			)
				throw new Error("pricing missing");
			const { at, horizon, action } = a.pricing.state.value.scenario;
			const ranking = rankIacTargets({
				tenantId: "tenant-a",
				workloadRef: "workload:1",
				at,
				horizon,
				action,
				candidates: [
					{
						workloadRef: "workload:1",
						inventory: a.inventory,
						pricing: a.pricing,
					},
					{
						workloadRef: "workload:1",
						inventory: b.inventory,
						pricing: b.pricing,
					},
				],
			});
			const route = () =>
				executeRanked(first, {
					requestId: "shared-route",
					ranking,
					candidates: [
						{
							targetId: "yard-a",
							run: adaptProviderApply(first.provider, program),
						},
						{
							targetId: "yard-b",
							run: adaptProviderApply(second.provider, program),
						},
					],
				});
			expect(await route()).toMatchObject({
				status: "selected",
				targetId: "yard-b",
				attempts: [
					{ targetId: "yard-a", status: "denied", code: "provider.exhausted" },
					{ targetId: "yard-b", status: "admitted" },
				],
			});
			expect(first.applied()).toBe(0);
			expect(second.applied()).toBe(1);
			expect(await route()).toMatchObject({
				status: "replay",
			});
			expect(second.applied()).toBe(1);
			expect(first.authority.read(NOW).reservedMicros).toBe(1_500_000);
			expect(second.authority.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			first.routeAuthority.close();
			first.authority.close();
			second.routeAuthority.close();
			second.authority.close();
		}
	});

	it("does not let a caller mutate the provider's stored pricing model through an assessment", async () => {
		const fixture = setup();
		try {
			const assessed = await fixture.provider.assessPricing(program);
			if (
				assessed.pricing.state.case !== "model" ||
				assessed.pricing.state.value.scenario === undefined
			)
				throw new Error("pricing missing");
			const quantity =
				assessed.pricing.state.value.scenario.candidate[0]?.usage[0]?.quantity;
			if (quantity === undefined) throw new Error("quantity missing");
			quantity.decimal = "999999";
			await fixture.provider.apply(program);
			expect(fixture.applied()).toBe(1);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
			const reassessed = await fixture.provider.assessPricing(program);
			if (
				reassessed.pricing.state.case !== "model" ||
				reassessed.pricing.state.value.scenario === undefined
			)
				throw new Error("pricing missing after re-assessment");
			const stored =
				reassessed.pricing.state.value.scenario.candidate[0]?.usage[0]
					?.quantity;
			expect(stored?.decimal).toBe("4");
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("refuses a changed routing quote before issuing liability or reserving", async () => {
		const fixture = setup();
		try {
			const assessment = await fixture.provider.assessPricing(program);
			if (!assessment.quote.ok) throw new Error("pricing missing");
			await expect(
				fixture.provider.applyWithAdmission(program, "stale-route", {
					targetId: "yard-a",
					inventoryHash: assessment.quote.inventoryHash,
					modelHash: `sha256:${"b".repeat(64)}`,
					quoteHash: assessment.quote.quote.quoteHash,
				}),
			).rejects.toMatchObject({
				code: "ROUTING_QUOTE_CHANGED",
				admission: {
					budget: { evaluation: "unavailable", reservation: "not-created" },
				},
			});
			expect(fixture.issued()).toBe(0);
			expect(fixture.applied()).toBe(0);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(0);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("refuses a changed plan before reserving or applying", async () => {
		let size = 1;
		const fixture = setup({ size: () => size });
		try {
			await fixture.provider.preview(program);
			size = 2;
			await expect(fixture.provider.apply(program)).rejects.toMatchObject({
				code: "PLAN_CHANGED",
			});
			expect(fixture.applied()).toBe(0);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(0);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("retains the financial exposure when apply fails", async () => {
		const fixture = setup({ failApply: true });
		try {
			await fixture.provider.preview(program);
			const error = await fixture.provider
				.apply(program)
				.catch((value) => value);
			expect(error).toMatchObject({
				code: "APPLY_OUTCOME_UNKNOWN",
				reservationId: expect.stringMatching(/^iac:/u),
			});
			if (
				!(error instanceof AlchemyIacError) ||
				error.reservationId === undefined
			)
				throw new Error("reservation id missing");
			expect(fixture.authority.lookup(error.reservationId)?.status).toBe(
				"uncertain",
			);
			expect(fixture.applied()).toBe(1);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("never applies a preview-only program", async () => {
		const fixture = setup();
		try {
			const previewOnly = { ...program, action: "preview" as const };
			await fixture.provider.preview(previewOnly);
			await expect(fixture.provider.apply(previewOnly)).rejects.toMatchObject({
				code: "PREVIEW_ONLY",
			});
			expect(fixture.applied()).toBe(0);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(0);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("refuses an admission receipt that does not assert a held budget", async () => {
		const fixture = setup({ badAdmission: true });
		try {
			await fixture.provider.preview(program);
			await expect(fixture.provider.apply(program)).rejects.toMatchObject({
				code: "ADMISSION_RECEIPT_INVALID",
			});
			expect(fixture.applied()).toBe(0);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("does not claim an unchecked resource is in sync", async () => {
		const fixture = setup();
		try {
			await fixture.provider.preview(program);
			await fixture.provider.apply(program);
			await expect(fixture.provider.refresh(program)).rejects.toMatchObject({
				code: "DRIFT_CHECK_INCOMPLETE",
			});
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});

	it("previews destroy inventory after a financially admitted deploy", async () => {
		const fixture = setup();
		try {
			await fixture.provider.preview(program);
			await fixture.provider.applyWithAdmission(
				program,
				"deploy-destroy-setup",
			);
			const destroy = {
				...program,
				programId: "destroy-1",
				action: "destroy" as const,
				operationGeneration: "generation-destroy",
			};
			expect((await fixture.provider.preview(destroy)).changes).toBe(1);
			expect(fixture.deleted()).toBe(0);
			expect(fixture.operations()).toEqual(["deploy"]);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			fixture.routeAuthority.close();
			fixture.authority.close();
		}
	});
});
