import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Providers } from "@alchemy.run/rivet";
import { RunnerPool } from "@alchemy.run/rivet/Cloud";
import { create } from "@bufbuild/protobuf";
import {
	type IacProgram as CloudIacProgram,
	createInProcessCredentialBroker,
	createInProcessExecutor,
	destroyResource,
	iacProgramFor,
	reconcileResource,
} from "@hobo/cloud";
import { inMemoryState, Resource, Stack } from "alchemy";
import { layer } from "alchemy/Alchemist";
import { map } from "alchemy/Output";
import {
	type Provider as AlchemyProvider,
	collection,
	succeed,
} from "alchemy/Provider";
import { gen, isEffect, sync } from "effect/Effect";
import { effect, provide } from "effect/Layer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindle } from "../packages/bindles/dist/index.js";
import { CATALOG_ROWS } from "../packages/bindles/dist/types.js";
import {
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createIacFinancialServices,
	createSqliteBudgetAdmissionAuthority,
	HostingPolicyProofSchema,
	type IacFinancialPlan,
	type IacTargetAdmissionDecision,
	IacTargetLiabilityEvidenceSchema,
} from "../packages/broker/src/index.js";
import { createInMemoryActorHost } from "../packages/data/src/actor-host.js";
import {
	createDirectRoutePort,
	type IacRoutePermit,
} from "../packages/dispatcher/src/iac-route.js";
import { createSqliteIacRouteAuthority } from "../packages/dispatcher/src/iac-route-sqlite.js";
import {
	executeRankedIacTargets,
	type IacRoutingAdmission,
	type IacRoutingExpectation,
	rankIacTargets,
} from "../packages/dispatcher/src/iac-target-routing.js";
import {
	type AlchemyCompositeEnvironment,
	type AlchemyCompositeObservation,
	AlchemyIacError,
	type AlchemyPrimitiveMapper,
	type AlchemyStateOwnershipCheck,
	alchemyTarget,
	captureAlchemyProgram,
	createAlchemyIacProvider,
	describeAlchemyPrimitiveSupport,
	type IacProgram,
	type IacRouteContext,
	mapBindleToAlchemy,
} from "../packages/iac/iac-alchemy/src/index.js";
import type { FinancialDecision } from "../packages/iac/iac-alchemy/src/port.js";
import { createRuntimeLocalEventStore } from "../packages/runtimes/runtime-local/src/eventstore/eventstore.js";
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
const routeAuthorities: { close(): void }[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hobo-alchemy-provider-"));
	oldAlchemyHome = process.env.ALCHEMY_HOME;
	oldTelemetry = process.env.ALCHEMY_TELEMETRY_DISABLED;
	process.env.ALCHEMY_HOME = join(dir, "auth");
	process.env.ALCHEMY_TELEMETRY_DISABLED = "1";
});
afterEach(() => {
	for (const authority of routeAuthorities.splice(0)) authority.close();
	if (oldAlchemyHome === undefined) delete process.env.ALCHEMY_HOME;
	else process.env.ALCHEMY_HOME = oldAlchemyHome;
	if (oldTelemetry === undefined) delete process.env.ALCHEMY_TELEMETRY_DISABLED;
	else process.env.ALCHEMY_TELEMETRY_DISABLED = oldTelemetry;
	rmSync(dir, { recursive: true, force: true });
});

type Demo = Resource<"Demo.Widget", { size: number }, { id: string }>;
const Widget = Resource<Demo>("Demo.Widget");
const program = {
	programId: "run-1",
	deploymentId: "deployment-a",
	resourceId: "application",
	provider: "sandbox",
	driver: "external",
	action: "apply" as const,
	stackName: "Demo",
	operationGeneration: "generation-1",
} satisfies IacProgram;

function resolveRoute(context: IacRouteContext) {
	const { requestId, ...logicalOperation } = context;
	const operationId = `sha256:${createHash("sha256").update(JSON.stringify(logicalOperation)).digest("hex")}`;
	const resolvedRequest = requestId ?? `request:${operationId.slice(7)}`;
	return {
		requestId: resolvedRequest,
		operation: {
			operationId,
			authorization: `test-authority:${resolvedRequest}:${operationId}`,
		},
	};
}

function routeFor(input: IacProgram, requestId: string) {
	if (input.operationGeneration === undefined)
		throw new Error("generation missing");
	return resolveRoute({
		tenantId: "tenant-a",
		deploymentId: input.deploymentId,
		programId: input.programId,
		resourceId: input.resourceId,
		logicalStackName: input.stackName,
		declarationDigest: captureAlchemyProgram(input).declarationDigest,
		operation: input.action === "destroy" ? "destroy" : "deploy",
		operationGeneration: input.operationGeneration,
		requestId,
	});
}

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
		unreadableReceipt?: boolean;
		loseAdmissionResponse?: boolean;
		beforeAdmission?: () => Promise<void>;
		onReceipt?: (receipt: IacTargetAdmissionDecision) => void;
		targetId?: string;
		stackName?: string;
		liabilityMicros?: number;
		size?: () => number;
		rivet?: boolean;
		output?: "resource" | "invalid" | "mapped";
		outputRegion?: () => boolean;
		onRoute?: (context: IacRouteContext) => void;
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
		// This fixture never settles: its verifier refuses all settlement claims.
		iacPricedSettlementTrust: { verify: () => false },
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
	const destroyScenario = structuredClone(scenario);
	destroyScenario.action = "destroy";
	destroyScenario.destroyCancelsAgreement = false;
	const bindings = [
		{
			resourceId: options.rivet ? "runner" : "widget",
			candidateIndex: 0,
		},
	];
	const pricing =
		options.withPricing === false
			? undefined
			: {
					modelId: "terms",
					revision: "1",
					scenario,
					bindings,
				};
	const destroyPricing =
		options.withPricing === false
			? undefined
			: {
					modelId: "destroy-terms",
					revision: "1",
					scenario: destroyScenario,
					bindings,
				};
	const financial = createIacFinancialServices({
		...(pricing === undefined ? undefined : { pricing }),
		...(destroyPricing === undefined ? undefined : { destroyPricing }),
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
		verifyOperation: ({ tenantId, requestId, operationId, authorization }) =>
			tenantId === "tenant-a" &&
			authorization === `test-authority:${requestId}:${operationId}`,
	});
	routeAuthorities.push(routeAuthority);
	const route = createDirectRoutePort({
		authority: routeAuthority,
		hashInventory: (plan: IacFinancialPlan) => {
			const hash = financial.assess(plan).inventoryHash;
			if (hash === undefined) throw new Error("inventory hash missing");
			return hash;
		},
	});
	const recognizesScope = (scope: AlchemyCompositeEnvironment["scope"]) => {
		const item = scope[0];
		return (
			scope.length === 1 &&
			item?.resourceId === (options.rivet ? "runner" : "widget") &&
			item.resourceType ===
				(options.rivet ? "RivetCloud.RunnerPool" : "Demo.Widget") &&
			item.providerId === (options.rivet ? "rivet-cloud" : "sandbox") &&
			item.providerAccountRef === "account-a" &&
			item.productId === (options.rivet ? "runner-e2-small" : "sandbox")
		);
	};
	let fixtureOwner: string | undefined;
	const providerBase = {
		target,
		stateOwnership: {
			backendRef: `test:state:${options.targetId ?? "yard-a"}`,
			ownershipEpoch: "test:epoch",
			verify: ({
				tenantId,
				targetId,
				sourceDigest,
				program: logical,
				state,
			}: AlchemyStateOwnershipCheck) => {
				const expectedLogical =
					logical.programId === "run-1"
						? logical.logicalStackName === "Demo" &&
							logical.driver === "external" &&
							logical.declarationPresence === "absent"
						: logical.programId === "deployment-a:application" &&
							logical.logicalStackName ===
								"tenant-a/deployment-a/application" &&
							logical.driver === "pulumi" &&
							logical.declarationPresence === "present" &&
							JSON.stringify(logical.resource) ===
								JSON.stringify({
									name: "application",
									port: "compute",
									provider: "sandbox",
									deps: [],
								});
				if (
					tenantId !== "tenant-a" ||
					targetId !== (options.targetId ?? "yard-a") ||
					sourceDigest !== `sha256:${"a".repeat(64)}` ||
					logical.deploymentId !== "deployment-a" ||
					logical.resourceId !== "application" ||
					logical.provider !== "sandbox" ||
					!expectedLogical ||
					state.scopeKey !==
						`${(options.stackName ?? "Demo").toLowerCase()}/test`
				)
					return false;
				const owner = JSON.stringify({ tenantId, program: logical });
				if (fixtureOwner === undefined) fixtureOwner = owner;
				return fixtureOwner === owner;
			},
		},
		route,
		resolveRoute: (context: IacRouteContext) => {
			options.onRoute?.(context);
			return resolveRoute(context);
		},
		composite: {
			proofRef: "host:fixture-attestation",
			environmentDigest: `sha256:${"e".repeat(64)}`,
			// The test RunnerPool provider never reads or builds `main`. A real
			// source-building host must independently attest and list its sources.
			sourceRequirements: [],
			verifyEnvironment: (input: AlchemyCompositeEnvironment) =>
				input.tenantId === "tenant-a" &&
				input.targetId === (options.targetId ?? "yard-a") &&
				input.sourceDigest === `sha256:${"a".repeat(64)}` &&
				recognizesScope(input.scope),
			verifyPlan: (input: AlchemyCompositeObservation) =>
				recognizesScope(input.scope) &&
				input.effects.length === 0 &&
				input.sourceClaims.length === 0,
		},
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
			: {
					...financial,
					admit: async (
						requestId: string,
						plan: IacFinancialPlan,
						expected?: IacRoutingExpectation,
					) => {
						if (options.beforeAdmission !== undefined)
							await options.beforeAdmission();
						const receipt = await financial.admit(requestId, plan, expected);
						options.onReceipt?.(receipt);
						if (options.loseAdmissionResponse) throw new Error("response lost");
						if (options.unreadableReceipt) {
							Object.defineProperty(receipt, "budget", {
								get() {
									throw new Error("unreadable receipt");
								},
							});
						}
						return receipt;
					},
				},
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
	iacProgram: IacProgram,
	input: RankedExecutionCall,
) {
	return executeRankedIacTargets({
		...input,
		authority: fixture.routeAuthority,
		tenantId: "tenant-a",
		operation: routeFor(iacProgram, input.requestId).operation,
		candidates: input.candidates.map((candidate) => ({
			targetId: candidate.targetId,
			run: candidate.run,
		})),
	});
}

describe("Alchemy IaC provider against the real library", () => {
	it("accepts HoBo bindle declarations and reports every catalog primitive", () => {
		const application = bindle("storefront", (builder) => {
			const store = builder.bucket().allow("read", "write");
			const queue = builder.queue().allow("enqueue", "dequeue");
			const web = builder
				.web(() => () => new Response("ok"))
				.dependsOn(store, queue);
			return { store, queue, web };
		});
		type Entrypoint = NonNullable<ReturnType<typeof application.entrypoint>>;
		type Mapper = AlchemyPrimitiveMapper<
			Entrypoint,
			typeof application.requirements,
			AlchemyProvider<Demo>
		>;
		const createMapper = (
			operations: string[],
			bindsEntrypoint: boolean,
			annotations: string[] = [],
		): Mapper => ({
			resourceTypes: ["Demo.Widget"],
			operations,
			annotations,
			bindsEntrypoint,
			build: (input) =>
				gen(function* () {
					const primary = yield* Widget(input.declaration.name, { size: 1 });
					const mapped = {
						primary,
						resources: [primary],
						boundDependencies: Object.keys(input.dependencies),
					};
					return input.entrypoint === undefined
						? mapped
						: { ...mapped, boundEntrypoint: input.entrypoint };
				}),
		});
		const mappings = {
			bucket: createMapper(["read", "write"], false),
			queue: createMapper(["enqueue", "dequeue"], false),
			web: createMapper([], true, ["hobo:session-replay"]),
		};
		const assessed: (typeof application.requirements)[] = [];
		const options = {
			assessRequirements: (requirements: typeof application.requirements) => {
				assessed.push(requirements);
				return { status: "supported" as const };
			},
		};
		const coverage = describeAlchemyPrimitiveSupport(CATALOG_ROWS, mappings);
		expect(coverage).toHaveLength(CATALOG_ROWS.length);
		expect(coverage.find((entry) => entry.kind === "bucket")).toMatchObject({
			status: "partial",
			unsupportedOperations: ["delete"],
		});
		expect(coverage.find((entry) => entry.kind === "queue")).toMatchObject({
			status: "supported",
		});
		expect(coverage.find((entry) => entry.kind === "web")).toMatchObject({
			status: "supported",
			bindsEntrypoint: true,
		});
		expect(coverage.find((entry) => entry.kind === "topic")).toMatchObject({
			status: "unsupported",
		});
		expect(isEffect(mapBindleToAlchemy(application, mappings, options))).toBe(
			true,
		);
		expect(assessed).toEqual([application.requirements]);
		const missingDependency = bindle("missing-dependency", (builder) => {
			const queue = builder.queue();
			return {
				web: builder.web(() => () => new Response("ok")).dependsOn(queue),
			};
		});
		expect(() =>
			mapBindleToAlchemy(missingDependency, mappings, options),
		).toThrow("BINDLE_GRAPH_UNSUPPORTED");
	});

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
			fixture.authority.close();
		}
	});

	it("accepts the authenticated program generated by HoBo's resource actor", async () => {
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
		expect(generated.stackName).toBe("tenant-a/deployment-a/application");
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
			fixture.authority.close();
		}
	});

	it("passes each durable cloud operation generation through the Rivet adapter", async () => {
		const resource = {
			name: "application",
			port: "compute",
			provider: "sandbox",
			deps: [],
		};
		const context = {
			deploymentId: "deployment-a",
			tenant: "tenant-a",
			actor: { kind: "user" as const, id: "operator" },
		};
		const routed: IacRouteContext[] = [];
		const fixture = setup({
			rivet: true,
			output: "resource",
			onRoute: (operation) => routed.push(operation),
		});
		const store = createRuntimeLocalEventStore({
			dataDir: join(dir, "ledger"),
		});
		try {
			const deps = {
				store,
				actorHost: createInMemoryActorHost(),
				executor: createInProcessExecutor({ iac: fixture.provider }),
				broker: createInProcessCredentialBroker(),
			};
			expect(await reconcileResource(deps, resource, context)).toMatchObject({
				kind: "provisioned",
				snapshot: { outputs: { poolName: "default" } },
			});
			expect(await destroyResource(deps, resource, context)).toMatchObject({
				kind: "destroyed",
			});
			const history = [];
			for await (const event of store.read("deployment:deployment-a"))
				history.push(event);
			const starts = history.filter((event) =>
				["resource.Provisioning", "resource.Destroying"].includes(event.type),
			);
			const apply = routed.filter((item) => item.operation === "deploy");
			const destroy = routed.filter((item) => item.operation === "destroy");
			expect(apply.length).toBeGreaterThan(0);
			expect(destroy.length).toBeGreaterThan(0);
			expect(starts).toHaveLength(2);
			expect(starts[0]).toMatchObject({
				data: { operationGeneration: apply[0]?.operationGeneration },
			});
			expect(starts[1]).toMatchObject({
				data: { operationGeneration: destroy[0]?.operationGeneration },
			});
			expect(apply[0]?.operationGeneration).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
			);
			expect(destroy[0]?.operationGeneration).not.toBe(
				apply[0]?.operationGeneration,
			);
			expect(
				apply.every(
					(item) => item.operationGeneration === apply[0]?.operationGeneration,
				),
			).toBe(true);
			expect(
				destroy.every(
					(item) =>
						item.operationGeneration === destroy[0]?.operationGeneration,
				),
			).toBe(true);
			expect(fixture.applied()).toBe(1);
			expect(fixture.deleted()).toBe(1);
		} finally {
			store.close();
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
			fixture.authority.close();
		}
	});

	it("refuses output expressions that can execute arbitrary mapping code", async () => {
		const fixture = setup({ rivet: true, output: "mapped" });
		try {
			await expect(fixture.provider.preview(program)).rejects.toMatchObject({
				code: "COMPOSITE_PLAN_UNVERIFIED",
			});
			expect(fixture.applied()).toBe(0);
		} finally {
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
				reservationId: expect.stringMatching(/^iac:request:/u),
			});
			expect(fixture.applied()).toBe(1);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
			await expect(fixture.provider.apply(program)).rejects.toMatchObject({
				code: "EXECUTION_ALREADY_CLAIMED",
				requiresReconciliation: true,
				reservationId: expect.stringMatching(/^iac:request:/u),
			});
		} finally {
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
			const result = await executeRanked(fixture, program, {
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
			const routed = await executeRanked(priced, program, {
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
			unknown.authority.close();
			priced.authority.close();
		}
	});

	it("previews, reserves and applies the same scoped plan once", async () => {
		const fixture = setup();
		try {
			expect(await fixture.provider.preview(program)).toMatchObject({
				changes: 1,
			});
			const execution = await fixture.provider.applyWithAdmission(
				program,
				"scoped-once",
			);
			expect(execution).toMatchObject({
				outputs: {},
				admission: {
					status: "admitted",
					budget: { evaluation: "allowed", reservation: "held" },
					reservation: { reservationId: "iac:scoped-once" },
				},
			});
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
			fixture.authority.close();
		}
	});

	it("rejects replay before another provider instance can claim the operation", async () => {
		const sharedWork = mkdtempSync(join(dir, "shared-replay-"));
		const first = setup({ workDir: sharedWork });
		const second = setup({ workDir: sharedWork });
		try {
			await first.provider.preview(program);
			const applied = await first.provider.applyWithAdmission(program);
			expect(applied.admission.reservation?.reservationId).toMatch(
				/^iac:request:/u,
			);
			await second.provider.preview(program);
			await expect(second.provider.apply(program)).rejects.toMatchObject({
				code: "ROUTE_ALREADY_FINISHED",
				requiresReconciliation: true,
			});
			expect(first.applied()).toBe(1);
			expect(second.applied()).toBe(0);
		} finally {
			first.authority.close();
			second.authority.close();
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
			const routed = await executeRanked(fixture, program, {
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
				executeRanked(first, program, {
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
			first.authority.close();
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
			fixture.authority.close();
		}
	});

	it("does not reuse a priced routing assessment across operation generations", async () => {
		const fixture = setup();
		try {
			const first = await fixture.provider.assessPricing(program);
			const next = { ...program, operationGeneration: "generation-2" };
			const second = await fixture.provider.assessPricing(next);
			if (!first.quote.ok || !second.quote.ok)
				throw new Error("pricing missing");
			expect(first.quote.inventoryHash).not.toBe(second.quote.inventoryHash);
			await expect(
				fixture.provider.applyWithAdmission(next, "stale-generation", {
					targetId: "yard-a",
					inventoryHash: first.quote.inventoryHash,
					modelHash: first.quote.modelHash,
					quoteHash: first.quote.quote.quoteHash,
				}),
			).rejects.toMatchObject({ code: "ROUTE_PERMIT_UNVERIFIED" });
			expect(fixture.issued()).toBe(0);
			expect(fixture.applied()).toBe(0);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(0);
		} finally {
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
				reservationId: expect.stringMatching(/^iac:request:/u),
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
			fixture.authority.close();
		}
	});

	it("requires reconciliation when an admitted receipt cannot be inspected", async () => {
		const fixture = setup({ unreadableReceipt: true });
		try {
			await fixture.provider.preview(program);
			await expect(
				fixture.provider.applyWithAdmission(program, "unreadable"),
			).rejects.toMatchObject({
				code: "ADMISSION_RECEIPT_INVALID",
				requiresReconciliation: true,
			});
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
			expect(fixture.applied()).toBe(0);
			await expect(
				fixture.provider.applyWithAdmission(program, "another-attempt"),
			).rejects.toMatchObject({
				code: "EXECUTION_ALREADY_CLAIMED",
				requiresReconciliation: true,
				reservationId: "iac:unreadable",
			});
			expect(fixture.issued()).toBe(1);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
		} finally {
			fixture.authority.close();
		}
	});

	it("returns an independent validated admission receipt", async () => {
		let original: IacTargetAdmissionDecision | undefined;
		const fixture = setup({
			onReceipt: (receipt) => {
				original = receipt;
			},
		});
		try {
			await fixture.provider.preview(program);
			const result = await fixture.provider.applyWithAdmission(
				program,
				"receipt-copy",
			);
			if (original?.budget === undefined) throw new Error("receipt missing");
			original.budget.reservation = "not-created";
			expect(result.admission.budget.reservation).toBe("held");
		} finally {
			fixture.authority.close();
		}
	});

	it("does not retry after an admission response is lost", async () => {
		const fixture = setup({ loseAdmissionResponse: true });
		try {
			await fixture.provider.preview(program);
			await expect(
				fixture.provider.applyWithAdmission(program, "lost-response"),
			).rejects.toMatchObject({
				code: "ADMISSION_OUTCOME_UNKNOWN",
				requiresReconciliation: true,
			});
			await expect(
				fixture.provider.applyWithAdmission(program, "another-attempt"),
			).rejects.toMatchObject({
				code: "EXECUTION_OUTCOME_UNRESOLVED",
				requiresReconciliation: true,
			});
			expect(fixture.issued()).toBe(1);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
			expect(fixture.applied()).toBe(0);
		} finally {
			fixture.authority.close();
		}
	});

	it("does not start a concurrent execution of the same program with a different request id", async () => {
		let release = () => {};
		let started = () => {};
		let admissions = 0;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const firstStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const fixture = setup({
			beforeAdmission: async () => {
				if (++admissions === 1) {
					started();
					await pending;
				}
			},
		});
		try {
			await fixture.provider.preview(program);
			const first = fixture.provider.applyWithAdmission(program, "first");
			await firstStarted;
			const second = fixture.provider.applyWithAdmission(program, "second");
			const observed = await Promise.race([
				second.then(
					() => ({ code: "unexpected-success" }),
					(error) => error,
				),
				new Promise((resolve) =>
					setTimeout(() => resolve({ code: "timeout" }), 250),
				),
			]);
			release();
			await Promise.allSettled([first, second]);
			expect(observed).toMatchObject({
				code: "EXECUTION_IN_PROGRESS",
				requiresReconciliation: true,
			});
			expect(fixture.applied()).toBe(1);
		} finally {
			release();
			fixture.authority.close();
		}
	});

	it("does not destroy infrastructure through the apply entrypoint", async () => {
		const fixture = setup();
		try {
			await fixture.provider.preview(program);
			await fixture.provider.apply(program);
			const destroy = { ...program, action: "destroy" as const };
			await fixture.provider.preview(destroy);
			await expect(
				fixture.provider.applyWithAdmission(destroy),
			).rejects.toMatchObject({ code: "PROGRAM_SCOPE_MISMATCH" });
			expect(fixture.deleted()).toBe(0);
		} finally {
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
			fixture.authority.close();
		}
	});

	it("previews and financially admits a destroy before invoking deletion", async () => {
		const fixture = setup();
		try {
			await fixture.provider.preview(program);
			await fixture.provider.applyWithAdmission(
				program,
				"deploy-destroy-setup",
			);
			const destroy = {
				...program,
				operationGeneration: "generation-destroy",
				action: "destroy" as const,
			};
			expect((await fixture.provider.preview(destroy)).changes).toBe(1);
			expect(fixture.deleted()).toBe(0);
			expect(fixture.operations()).toEqual(["deploy"]);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(1_500_000);
			await fixture.provider.destroy(destroy);
			expect(fixture.deleted()).toBe(1);
			expect(fixture.operations()).toEqual(["deploy", "destroy"]);
			expect(fixture.authority.read(NOW).reservedMicros).toBe(3_000_000);
		} finally {
			fixture.authority.close();
		}
	});
});
