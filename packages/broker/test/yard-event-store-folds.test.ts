import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	buildDeploymentRequestFromParts,
	contentHashOf,
	createAwsYardEventStoreFoldResolver,
	createAzureYardEventStoreFoldResolver,
	createAzureYardGenerationConnector,
	createDefaultEventStoreFoldResolvers,
	createGcpYardEventStoreFoldResolver,
	createLocalHostCatalog,
	createLocalYardEventStoreFoldResolver,
	createSqliteBudgetAdmissionAuthority,
	createYardRuntimeCatalog,
	DEFAULT_YARD_GENERATION_POLICY,
	EVENT_STORE_SLOT,
	foldYardEventStoreAll,
	HostingPolicyProofSchema,
	HostingQuoteSchema,
	inventorySnapshotFromFold,
	LOCAL_HOST_PROVIDER_ID,
	localYardInstance,
	planYardGeneration,
	resolveBindleDeployment,
	YARD_EVENTS,
	type YardFirstPlacementDeps,
	yardEvent,
} from "../src/index.js";
import { approveLocalHosting } from "./helpers/local-hosting.js";
import { bindTestYardWork } from "./yard-hosting-fixtures.js";

describe("yard event-store folds + provider resolvers", () => {
	it("rebuilds inventory from yard.* facts alone", () => {
		const yard = localYardInstance({
			yardId: "yard:a",
			ownerTenantId: "t1",
			providerId: "local",
		});
		const state = foldYardEventStoreAll("broker:test", [
			yardEvent(YARD_EVENTS.Registered, { yard }),
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:a" }),
		]);
		expect(state.yards["yard:a"]?.status).toBe("ready");
		const snap = inventorySnapshotFromFold(state);
		expect(snap.yards).toHaveLength(1);
		expect(snap.contentHash.startsWith("sha256:")).toBe(true);
	});

	it("each provider exposes an event-store fold resolver", () => {
		const resolvers = createDefaultEventStoreFoldResolvers();
		const slots = resolvers.map((r) => r.descriptor.slot);
		expect(slots.every((s) => s === EVENT_STORE_SLOT)).toBe(true);
		expect(resolvers.some((r) => r.providerId === "azure")).toBe(true);
		expect(resolvers.some((r) => r.providerId === "aws")).toBe(true);
		expect(resolvers.some((r) => r.providerId === "gcp")).toBe(true);
	});

	it("Azure fold resolver normalizes managedEnvironment.ready → Ready yard", () => {
		const azure = createAzureYardEventStoreFoldResolver();
		const state = azure.foldAll("broker:az", [
			{
				providerId: "azure",
				kind: "managedEnvironment.ready",
				payload: {
					yardId: "yard:az-1",
					attemptId: "gen-1",
					subscriptionRef: "subscriptionref://x",
					tenantRef: "tenantref://y",
				},
			},
		]);
		expect(state.yards["yard:az-1"]?.status).toBe("ready");
		expect(state.yards["yard:az-1"]?.providerId).toBe("azure");
	});

	it("AWS fold resolver normalizes ecs.cluster.ready", () => {
		const aws = createAwsYardEventStoreFoldResolver();
		const state = aws.foldAll("broker:aws", [
			{
				providerId: "aws",
				kind: "ecs.cluster.ready",
				payload: {
					yardId: "yard:aws-1",
					clusterArn: "arn:aws:ecs:us-east-1:123:cluster/hobo",
					attemptId: "gen-2",
				},
			},
		]);
		expect(state.yards["yard:aws-1"]?.status).toBe("ready");
	});

	it("GCP fold resolver normalizes cloudRun.ready", () => {
		const gcp = createGcpYardEventStoreFoldResolver();
		const state = gcp.foldAll("broker:gcp", [
			{
				providerId: "gcp",
				kind: "cloudRun.ready",
				payload: {
					yardId: "yard:gcp-1",
					serviceName: "hobo-yard",
					projectRef: "projectref://p",
					attemptId: "gen-3",
				},
			},
		]);
		expect(state.yards["yard:gcp-1"]?.status).toBe("ready");
	});

	it("local fold resolver handles componentHost.ready", () => {
		const local = createLocalYardEventStoreFoldResolver("local");
		const state = local.foldAll("broker:local", [
			{
				providerId: "local",
				kind: "componentHost.ready",
				payload: {
					yardId: "yard:local-1",
					componentHosts: ["local", "wasm"],
				},
			},
		]);
		expect(state.yards["yard:local-1"]?.status).toBe("ready");
	});

	it("generation lease: identical idempotency keys share one attempt", () => {
		const state = foldYardEventStoreAll("broker:lease", [
			yardEvent(YARD_EVENTS.GenerationReserved, {
				attemptId: "a1",
				idempotencyKey: "sha256:same",
				providerId: "azure",
				runtimeId: "azure.yard-runtime/v1",
				expectedYardId: "yard:gen-1",
			}),
			yardEvent(YARD_EVENTS.GenerationReserved, {
				attemptId: "a2",
				idempotencyKey: "sha256:same",
				providerId: "azure",
				runtimeId: "azure.yard-runtime/v1",
				expectedYardId: "yard:gen-1",
			}),
		]);
		// First reservation wins the lease.
		expect(state.generationByIdempotency["sha256:same"]).toBe("a1");
		expect(state.generationAttempts.a1?.status).toBe("reserved");
	});

	it("placement emits yard.* facts and fold agrees with receipt", async () => {
		const catalog = createLocalHostCatalog();
		const priorYard = localYardInstance({
			yardId: "yard:local-main",
			ownerTenantId: "local",
			providerId: LOCAL_HOST_PROVIDER_ID,
		});
		const priorEvents = [
			yardEvent(YARD_EVENTS.Registered, { yard: priorYard }),
			yardEvent(YARD_EVENTS.Ready, { yardId: "yard:local-main" }),
		];

		const request = buildDeploymentRequestFromParts({
			bindleName: "shop",
			providerId: LOCAL_HOST_PROVIDER_ID,
			yardId: "yard:local-main",
			selectionMode: "compatible",
			resources: [
				{ resourceId: "api", port: "hobo:http-service", features: [] },
			],
		});

		const result = await resolveBindleDeployment(request, {
			brokerId: "broker:test",
			authorizeLocalHosting: approveLocalHosting,
			catalog,
			seedLocalYard: false,
			priorEvents,
		});

		expect(result.outcome).toBe("resolved");
		expect(
			result.events.some((e) => e.type === YARD_EVENTS.PlacementRequested),
		).toBe(true);
		expect(result.events.some((e) => e.type === YARD_EVENTS.MatchDecided)).toBe(
			true,
		);
		expect(
			result.events.some((e) => e.type === YARD_EVENTS.PlacementResolved),
		).toBe(true);
		expect(result.foldState.placements[request.requestId]?.outcome).toBe(
			"resolved",
		);
		expect(
			result.receipt?.resolverPins.some((p) => p.slot === "event-store"),
		).toBe(true);
	});

	const generationModes = [
		"normal",
		"release-race",
		"claimed-retry",
		"cancel-before-claim",
		"expiry-after-claim",
		"lookup-unavailable",
		"lookup-after-generation",
		"context-after-generation",
		"uncertain-write-failed",
		"context-before-claim",
		"missing-residual",
		"foreign-camp-after-generation",
		"signals-unavailable",
		"wrong-generation-plan",
		"missing-generation-work",
		"changed-work-after-generation",
		"changed-plan-during-policy",
		"changed-plan-during-claim",
		"changed-plan-before-claim",
		"generation-policy-revoked",
		"generation-policy-replaced",
		"generation-policy-before-receipt",
		"generation-runtime-catalog-replaced",
		"generation-lookup-method-replaced",
		"generation-snapshot-method-replaced",
		"generation-registry-replaced",
		"generation-runtime-revoked",
		"generation-connector-replaced",
		"generation-connector-id-mismatch",
		"generation-runtime-read-unavailable",
		"generation-runtime-read-initial",
		"generation-method-replaced",
		"generation-lookup-redirect",
		"generation-policy-before-claim",
		"generation-runtime-after-claim",
		"generation-policy-after-effect",
		"generation-runtime-after-effect",
	] as const;
	async function exerciseGeneration(mode: (typeof generationModes)[number]) {
		const catalog = createLocalHostCatalog();
		let generationFinished = false;
		// Extend catalog with azure wildcard so residual placement can succeed after gen.
		const azureCatalog = {
			catalogHash: catalog.catalogHash,
			definitions: () => {
				const definitions = [...catalog.definitions()];
				if (mode !== "missing-residual" || !generationFinished)
					definitions.push({
						id: "azure:*",
						providerId: "azure",
						port: "*",
						features: [],
						regions: ["eastus2"],
						cost: {
							sku: "azure",
							unit: "hour",
							marginalPrice:
								mode === "changed-work-after-generation" && generationFinished
									? "0.02"
									: "0.01",
						},
						satisfies: () => ({ kind: "full" as const }),
					});
				return definitions;
			},
		};

		const runtimes = createYardRuntimeCatalog();
		const runtimePermissions: string[] = [];
		runtimes.register({
			schemaVersion: "hobo.yard-runtime/v1",
			runtimeId: "azure.yard-runtime/v1",
			providerId: "azure",
			version: "1",
			supportedLayout: {
				regions: ["eastus2"],
				capabilities: ["managed-container-substrate"],
				requireProperties: [],
			},
			resolverCatalogHash: contentHashOf("r"),
			generatorConnectorId: "connector:azure-yard-generator",
			default: true,
			priority: 10,
			requiredPermissions: runtimePermissions,
			conformanceRef: "ref",
			conformanceHash: contentHashOf("c"),
			status: "approved",
		});

		const allowPolicy = {
			...DEFAULT_YARD_GENERATION_POLICY,
			id: "allow-azure-gen",
			effect: "allow-if-no-match" as const,
			allowedProviderIds: ["azure"] as const,
			allowedRuntimeIds: ["azure.yard-runtime/v1"] as const,
			allowedConnectorIds: ["connector:azure-yard-generator"] as const,
			maxConcurrentGenerations: 1,
			maxYardsPerTenant: 5,
			requireApproval: false,
		};

		const nativeConnector = createAzureYardGenerationConnector();
		const baseRequest = buildDeploymentRequestFromParts({
			bindleName: "shop",
			providerId: "azure",
			selectionMode: "compatible-or-generate",
			allowGeneration: true,
			resources: [
				{ resourceId: "api", port: "hobo:http-service", features: [] },
			],
		});
		const request =
			mode === "foreign-camp-after-generation"
				? {
						...baseRequest,
						camp: {
							selectionMode: "compatible" as const,
							campId: "yard:foreign/camp:prod",
							layout: {
								require: [],
								prefer: [],
								labels: {},
								runtimeRequirements: [],
								envType: "production",
							},
						},
					}
				: baseRequest;

		const generation = planYardGeneration({
			ownerTenantId: "local",
			requestedLayout: request.yard.requestedLayout,
			runtimeCatalog: runtimes.snapshot(),
			policy: allowPolicy,
			allowGenerationRequested: true,
			attemptId: `gen-${request.requestId}`,
		});
		if (!generation.allowed) throw new Error("fixture generation denied");
		const directory = mkdtempSync(
			join(tmpdir(), "hobo-funded-yard-generation-"),
		);
		let now = "2026-10-29T12:00:00Z";
		const authority = createSqliteBudgetAdmissionAuthority({
			path: join(directory, "budget.sqlite"),
			now: () => now,
			snapshot: create(BudgetLedgerSnapshotSchema, {
				identity: {
					tenantId: "local",
					budgetId: "hosting",
					periodId: "2026-10",
					policyRevision: "r1",
				},
				limitMicros: 100,
				observedAt: "2026-10-29T00:00:00Z",
				validUntil: "2026-11-01T00:00:00Z",
			}),
		});
		const quote = create(HostingQuoteSchema, {
			quoteId: "azure-generation",
			yardId: generation.plan.expectedYardId,
			providerId: "azure",
			ownerTenantId: "local",
			currency: "USD",
			totalMicros: 10,
			liabilityBoundMicros: 20,
			components: [{ name: "provision-and-runtime", costMicros: 10 }],
			requestDigest: contentHashOf(request),
			observedAt: "2026-10-29T00:00:00Z",
			validUntil: "2026-11-01T00:00:00Z",
		});
		bindTestYardWork(quote, request, "broker:azure-gen", azureCatalog, {
			generationPlanHash:
				mode === "wrong-generation-plan"
					? contentHashOf("another-generation")
					: generation.plan.planHash,
		});
		if (mode === "missing-generation-work") quote.workDigest = "";
		const reservationId = `hosting:broker:azure-gen:${request.requestId}`;
		let provisionCalls = 0;
		let inspectCalls = 0;
		let changeContext: (() => void) | undefined;
		const connector = {
			...nativeConnector,
			signalsFor(id: string) {
				if (mode === "signals-unavailable")
					throw new Error("signals unavailable");
				return nativeConnector.signalsFor(id);
			},
			async provision(plan: Parameters<typeof nativeConnector.provision>[0]) {
				provisionCalls++;
				expect(authority.lookup(reservationId)?.executionDigest).toBe(
					contentHashOf({
						kind: "yard-generation",
						requestDigest: quote.requestDigest,
						planHash: plan.planHash,
					}),
				);
				if (mode === "release-race") {
					const competitor = createSqliteBudgetAdmissionAuthority({
						path: join(directory, "budget.sqlite"),
						snapshot: authority.read(now),
						now: () => now,
					});
					try {
						expect(() =>
							competitor.release(reservationId, true, "cancelled-before-claim"),
						).toThrow("execution-claimed");
					} finally {
						competitor.close();
					}
				}
				const result = await nativeConnector.provision(plan);
				generationFinished = true;
				if (mode === "generation-policy-after-effect")
					Object.assign(allowPolicy, { effect: "deny" });
				if (mode === "generation-runtime-after-effect") {
					const runtime = runtimes.snapshot().runtimes[0];
					if (!runtime) throw new Error("runtime fixture missing");
					runtimes.register({ ...runtime, status: "disabled" });
				}
				if (
					mode === "context-after-generation" ||
					mode === "uncertain-write-failed"
				)
					changeContext?.();
				return result;
			},
			async inspect(attemptId: string) {
				inspectCalls++;
				return nativeConnector.inspect(attemptId);
			},
		};
		const connectors = new Map([[connector.id, connector]]);
		if (mode === "generation-connector-id-mismatch")
			Object.assign(connector, { id: "different-connector" });
		let runtimeReadsAvailable = mode !== "generation-runtime-read-initial";
		if (
			mode === "generation-runtime-read-unavailable" ||
			mode === "generation-runtime-read-initial"
		) {
			const snapshot = runtimes.snapshot.bind(runtimes);
			Object.assign(runtimes, {
				snapshot() {
					if (!runtimeReadsAvailable)
						throw new Error("runtime catalog unavailable");
					return snapshot();
				},
			});
		}
		let redirectedProvisionCalls = 0;
		let lookupsAfterClaim = 0;
		if (mode === "generation-lookup-redirect") {
			const normalLookup = connectors.get.bind(connectors);
			Object.assign(connectors, {
				get(id: string) {
					if (authority.lookup(reservationId)?.executionDigest)
						lookupsAfterClaim++;
					if (lookupsAfterClaim === 2)
						return {
							...connector,
							async provision(
								plan: Parameters<typeof nativeConnector.provision>[0],
							) {
								redirectedProvisionCalls++;
								return nativeConnector.provision(plan);
							},
						};
					return normalLookup(id);
				},
			});
		}
		const financial = {
			...authority,
			uncertain(id: string) {
				if (mode === "uncertain-write-failed")
					throw new Error("storage unavailable");
				return authority.uncertain(id);
			},
			lookup(id: string) {
				if (
					mode === "lookup-unavailable" ||
					(mode === "lookup-after-generation" && generationFinished)
				)
					throw new Error("storage unavailable");
				const reservation = authority.lookup(id);
				if (mode === "generation-policy-before-claim" && reservation)
					Object.assign(allowPolicy, { effect: "deny" });
				if (mode === "changed-plan-before-claim" && reservation)
					runtimePermissions.push("unquoted-permission");
				if (mode === "context-before-claim" && reservation) changeContext?.();
				return reservation;
			},
			claimExecution(input: Parameters<typeof authority.claimExecution>[0]) {
				const claimed = authority.claimExecution(input);
				if (mode === "generation-runtime-after-claim") {
					const runtime = runtimes.snapshot().runtimes[0];
					if (!runtime) throw new Error("runtime fixture missing");
					runtimes.register({ ...runtime, status: "disabled" });
				}
				if (mode === "changed-plan-during-claim")
					runtimePermissions.push("unquoted-permission");
				if (mode === "expiry-after-claim") now = "2026-11-02T00:00:00Z";
				return claimed;
			},
			reserve(input: Parameters<typeof authority.reserve>[0]) {
				const reservation = authority.reserve(input);
				if (mode === "cancel-before-claim")
					authority.release(reservationId, true, "cancelled-before-claim");
				return reservation;
			},
		};
		let authorizationCalls = 0;
		try {
			const deps: YardFirstPlacementDeps = {
				brokerId: "broker:azure-gen",
				hostingBudget: {
					authority: financial,
					quotes: [quote],
					now: () => now,
				},
				authorizeHosting(input) {
					authorizationCalls++;
					if (
						mode === "generation-policy-before-receipt" &&
						authorizationCalls === 2
					)
						Object.assign(allowPolicy, { effect: "deny" });
					if (mode === "generation-runtime-catalog-replaced")
						Object.assign(deps, { runtimeCatalog: createYardRuntimeCatalog() });
					if (mode === "generation-lookup-method-replaced") {
						const originalLookup = connectors.get.bind(connectors);
						Object.assign(connectors, {
							get: (id: string) => originalLookup(id),
						});
					}
					if (mode === "generation-runtime-read-unavailable")
						runtimeReadsAvailable = false;
					if (mode === "generation-policy-replaced")
						Object.assign(deps, { generationPolicy: { ...allowPolicy } });
					if (mode === "generation-registry-replaced")
						Object.assign(deps, { connectors: new Map(connectors) });
					if (mode === "generation-snapshot-method-replaced") {
						const originalSnapshot = runtimes.snapshot.bind(runtimes);
						Object.assign(runtimes, { snapshot: () => originalSnapshot() });
					}
					if (mode === "generation-connector-replaced")
						connectors.set(connector.id, { ...connector });
					if (mode === "generation-method-replaced")
						Object.assign(connector, {
							provision: async (
								plan: Parameters<typeof nativeConnector.provision>[0],
							) => {
								provisionCalls++;
								return nativeConnector.provision(plan);
							},
						});
					if (mode === "generation-policy-revoked")
						Object.assign(allowPolicy, { effect: "deny" });
					if (mode === "generation-runtime-revoked") {
						const runtime = runtimes.snapshot().runtimes[0];
						if (!runtime) throw new Error("runtime fixture missing");
						runtimes.register({ ...runtime, status: "disabled" });
					}
					if (mode === "changed-plan-during-policy")
						runtimePermissions.push("unquoted-permission");
					return {
						gate: { effect: "allow", reasons: [], events: [] },
						proof: create(HostingPolicyProofSchema, {
							requestDigest: input.requestDigest,
							quoteId: input.quote.quoteId,
							quoteDigest: input.quoteDigest,
							identity: input.identity,
							policyHash: "approved-azure-policy",
							effect: "allow",
							obligationsSatisfied: true,
							evidenceRef: "gatekeeper:approved",
						}),
					};
				},
				catalog: azureCatalog,
				runtimeCatalog: runtimes,
				generationPolicy: allowPolicy,
				connectors,
				seedLocalYard: false,
			};
			changeContext = () => Object.assign(deps, { hostingBudget: undefined });
			const result = await resolveBindleDeployment(request, deps);
			if (
				mode === "wrong-generation-plan" ||
				mode === "missing-generation-work"
			) {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.read(now).reservedMicros).toBe(0);
				return;
			}
			if (mode === "changed-plan-during-claim") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				return;
			}
			if (mode === "generation-runtime-read-initial") {
				expect(result.outcome).toBe("rejected");
				expect(result.reasons?.[0]?.code).toBe(
					"yard-runtime-catalog-unavailable",
				);
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)).toBeUndefined();
				return;
			}
			if (mode === "generation-connector-id-mismatch") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)).toBeUndefined();
				return;
			}
			if (mode === "generation-lookup-redirect") {
				expect(redirectedProvisionCalls).toBe(0);
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				return;
			}
			if (mode === "generation-policy-before-receipt") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				return;
			}
			if (
				mode === "generation-policy-after-effect" ||
				mode === "generation-runtime-after-effect"
			) {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				return;
			}
			if (mode === "generation-runtime-after-claim") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				return;
			}
			if (
				mode === "generation-policy-revoked" ||
				mode === "generation-runtime-read-unavailable" ||
				mode === "generation-policy-replaced" ||
				mode === "generation-runtime-catalog-replaced" ||
				mode === "generation-lookup-method-replaced" ||
				mode === "generation-snapshot-method-replaced" ||
				mode === "generation-registry-replaced" ||
				mode === "generation-runtime-revoked" ||
				mode === "generation-connector-replaced" ||
				mode === "generation-method-replaced" ||
				mode === "generation-policy-before-claim"
			) {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)?.status).toBe("held");
				expect(authority.lookup(reservationId)?.executionDigest).toBe("");
				return;
			}
			if (mode === "changed-plan-before-claim") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)?.status).toBe("held");
				expect(authority.lookup(reservationId)?.executionDigest).toBe("");
				return;
			}
			if (mode === "changed-plan-during-policy") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)?.status).toBe("held");
				expect(authority.lookup(reservationId)?.executionDigest).toBe("");
				return;
			}
			if (mode === "changed-work-after-generation") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				expect(authority.read(now).reservedMicros).toBe(20);
				return;
			}
			if (mode === "lookup-unavailable") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.read(now).reservedMicros).toBe(0);
				return;
			}
			if (mode === "lookup-after-generation") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				expect(authority.read(now).reservedMicros).toBe(20);
				return;
			}
			if (mode === "context-after-generation") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				expect(authority.read(now).reservedMicros).toBe(20);
				return;
			}
			if (mode === "uncertain-write-failed") {
				expect(result.outcome).toBe("rejected");
				expect(result.reasons?.[0]?.message).toMatch(
					/uncertain status could not be recorded/u,
				);
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("held");
				expect(authority.read(now).reservedMicros).toBe(20);
				return;
			}
			if (mode === "context-before-claim") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)?.status).toBe("held");
				expect(authority.lookup(reservationId)?.executionDigest).toBe("");
				expect(authority.read(now).reservedMicros).toBe(20);
				return;
			}
			if (mode === "missing-residual") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				expect(authority.read(now).reservedMicros).toBe(20);
				return;
			}
			if (mode === "foreign-camp-after-generation") {
				expect(result.outcome).toBe("rejected");
				expect(result.reasons?.[0]?.code).toBe("camp-yard-mismatch");
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				expect(authority.read(now).reservedMicros).toBe(20);
				return;
			}
			if (mode === "signals-unavailable") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				expect(authority.read(now).reservedMicros).toBe(20);
				return;
			}
			if (mode === "cancel-before-claim") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.read(now).reservedMicros).toBe(0);
				return;
			}
			if (mode === "expiry-after-claim") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)).toMatchObject({
					status: "held",
					reservedMicros: 20,
				});
				return;
			}

			expect(result.outcome).toBe("resolved");
			expect(result.generationAttemptId).toBeTruthy();
			expect(
				result.events.some((e) => e.type === YARD_EVENTS.GenerationStarted),
			).toBe(true);
			expect(result.events.some((e) => e.type === YARD_EVENTS.Ready)).toBe(
				true,
			);
			expect(result.receipt?.selectedProviderId).toBe("azure");
			expect(authority.read(now).reservedMicros).toBe(20);
			if (mode === "claimed-retry") {
				const retry = await resolveBindleDeployment(request, deps);
				expect(retry.outcome).toBe("resolved");
				expect(provisionCalls).toBe(1);
				expect(inspectCalls).toBe(1);
				expect(authority.read(now).reservedMicros).toBe(20);
			}
		} finally {
			authority.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}
	it.each(generationModes)(
		"funds Azure generation before provider effects: %s",
		exerciseGeneration,
	);
	it("fences generated policy, runtime and connector changes", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(
					"normal",
					"generation-policy-revoked",
					"generation-connector-id-mismatch",
					"generation-runtime-read-unavailable",
					"generation-runtime-read-initial",
					"generation-policy-replaced",
					"generation-policy-before-receipt",
					"generation-runtime-catalog-replaced",
					"generation-lookup-method-replaced",
					"generation-snapshot-method-replaced",
					"generation-registry-replaced",
					"generation-lookup-redirect",
					"generation-runtime-revoked",
					"generation-connector-replaced",
					"generation-method-replaced",
					"generation-policy-before-claim",
					"generation-runtime-after-claim",
					"generation-policy-after-effect",
					"generation-runtime-after-effect",
				),
				async (mode) => exerciseGeneration(mode),
			),
			{ seed: 614528, numRuns: 80 },
		);
	});
});
