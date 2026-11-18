import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type {
	YardGenerationConnector,
	YardGenerationPlan,
	YardGenerationResult,
} from "../src/index.js";
import {
	contentHashOf,
	createLocalYardGenerationConnector,
	createYardGenerationSaga,
	createYardRuntimeCatalog,
	DEFAULT_YARD_GENERATION_POLICY,
	parseYardLayout,
	planYardGeneration,
} from "../src/index.js";

function fixture() {
	const base = createLocalYardGenerationConnector();
	const runtimes = createYardRuntimeCatalog();
	runtimes.register({
		schemaVersion: "hobo.yard-runtime/v1",
		runtimeId: "local-yard/v1",
		providerId: "local",
		version: "1",
		supportedLayout: { regions: [], capabilities: [], requireProperties: [] },
		resolverCatalogHash: contentHashOf("resolvers"),
		generatorConnectorId: base.id,
		default: true,
		priority: 1,
		requiredPermissions: [],
		conformanceRef: "ref",
		conformanceHash: contentHashOf("conformance"),
		status: "approved",
	});
	const decision = planYardGeneration({
		ownerTenantId: "tenant",
		requestedLayout: parseYardLayout({ providerId: "local" }),
		runtimeCatalog: runtimes.snapshot(),
		policy: {
			...DEFAULT_YARD_GENERATION_POLICY,
			effect: "allow-if-no-match",
			requireApproval: false,
			requireAttestation: false,
		},
		allowGenerationRequested: true,
		attemptId: "attempt:1",
	});
	if (!decision.allowed) throw new Error(decision.reason);
	return { plan: decision.plan, base };
}

function result(
	plan: YardGenerationPlan,
	status: "ready" | "started",
): YardGenerationResult {
	return {
		attemptId: plan.attemptId,
		status,
		yardId: plan.expectedYardId,
		externalRefs: {},
		outputHash: contentHashOf(status),
	};
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

describe("Yard generation saga identity and concurrent retries", () => {
	it("shares one pending provision instead of inspecting an unfinished call", async () => {
		const { plan, base } = fixture();
		const gate = deferred();
		const provision = vi.fn(async (input: YardGenerationPlan) => {
			await gate.promise;
			return result(input, "ready");
		});
		const inspect = vi.fn(async () => result(plan, "started"));
		const connector: YardGenerationConnector = { ...base, provision, inspect };
		const saga = createYardGenerationSaga({
			authorizePlan: () => true,
			connectors: new Map([[base.id, connector]]),
		});
		const first = saga.run(plan);
		const second = saga.run(structuredClone(plan));
		gate.resolve();
		const outcomes = await Promise.all([first, second]);
		expect(provision).toHaveBeenCalledTimes(1);
		expect(inspect).not.toHaveBeenCalled();
		expect(outcomes.map((value) => value.status)).toEqual(["ready", "ready"]);
	});

	it("shares one inspection after an uncertain provider failure", async () => {
		const { plan, base } = fixture();
		const gate = deferred();
		const provision = vi.fn(async () => {
			throw new Error("provider reply lost");
		});
		const inspect = vi.fn(async () => {
			await gate.promise;
			return result(plan, "ready");
		});
		const saga = createYardGenerationSaga({
			authorizePlan: () => true,
			connectors: new Map([[base.id, { ...base, provision, inspect }]]),
		});
		await expect(saga.run(plan)).rejects.toThrow("provider reply lost");
		const first = saga.run(plan);
		const second = saga.run(structuredClone(plan));
		gate.resolve();
		const outcomes = await Promise.all([first, second]);
		expect(provision).toHaveBeenCalledTimes(1);
		expect(inspect).toHaveBeenCalledTimes(1);
		expect(outcomes.map((value) => value.status)).toEqual(["ready", "ready"]);
	});

	it("refuses a different plan reusing a completed idempotency key", async () => {
		const { plan, base } = fixture();
		const provision = vi.fn(async (input: YardGenerationPlan) =>
			result(input, "ready"),
		);
		const inspect = vi.fn(async () => result(plan, "ready"));
		const saga = createYardGenerationSaga({
			authorizePlan: () => true,
			connectors: new Map([[base.id, { ...base, provision, inspect }]]),
		});
		await saga.run(plan);
		const conflict = await saga.run({ ...plan, attemptId: "attempt:other" });
		expect(conflict.status).toBe("failed");
		expect(conflict.failure?.code).toBe("generation-plan-conflict");
		expect(provision).toHaveBeenCalledTimes(1);
		expect(inspect).not.toHaveBeenCalled();
	});

	it("refuses a different plan while the original call is pending", async () => {
		const { plan, base } = fixture();
		const gate = deferred();
		const provision = vi.fn(async (input: YardGenerationPlan) => {
			await gate.promise;
			return result(input, "ready");
		});
		const inspect = vi.fn(async () => result(plan, "started"));
		const saga = createYardGenerationSaga({
			authorizePlan: () => true,
			connectors: new Map([[base.id, { ...base, provision, inspect }]]),
		});
		const first = saga.run(plan);
		const conflict = await saga.run({ ...plan, attemptId: "attempt:other" });
		gate.resolve();
		await first;
		expect(conflict.failure?.code).toBe("generation-plan-conflict");
		expect(provision).toHaveBeenCalledTimes(1);
		expect(inspect).not.toHaveBeenCalled();
	});

	it("snapshots a provider result before caching or returning it", async () => {
		const { plan, base } = fixture();
		const providerResult = result(plan, "ready");
		const saga = createYardGenerationSaga({
			authorizePlan: () => true,
			connectors: new Map([
				[base.id, { ...base, provision: async () => providerResult }],
			]),
		});
		const received = await saga.run(plan);
		expect(Object.isFrozen(providerResult.externalRefs)).toBe(false);
		Object.assign(providerResult, { status: "failed" });
		Object.assign(providerResult.externalRefs, { foreign: "changed" });
		expect(received.status).toBe("ready");
		expect(saga.inspect(plan.idempotencyKey)?.externalRefs).toEqual({});
		expect(Object.isFrozen(received)).toBe(true);
		expect(Object.isFrozen(received.externalRefs)).toBe(true);
	});

	it("pins the provider method before yielding to it", async () => {
		const { plan, base } = fixture();
		const approved = vi.fn(async (input: YardGenerationPlan) =>
			result(input, "ready"),
		);
		const replacement = vi.fn(async (input: YardGenerationPlan) =>
			result(input, "started"),
		);
		const connector = { ...base, provision: approved };
		const saga = createYardGenerationSaga({
			authorizePlan: () => true,
			connectors: new Map([[base.id, connector]]),
		});
		const pending = saga.run(plan);
		connector.provision = replacement;
		await pending;
		expect(approved).toHaveBeenCalledTimes(1);
		expect(replacement).not.toHaveBeenCalled();
	});

	it("snapshots the plan before awaiting a provider", async () => {
		const { plan, base } = fixture();
		const input = structuredClone(plan);
		const gate = deferred();
		let observed = "";
		const provision = vi.fn(async (received: YardGenerationPlan) => {
			await gate.promise;
			observed = String(received.inputs.ownerTenantId);
			return result(received, "ready");
		});
		const saga = createYardGenerationSaga({
			authorizePlan: () => true,
			connectors: new Map([[base.id, { ...base, provision }]]),
		});
		const pending = saga.run(input);
		Object.assign(input.inputs, { ownerTenantId: "other-tenant" });
		gate.resolve();
		await pending;
		expect(observed).toBe("tenant");
	});

	it("refuses generated conflicting attempts without another provider effect", async () => {
		await fc.assert(
			fc.asyncProperty(fc.string({ minLength: 1 }), async (suffix) => {
				const { plan, base } = fixture();
				const provision = vi.fn(async (input: YardGenerationPlan) =>
					result(input, "ready"),
				);
				const saga = createYardGenerationSaga({
					authorizePlan: () => true,
					connectors: new Map([[base.id, { ...base, provision }]]),
				});
				await saga.run(plan);
				const conflict = await saga.run({
					...plan,
					attemptId: `other:${suffix}`,
				});
				expect(conflict.failure?.code).toBe("generation-plan-conflict");
				expect(provision).toHaveBeenCalledTimes(1);
			}),
			{ seed: 614_596, numRuns: 30 },
		);
	});
});
