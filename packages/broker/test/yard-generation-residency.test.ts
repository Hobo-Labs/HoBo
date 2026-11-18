import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	contentHashOf,
	createLocalYardGenerationConnector,
	createYardGenerationSaga,
	createYardRuntimeCatalog,
	DEFAULT_YARD_GENERATION_POLICY,
	parseYardLayout,
	planYardGeneration,
} from "../src/index.js";

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
};
function plan(tag: string) {
	return planYardGeneration({
		ownerTenantId: "tenant",
		requestedLayout: parseYardLayout({ providerId: "local", residency: [tag] }),
		runtimeCatalog: runtimes.snapshot(),
		policy,
		allowGenerationRequested: true,
		attemptId: "attempt:1",
	});
}

describe("direct Yard generation residency", () => {
	it.each([
		"atlantis",
		"unknown:eu",
		"pii:atlantis",
	])("refuses to plan an invalid tag %s", (tag) => {
		const result = plan(tag);
		expect(result.allowed).toBe(false);
		if (result.allowed) throw new Error("invalid plan allowed");
		expect(result.reason).toMatch(/residency/);
	});

	it("allows planning a valid explicit residency tag", () => {
		expect(plan("pii:eu").allowed).toBe(true);
	});

	it("still invokes a connector for a valid plan", async () => {
		const accepted = plan("eu");
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
			connectors: new Map([[connector.id, monitored]]),
		});
		await saga.run(accepted.plan);
		expect(calls).toBe(1);
	});

	it("refuses generated invalid jurisdiction names", () => {
		fc.assert(
			fc.property(fc.string(), (value) => {
				expect(plan(`invalid-jurisdiction-${value}`).allowed).toBe(false);
			}),
			{ seed: 614_584, numRuns: 100 },
		);
	});

	it("does not call a connector for a self-consistent invalid plan", async () => {
		const accepted = plan("eu");
		if (!accepted.allowed) throw new Error("valid generation fixture denied");
		const layout = parseYardLayout({
			providerId: "local",
			residency: ["atlantis"],
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
			connectors: new Map([[connector.id, monitored]]),
		});
		const result = await saga.run(invalidPlan);
		expect(calls).toBe(0);
		expect(result.status).toBe("failed");
		expect(result.failure?.code).toBe("invalid-residency");
	});

	it("refuses an invalid retry before consulting a prior attempt", async () => {
		const accepted = plan("eu");
		if (!accepted.allowed) throw new Error("valid generation fixture denied");
		let provisionCalls = 0;
		let inspectCalls = 0;
		const monitored = {
			...connector,
			async provision(input: typeof accepted.plan) {
				provisionCalls++;
				return connector.provision(input);
			},
			async inspect(attemptId: string) {
				inspectCalls++;
				return connector.inspect(attemptId);
			},
		};
		const saga = createYardGenerationSaga({
			connectors: new Map([[connector.id, monitored]]),
		});
		await saga.run(accepted.plan);
		const invalidRetry = {
			...accepted.plan,
			requestedLayout: parseYardLayout({
				providerId: "local",
				residency: ["atlantis"],
			}),
		};
		const result = await saga.run(invalidRetry);
		expect(provisionCalls).toBe(1);
		expect(inspectCalls).toBe(0);
		expect(result.failure?.code).toBe("invalid-residency");
	});
});
