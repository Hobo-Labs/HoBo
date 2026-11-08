import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
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

	it.each([
		"normal",
		"release-race",
		"claimed-retry",
		"cancel-before-claim",
		"expiry-after-claim",
	])("funds Azure generation before provider effects: %s", async (mode) => {
		const catalog = createLocalHostCatalog();
		// Extend catalog with azure wildcard so residual placement can succeed after gen.
		const azureCatalog = {
			catalogHash: catalog.catalogHash,
			definitions: () => [
				...catalog.definitions(),
				{
					id: "azure:*",
					providerId: "azure",
					port: "*",
					features: [],
					regions: ["eastus2"],
					cost: { sku: "azure", unit: "hour", marginalPrice: "0.01" },
					satisfies: () => ({ kind: "full" as const }),
				},
			],
		};

		const runtimes = createYardRuntimeCatalog();
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
			requiredPermissions: [],
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
		const request = buildDeploymentRequestFromParts({
			bindleName: "shop",
			providerId: "azure",
			selectionMode: "compatible-or-generate",
			allowGeneration: true,
			resources: [
				{ resourceId: "api", port: "hobo:http-service", features: [] },
			],
		});

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
		const reservationId = `hosting:broker:azure-gen:${request.requestId}`;
		let provisionCalls = 0;
		let inspectCalls = 0;
		const connector = {
			...nativeConnector,
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
				return nativeConnector.provision(plan);
			},
			async inspect(attemptId: string) {
				inspectCalls++;
				return nativeConnector.inspect(attemptId);
			},
		};
		const financial = {
			...authority,
			claimExecution(input: Parameters<typeof authority.claimExecution>[0]) {
				const claimed = authority.claimExecution(input);
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
		try {
			const deps: YardFirstPlacementDeps = {
				brokerId: "broker:azure-gen",
				hostingBudget: {
					authority: financial,
					quotes: [quote],
					now: () => now,
				},
				authorizeHosting(input) {
					return {
						gate: { effect: "allow", reasons: [], events: [] },
						proof: create(HostingPolicyProofSchema, {
							requestDigest: input.requestDigest,
							quoteId: input.quote.quoteId,
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
				connectors: new Map([[connector.id, connector]]),
				seedLocalYard: false,
			};
			const result = await resolveBindleDeployment(request, deps);
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
	});
});
