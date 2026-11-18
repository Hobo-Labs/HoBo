import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	buildDeploymentRequestFromParts,
	contentHashOf,
	createLocalHostCatalog,
	createLocalYardGenerationConnector,
	createYardGenerationSaga,
	createYardInventory,
	createYardRuntimeCatalog,
	DEFAULT_YARD_GENERATION_POLICY,
	LOCAL_HOST_PROVIDER_ID,
	localYardInstance,
	matchYard,
	parseBindleDeploymentRequest,
	parseYardLayout,
	planYardGeneration,
	prepareYardHostingWork,
	resolveBindleDeployment,
} from "../src/index.js";
import { cloneAsJson } from "../src/json.js";
import { rejectionMatrixRow } from "../src/rejections.js";
import { layoutSubsetCompatible } from "../src/yard-placement/matching.js";
import { approveLocalHosting } from "./helpers/local-hosting.js";

const kinds = [
	"require",
	"runtimeRequirements",
	"labels",
	"yardCamps",
] as const;
type Kind = (typeof kinds)[number];

function request(kind?: Kind, value = "special") {
	const base = buildDeploymentRequestFromParts({
		bindleName: "shop",
		providerId: LOCAL_HOST_PROVIDER_ID,
		yardId: "yard:local-main",
		resources: [],
	});
	const campLayout =
		kind === "labels"
			? { labels: { [value]: "required" } }
			: kind === "require" || kind === "runtimeRequirements"
				? { [kind]: [value] }
				: {};
	return parseBindleDeploymentRequest(
		cloneAsJson({
			...base,
			yard: {
				...base.yard,
				requestedLayout: {
					...base.yard.requestedLayout,
					camps: kind === "yardCamps" ? [{ id: value }] : [],
				},
			},
			camp: { selectionMode: "compatible", layout: campLayout },
		}),
	);
}

async function checkRefusal(kind: Kind, value: string) {
	const input = request(kind, value);
	const catalog = createLocalHostCatalog();
	const quote = prepareYardHostingWork({
		request: input,
		brokerId: "broker:test",
		ownerTenantId: "local",
		catalog,
		yardId: "yard:local-main",
		providerId: LOCAL_HOST_PROVIDER_ID,
	});
	expect(quote).toMatchObject({ code: "camp-constraints-unverified" });
	let approvals = 0;
	const result = await resolveBindleDeployment(input, {
		brokerId: "broker:test",
		catalog,
		authorizeLocalHosting: (context) => {
			approvals++;
			return approveLocalHosting(context);
		},
	});
	expect(result.outcome).toBe("rejected");
	expect(result.reasons?.[0]?.code).toBe("camp-constraints-unverified");
	expect(rejectionMatrixRow("camp-constraints-unverified")).toMatchObject({
		plane: "placement",
	});
	expect(result.receipt).toBeUndefined();
	expect(result.events).toHaveLength(0);
	expect(approvals).toBe(0);
}

describe("Camp constraint admission", () => {
	it.each(
		kinds,
	)("refuses unverified %s before quote or authorization", async (kind) => {
		await checkRefusal(kind, "special");
	});

	it("retains placement when no unsupported Camp requirements are present", async () => {
		const result = await resolveBindleDeployment(request(), {
			brokerId: "broker:test",
			catalog: createLocalHostCatalog(),
			authorizeLocalHosting: approveLocalHosting,
		});
		expect(result.outcome).toBe("resolved");
	});

	it.each([
		"__proto__",
		"constructor",
		"toString",
	])("refuses the special Camp label key %s", async (key) =>
		checkRefusal("labels", key));

	it("refuses generated hard Camp constraints", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...kinds),
				fc.string(),
				async (kind, value) => {
					await checkRefusal(kind, `key-${value}`);
				},
			),
			{ seed: 614_593, numRuns: 40 },
		);
	});

	it("does not match nested Camp layouts even if the Yard repeats them", () => {
		const input = request("yardCamps");
		const yard = localYardInstance({
			yardId: "yard:local-main",
			ownerTenantId: "local",
			providerId: LOCAL_HOST_PROVIDER_ID,
		});
		const repeated = {
			...yard,
			layout: { ...yard.layout, camps: input.yard.requestedLayout.camps },
		};
		const inventory = createYardInventory("broker:test");
		inventory.apply({ type: "yard.Registered", yard: repeated });
		const decision = matchYard(
			{
				...input.yard,
				selectionMode: "compatible-or-generate",
				allowGenerationRequested: true,
			},
			inventory.snapshot(),
			{ ownerTenantId: "local" },
		);
		expect(decision.outcome).toBe("rejected");
		expect(
			layoutSubsetCompatible(
				input.yard.requestedLayout,
				repeated.layout,
				repeated.capabilities,
			),
		).toBe(false);
	});
});

describe("direct generation with nested Camp layouts", () => {
	const connector = createLocalYardGenerationConnector();
	const runtimes = createYardRuntimeCatalog();
	runtimes.register({
		schemaVersion: "hobo.yard-runtime/v1",
		runtimeId: "local-yard/v1",
		providerId: "local",
		version: "1",
		supportedLayout: { regions: [], capabilities: [], requireProperties: [] },
		resolverCatalogHash: contentHashOf("resolvers"),
		generatorConnectorId: connector.id,
		default: true,
		priority: 1,
		requiredPermissions: [],
		conformanceRef: "ref",
		conformanceHash: contentHashOf("conformance"),
		status: "approved",
	});
	const policy = {
		...DEFAULT_YARD_GENERATION_POLICY,
		effect: "allow-if-no-match" as const,
		requireApproval: false,
		requireAttestation: false,
	};
	const decide = (requestedLayout: ReturnType<typeof parseYardLayout>) =>
		planYardGeneration({
			ownerTenantId: "tenant",
			requestedLayout,
			runtimeCatalog: runtimes.snapshot(),
			policy,
			allowGenerationRequested: true,
			attemptId: "attempt:1",
		});

	it("refuses a nested Camp before creating a generation plan", () => {
		const layout = parseYardLayout({
			providerId: "local",
			camps: [{ id: "special" }],
		});
		expect(decide(layout).allowed).toBe(false);
		expect(decide(parseYardLayout({ providerId: "local" })).allowed).toBe(true);
	});

	it("refuses a self-consistent older plan before a connector call", async () => {
		const accepted = decide(parseYardLayout({ providerId: "local" }));
		if (!accepted.allowed) throw new Error("valid generation fixture denied");
		const layout = parseYardLayout({
			providerId: "local",
			camps: [{ id: "special" }],
		});
		const layoutHash = contentHashOf(layout);
		const idempotencyKey = contentHashOf({
			ownerTenantId: "tenant",
			layoutHash,
			runtimeId: accepted.runtime.runtimeId,
			runtimeVersion: accepted.runtime.version,
			brokerEnvironmentId: "default",
		});
		const { planHash: _oldHash, ...body } = accepted.plan;
		const invalidBody = {
			...body,
			requestedLayout: layout,
			requestedLayoutHash: layoutHash,
			idempotencyKey,
			expectedYardId: `yard:gen-${idempotencyKey.slice(7, 23)}`,
		};
		const invalidPlan = {
			...invalidBody,
			planHash: contentHashOf(invalidBody),
		};
		let calls = 0;
		const monitored = {
			...connector,
			async provision(input: typeof invalidPlan) {
				calls++;
				return connector.provision(input);
			},
		};
		const saga = createYardGenerationSaga({
			authorizePlan: () => true,
			connectors: new Map([[connector.id, monitored]]),
		});
		const result = await saga.run(invalidPlan);
		expect(result.status).toBe("failed");
		expect(result.failure?.code).toBe("camp-constraints-unverified");
		expect(calls).toBe(0);
	});

	it("refuses a nested Camp retry before returning a cached attempt", async () => {
		const accepted = decide(parseYardLayout({ providerId: "local" }));
		if (!accepted.allowed) throw new Error("valid generation fixture denied");
		let calls = 0;
		const monitored = {
			...connector,
			async provision(input: typeof accepted.plan) {
				calls++;
				return connector.provision(input);
			},
		};
		const saga = createYardGenerationSaga({
			authorizePlan: () => true,
			connectors: new Map([[connector.id, monitored]]),
		});
		await saga.run(accepted.plan);
		const retry = {
			...accepted.plan,
			requestedLayout: parseYardLayout({
				providerId: "local",
				camps: [{ id: "special" }],
			}),
		};
		const result = await saga.run(retry);
		expect(result.failure?.code).toBe("camp-constraints-unverified");
		expect(calls).toBe(1);
	});
});
