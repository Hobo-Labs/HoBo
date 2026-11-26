import { describe, expect, it } from "vitest";

import {
	BINDLE_DEPLOYMENT_REQUEST_SCHEMA,
	buildDeploymentRequestFromParts,
	contentHashOf,
	createYardInventory,
	createYardRuntimeCatalog,
	DEFAULT_YARD_GENERATION_POLICY,
	LOCAL_HOST_PROVIDER_ID,
	localYardInstance,
	matchYard,
	planYardGeneration,
	resolveBindleDeployment,
	YARD_EVENTS,
	yardEvent,
} from "../src/index.js";
import { createLocalHostCatalog } from "../src/local-host.js";

describe("yard-first placement", () => {
	it("matches an existing ready yard before generating", async () => {
		const catalog = createLocalHostCatalog();
		const yard = localYardInstance({
			yardId: "yard:local-main",
			ownerTenantId: "local",
			providerId: LOCAL_HOST_PROVIDER_ID,
		});
		const priorEvents = [
			yardEvent(YARD_EVENTS.Registered, { yard }),
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
		expect(result.receipt?.selectedYardId).toBe("yard:local-main");
		expect(result.receipt?.selectedProviderId).toBe(LOCAL_HOST_PROVIDER_ID);
		expect(
			result.placements.every((p) => p.providerId === LOCAL_HOST_PROVIDER_ID),
		).toBe(true);
		// Bindle destroy must not destroy yard/camp/shared units.
		const units = result.receipt?.executionUnits ?? [];
		expect(units.find((u) => u.kind === "yard")?.destroyWithBindle).toBe(false);
		expect(units.find((u) => u.kind === "shared")?.destroyWithBindle).toBe(
			false,
		);
		expect(units.find((u) => u.kind === "bindle")?.destroyWithBindle).toBe(
			true,
		);
		expect(
			result.events.some((e) => e.type === YARD_EVENTS.PlacementResolved),
		).toBe(true);
	});

	it("denies generation by default", () => {
		const runtimes = createYardRuntimeCatalog();
		runtimes.register({
			schemaVersion: "hobo.yard-runtime/v1",
			runtimeId: "azure-yard/v1",
			providerId: "azure",
			version: "1",
			supportedLayout: {
				regions: ["eastus2"],
				capabilities: [],
				requireProperties: [],
			},
			resolverCatalogHash: contentHashOf("r"),
			generatorConnectorId: "conn-azure-yard",
			default: true,
			priority: 10,
			requiredPermissions: [],
			conformanceRef: "ref",
			conformanceHash: contentHashOf("c"),
			status: "approved",
		});
		const decision = planYardGeneration({
			ownerTenantId: "t1",
			requestedLayout: {
				providerId: "azure",
				regions: [],
				require: [],
				prefer: [],
				residency: [],
				isolation: [],
				network: [],
				componentHosts: [],
				labels: {},
				properties: {},
				camps: [],
			},
			runtimeCatalog: runtimes.snapshot(),
			policy: DEFAULT_YARD_GENERATION_POLICY,
			allowGenerationRequested: true,
			attemptId: "a1",
		});
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toMatch(/denies generation/i);
	});

	it("exact mode does not silently substitute another yard", () => {
		const inventory = createYardInventory("broker:test");
		inventory.apply({
			type: "yard.Registered",
			yard: localYardInstance({
				yardId: "yard:other",
				ownerTenantId: "local",
				providerId: LOCAL_HOST_PROVIDER_ID,
			}),
		});
		const snap = inventory.snapshot();
		const decision = matchYard(
			{
				requestId: "r1",
				selectionMode: "exact",
				requestedYardId: "yard:missing",
				requestedLayout: {
					providerId: LOCAL_HOST_PROVIDER_ID,
					regions: [],
					require: [],
					prefer: [],
					residency: [],
					isolation: [],
					network: [],
					componentHosts: [],
					labels: {},
					properties: {},
					camps: [],
				},
				bindleManifestHash: contentHashOf("m"),
				bindleRequirementsHash: contentHashOf("req"),
				allowGenerationRequested: false,
			},
			snap,
			{ ownerTenantId: "local" },
		);
		expect(decision.outcome).toBe("rejected");
		expect(decision.winnerYardId).toBeUndefined();
	});

	it("parses deployment request schema", () => {
		const req = buildDeploymentRequestFromParts({
			bindleName: "x",
			resources: [],
		});
		expect(req.schemaVersion).toBe(BINDLE_DEPLOYMENT_REQUEST_SCHEMA);
	});
});

describe("residency hard filter (ADR-0146)", () => {
	function residencyLayout(residency: readonly string[]) {
		return {
			regions: [],
			require: [],
			prefer: [],
			residency: [...residency],
			isolation: [],
			network: [],
			componentHosts: [],
			labels: {},
			properties: {},
			camps: [],
		};
	}

	function residencyRequest(residency: readonly string[]) {
		return {
			requestId: "r-res",
			selectionMode: "compatible" as const,
			requestedLayout: residencyLayout(residency),
			bindleManifestHash: contentHashOf("m"),
			bindleRequirementsHash: contentHashOf("req"),
			allowGenerationRequested: false,
		};
	}

	function snapshotWith(options: Parameters<typeof localYardInstance>[0]) {
		const inventory = createYardInventory("broker:test");
		inventory.apply({
			type: "yard.Registered",
			yard: localYardInstance(options),
		});
		inventory.apply({
			type: "yard.StatusChanged",
			yardId: options.yardId,
			status: "ready",
			observedAt: new Date(0).toISOString(),
		});
		return inventory.snapshot();
	}

	it("accepts a yard whose declared regions sit inside the required jurisdiction", () => {
		const snap = snapshotWith({
			yardId: "yard:eu",
			ownerTenantId: "local",
			providerId: LOCAL_HOST_PROVIDER_ID,
			regions: ["eu-west-1"],
		});
		const decision = matchYard(residencyRequest(["eu"]), snap, {
			ownerTenantId: "local",
		});
		expect(decision.outcome).toBe("existing-yard");
		expect(decision.winnerYardId).toBe("yard:eu");
	});

	it("fails closed when the yard's regions fall outside the jurisdiction", () => {
		const snap = snapshotWith({
			yardId: "yard:us",
			ownerTenantId: "local",
			providerId: LOCAL_HOST_PROVIDER_ID,
			regions: ["us-east-1"],
		});
		const decision = matchYard(residencyRequest(["pii:eu"]), snap, {
			ownerTenantId: "local",
		});
		expect(decision.outcome).toBe("rejected");
		expect(
			decision.candidates[0]?.hardFailures.some((f) =>
				f.startsWith("residency-conflict:pii:eu"),
			),
		).toBe(true);
	});

	it("accepts an explicit residency guarantee from a local yard", () => {
		const snap = snapshotWith({
			yardId: "yard:local",
			ownerTenantId: "local",
			providerId: LOCAL_HOST_PROVIDER_ID,
			residency: ["eu"],
		});
		const decision = matchYard(residencyRequest(["eu"]), snap, {
			ownerTenantId: "local",
		});
		expect(decision.outcome).toBe("existing-yard");
	});

	it("rejects invalid residency tags rather than guessing", () => {
		const snap = snapshotWith({
			yardId: "yard:any",
			ownerTenantId: "local",
			providerId: LOCAL_HOST_PROVIDER_ID,
			regions: ["eu-west-1"],
		});
		const decision = matchYard(residencyRequest(["atlantis"]), snap, {
			ownerTenantId: "local",
		});
		expect(decision.outcome).toBe("rejected");
		expect(
			decision.candidates[0]?.hardFailures.includes(
				"residency-invalid:atlantis",
			),
		).toBe(true);
	});
});
