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
	prepareYardHostingWork,
	resolveBindleDeployment,
	YARD_EVENTS,
	type YardFirstPlacementDeps,
	yardEvent,
} from "../src/index.js";
import { cloneAsJson, isJsonObject, type JsonBag } from "../src/json.js";
import { approveLocalHosting } from "./helpers/local-hosting.js";
import { bindTestYardWork } from "./yard-hosting-fixtures.js";

describe("yard event-store folds + provider resolvers", () => {
	it("retains the generation attempt on a local ready signal", () => {
		const resolver = createLocalYardEventStoreFoldResolver();
		const events = resolver.normalize({
			providerId: "local",
			kind: "componentHost.ready",
			payload: { yardId: "yard:local", attemptId: "gen:one" },
		});
		expect(
			events.find((event) => event.type === YARD_EVENTS.Ready)?.data,
		).toMatchObject({
			yardId: "yard:local",
			attemptId: "gen:one",
		});
	});
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
		"foreign-camp-before-generation",
		"unverified-camp-before-generation",
		"exact-yard-mismatch-before-generation",
		"exact-yard-match-generation",
		"wrong-generated-yard-id",
		"wrong-generation-attempt-id",
		"wrong-generated-yard-uncertainty-fails",
		"wrong-yard-on-inspect",
		"generation-not-ready-no-signal",
		"generation-registered-no-signal",
		"generation-started-ready-signal",
		"generation-ready-no-signal",
		"generation-unrelated-ready-signal",
		"generation-foreign-yard-signal",
		"generation-signal-missing-attempt",
		"generation-progress-missing-attempt",
		"generation-signal-foreign-key",
		"generation-signal-foreign-runtime",
		"generation-signal-foreign-tenant",
		"generation-normalizer-foreign-yard",
		"generation-normalizer-mutable-event",
		"generation-normalizer-forged-placement",
		"generation-normalizer-sequence",
		"generation-normalizer-ready-registration",
		"generation-normalizer-ready-status",
		"generation-normalizer-ready-no-attempt",
		"invalid-residency-before-generation",
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
	async function exerciseGeneration(
		mode: (typeof generationModes)[number],
		identitySuffix = "",
	) {
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
		const expectedKey = contentHashOf({
			ownerTenantId: "local",
			layoutHash: contentHashOf(baseRequest.yard.requestedLayout),
			runtimeId: "azure.yard-runtime/v1",
			runtimeVersion: "1",
			brokerEnvironmentId: "default",
		});
		const expectedYardId = `yard:gen-${expectedKey.slice(7, 23)}`;
		const preparedRequest =
			mode === "exact-yard-mismatch-before-generation" ||
			mode === "exact-yard-match-generation"
				? {
						...baseRequest,
						yard: {
							...baseRequest.yard,
							selectionMode: "exact" as const,
							requestedYardId:
								mode === "exact-yard-match-generation"
									? expectedYardId
									: "yard:requested-other",
						},
					}
				: mode === "foreign-camp-before-generation"
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
					: mode === "invalid-residency-before-generation"
						? {
								...baseRequest,
								yard: {
									...baseRequest.yard,
									requestedLayout: {
										...baseRequest.yard.requestedLayout,
										residency: ["atlantis"],
									},
								},
							}
						: baseRequest;
		const request =
			mode === "unverified-camp-before-generation"
				? {
						...baseRequest,
						camp: {
							selectionMode: "compatible" as const,
							layout: {
								require: ["special-capability"],
								prefer: [],
								labels: {},
								runtimeRequirements: [],
							},
						},
					}
				: preparedRequest;

		const generation = planYardGeneration({
			ownerTenantId: "local",
			requestedLayout:
				mode === "invalid-residency-before-generation"
					? baseRequest.yard.requestedLayout
					: request.yard.requestedLayout,
			runtimeCatalog: runtimes.snapshot(),
			policy: allowPolicy,
			allowGenerationRequested: true,
			attemptId: `gen-${request.requestId}`,
		});
		if (!generation.allowed) throw new Error("fixture generation denied");
		// Reconstruct a self-consistent plan from an older peer that did not
		// validate residency, so the request preflight is still exercised.
		const generationPlan = (() => {
			if (mode !== "invalid-residency-before-generation")
				return generation.plan;
			const requestedLayout = request.yard.requestedLayout;
			const layoutHash = contentHashOf(requestedLayout);
			const idempotencyKey = contentHashOf({
				ownerTenantId: "local",
				layoutHash,
				runtimeId: generation.runtime.runtimeId,
				runtimeVersion: generation.runtime.version,
				brokerEnvironmentId: "default",
			});
			const { planHash: _previousHash, ...body } = generation.plan;
			const oldPlan = {
				...body,
				requestedLayout,
				requestedLayoutHash: layoutHash,
				idempotencyKey,
				expectedYardId: `yard:gen-${idempotencyKey.slice(7, 23)}`,
			};
			return { ...oldPlan, planHash: contentHashOf(oldPlan) };
		})();
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
			yardId: generationPlan.expectedYardId,
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
		if (
			mode !== "foreign-camp-before-generation" &&
			mode !== "unverified-camp-before-generation" &&
			mode !== "invalid-residency-before-generation" &&
			mode !== "exact-yard-mismatch-before-generation"
		)
			bindTestYardWork(quote, request, "broker:azure-gen", azureCatalog, {
				generationPlanHash:
					mode === "wrong-generation-plan"
						? contentHashOf("another-generation")
						: generationPlan.planHash,
			});
		else {
			// Simulate a quote from a peer that skipped the relevant request check.
			const work = prepareYardHostingWork({
				request: baseRequest,
				brokerId: "broker:azure-gen",
				ownerTenantId: "local",
				catalog: azureCatalog,
				yardId: generationPlan.expectedYardId,
				providerId: "azure",
				generationPlanHash: generationPlan.planHash,
			});
			if ("error" in work) throw new Error("generation work fixture failed");
			quote.workDigest = contentHashOf({
				schemaVersion: "hobo.yard-hosting-work/v1",
				requestDigest: quote.requestDigest,
				brokerId: "broker:azure-gen",
				ownerTenantId: "local",
				catalogHash: azureCatalog.catalogHash,
				yardId: generationPlan.expectedYardId,
				providerId: "azure",
				placements: work.placements,
				generationPlanHash: generationPlan.planHash,
			});
		}
		if (mode === "missing-generation-work") quote.workDigest = "";
		const reservationId = `hosting:broker:azure-gen:${request.requestId}`;
		let provisionCalls = 0;
		let inspectCalls = 0;
		let changeContext: (() => void) | undefined;
		const connector = {
			...nativeConnector,
			signalsFor(id: string) {
				if (
					mode === "generation-not-ready-no-signal" ||
					mode === "generation-registered-no-signal" ||
					mode === "generation-ready-no-signal"
				)
					return [];
				if (mode === "signals-unavailable")
					throw new Error("signals unavailable");
				const signals = nativeConnector.signalsFor(id);
				return signals.map((signal) => {
					if (
						mode === "generation-progress-missing-attempt" &&
						signal.kind === "resourceGroup.created"
					) {
						const payload = { ...signal.payload };
						delete payload.attemptId;
						return { ...signal, payload };
					}
					if (signal.kind !== "managedEnvironment.ready") return signal;
					const payload = { ...signal.payload };
					if (mode === "generation-unrelated-ready-signal")
						payload.attemptId = `gen-unrelated-${identitySuffix}`;
					else if (mode === "generation-foreign-yard-signal")
						payload.yardId = `yard:unexpected-${identitySuffix}`;
					else if (mode === "generation-signal-missing-attempt")
						delete payload.attemptId;
					else if (mode === "generation-signal-foreign-key")
						payload.idempotencyKey = `sha256:unexpected-${identitySuffix}`;
					else if (mode === "generation-signal-foreign-runtime")
						payload.runtimeId = `runtime:unexpected-${identitySuffix}`;
					else if (mode === "generation-signal-foreign-tenant")
						payload.ownerTenantId = `tenant:unexpected-${identitySuffix}`;
					return { ...signal, payload };
				});
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
				if (
					mode === "wrong-generated-yard-id" ||
					mode === "wrong-generated-yard-uncertainty-fails"
				)
					return { ...result, yardId: "yard:unexpected" };
				if (mode === "wrong-generation-attempt-id")
					return { ...result, attemptId: "gen-unexpected" };
				if (mode === "generation-registered-no-signal")
					return { ...result, status: "registered" as const };
				if (
					mode === "generation-not-ready-no-signal" ||
					mode === "generation-started-ready-signal" ||
					mode === "generation-unrelated-ready-signal"
				)
					return { ...result, status: "started" as const };
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
				const inspected = await nativeConnector.inspect(attemptId);
				return mode === "wrong-yard-on-inspect"
					? { ...inspected, yardId: "yard:unexpected" }
					: inspected;
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
				if (
					mode === "uncertain-write-failed" ||
					mode === "wrong-generated-yard-uncertainty-fails"
				)
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
			if (
				mode === "generation-normalizer-foreign-yard" ||
				mode === "generation-normalizer-mutable-event" ||
				mode === "generation-normalizer-forged-placement" ||
				mode === "generation-normalizer-sequence" ||
				mode === "generation-normalizer-ready-registration" ||
				mode === "generation-normalizer-ready-status" ||
				mode === "generation-normalizer-ready-no-attempt"
			) {
				const resolver = createAzureYardEventStoreFoldResolver();
				let pendingYard: JsonBag | undefined;
				Object.assign(deps, {
					foldResolvers: [
						{
							...resolver,
							normalize(signal: Parameters<typeof resolver.normalize>[0]) {
								if (
									mode === "generation-normalizer-mutable-event" &&
									signal.kind === "resourceGroup.created"
								) {
									const yard = cloneAsJson(
										localYardInstance({
											yardId: String(signal.payload.yardId),
											ownerTenantId: "local",
											providerId: "azure",
											runtimeId: "azure.yard-runtime/v1",
										}),
									);
									if (!isJsonObject(yard)) throw new Error("bad fixture Yard");
									pendingYard = { ...yard, status: "registering" };
									return [
										{
											type: YARD_EVENTS.Registered,
											data: { yard: pendingYard },
										},
									];
								}
								if (pendingYard) {
									pendingYard.yardId = "yard:unexpected";
									pendingYard = undefined;
								}
								if (mode === "generation-normalizer-forged-placement")
									return [
										yardEvent(YARD_EVENTS.PlacementResolved, {
											requestId: request.requestId,
										}),
									];
								if (mode === "generation-normalizer-sequence")
									return resolver.normalize(signal).map((event) => ({
										...event,
										seq: Number.MAX_SAFE_INTEGER,
									}));
								if (
									(mode === "generation-normalizer-ready-registration" ||
										mode === "generation-normalizer-ready-status") &&
									signal.kind === "resourceGroup.created"
								) {
									const yard = localYardInstance({
										yardId: String(signal.payload.yardId),
										ownerTenantId: "local",
										providerId: "azure",
										runtimeId: "azure.yard-runtime/v1",
									});
									if (mode === "generation-normalizer-ready-registration")
										return [yardEvent(YARD_EVENTS.Registered, { yard })];
									return [
										yardEvent(YARD_EVENTS.Registered, {
											yard: { ...yard, status: "registering" },
										}),
										yardEvent(YARD_EVENTS.StatusChanged, {
											yardId: yard.yardId,
											status: "ready",
										}),
									];
								}
								if (mode === "generation-normalizer-ready-no-attempt")
									return resolver.normalize(signal).map((event) => {
										if (event.type !== YARD_EVENTS.Ready) return event;
										const { attemptId: _attemptId, ...data } = event.data;
										return { ...event, data };
									});
								return resolver.normalize(signal).map((event) =>
									event.type === YARD_EVENTS.Registered &&
									mode === "generation-normalizer-foreign-yard"
										? yardEvent(YARD_EVENTS.Registered, {
												yard: {
													...localYardInstance({
														yardId: "yard:unexpected",
														ownerTenantId: "local",
														providerId: "azure",
														runtimeId: "azure.yard-runtime/v1",
													}),
													status: "registering",
												},
											})
										: event,
								);
							},
						},
					],
				});
			}
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
			if (mode === "foreign-camp-before-generation") {
				expect(result.outcome).toBe("rejected");
				expect(result.reasons?.[0]?.code).toBe("camp-yard-mismatch");
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)).toBeUndefined();
				expect(authority.read(now).reservedMicros).toBe(0);
				return;
			}
			if (mode === "unverified-camp-before-generation") {
				expect(result.outcome).toBe("rejected");
				expect(result.reasons?.[0]?.code).toBe("camp-constraints-unverified");
				expect(authorizationCalls).toBe(0);
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)).toBeUndefined();
				expect(authority.read(now).reservedMicros).toBe(0);
				return;
			}
			if (mode === "exact-yard-mismatch-before-generation") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(authority.lookup(reservationId)).toBeUndefined();
				expect(authority.read(now).reservedMicros).toBe(0);
				expect(result.reasons?.[0]?.code).toBe(
					"yard-generation-exact-id-mismatch",
				);
				return;
			}
			if (mode === "wrong-generated-yard-id") {
				expect(result.outcome).toBe("rejected");
				expect(result.receipt).toBeUndefined();
				expect(result.reasons?.[0]?.code).toBe("yard-generation-id-mismatch");
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				return;
			}
			if (mode === "wrong-generation-attempt-id") {
				expect(result.outcome).toBe("rejected");
				expect(result.receipt).toBeUndefined();
				expect(result.reasons?.[0]?.code).toBe(
					"yard-generation-attempt-mismatch",
				);
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				return;
			}
			if (mode === "wrong-generated-yard-uncertainty-fails") {
				expect(result.outcome).toBe("rejected");
				expect(result.reasons?.[0]?.code).toBe("yard-generation-id-mismatch");
				expect(result.reasons?.[0]?.message).toMatch(
					/uncertain status could not be recorded/,
				);
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("held");
				expect(authority.read(now).reservedMicros).toBe(20);
				return;
			}
			if (
				mode === "generation-unrelated-ready-signal" ||
				mode === "generation-foreign-yard-signal" ||
				mode === "generation-signal-missing-attempt" ||
				mode === "generation-progress-missing-attempt" ||
				mode === "generation-signal-foreign-key" ||
				mode === "generation-signal-foreign-runtime" ||
				mode === "generation-signal-foreign-tenant" ||
				mode === "generation-normalizer-foreign-yard" ||
				mode === "generation-normalizer-forged-placement" ||
				mode === "generation-normalizer-ready-registration" ||
				mode === "generation-normalizer-ready-status" ||
				mode === "generation-normalizer-ready-no-attempt"
			) {
				expect(result.outcome).toBe("rejected");
				expect(result.reasons?.[0]?.code).toBe("yard-generation-uncertain");
				expect(result.receipt).toBeUndefined();
				expect(
					result.events.some((event) => event.type === YARD_EVENTS.Ready),
				).toBe(false);
				expect(
					result.events.some(
						(event) =>
							event.type === YARD_EVENTS.GenerationProgressed ||
							event.type === YARD_EVENTS.GenerationProvisioned,
					),
				).toBe(false);
				expect(result.foldState.yards["yard:unexpected"]).toBeUndefined();
				expect(
					result.foldState.yards[`yard:unexpected-${identitySuffix}`],
				).toBeUndefined();
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				return;
			}
			if (
				mode === "generation-not-ready-no-signal" ||
				mode === "generation-registered-no-signal"
			) {
				expect(result.outcome).toBe("rejected");
				expect(result.receipt).toBeUndefined();
				expect(result.reasons?.[0]?.code).toBe("yard-generation-not-ready");
				expect(provisionCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
				return;
			}
			if (mode === "invalid-residency-before-generation") {
				expect(result.outcome).toBe("rejected");
				expect(provisionCalls).toBe(0);
				expect(result.reasons?.[0]?.code).toBe("invalid-deployment-request");
				expect(authority.lookup(reservationId)).toBeUndefined();
				expect(authority.read(now).reservedMicros).toBe(0);
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
			if (mode === "generation-normalizer-mutable-event")
				expect(result.foldState.yards["yard:unexpected"]).toBeUndefined();
			if (mode === "generation-normalizer-sequence")
				expect(result.foldState.seq).toBeLessThan(1000);
			if (mode === "exact-yard-match-generation")
				expect(result.receipt?.selectedYardId).toBe(
					request.yard.requestedYardId,
				);
			expect(authority.read(now).reservedMicros).toBe(20);
			if (mode === "wrong-yard-on-inspect") {
				const retry = await resolveBindleDeployment(request, deps);
				expect(retry.outcome).toBe("rejected");
				expect(retry.reasons?.[0]?.code).toBe("yard-generation-id-mismatch");
				expect(provisionCalls).toBe(1);
				expect(inspectCalls).toBe(1);
				expect(authority.lookup(reservationId)?.status).toBe("uncertain");
			}
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
	it.each(
		generationModes,
	)("funds Azure generation before provider effects: %s", async (mode) =>
		exerciseGeneration(mode));
	it("refuses generated foreign signal identities before folding", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(
					"generation-unrelated-ready-signal",
					"generation-foreign-yard-signal",
					"generation-signal-missing-attempt",
					"generation-signal-foreign-key",
					"generation-signal-foreign-runtime",
					"generation-signal-foreign-tenant",
				),
				fc.string(),
				async (mode, suffix) =>
					exerciseGeneration(mode, Buffer.from(suffix).toString("hex")),
			),
			{ seed: 614_590, numRuns: 40 },
		);
	});
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
