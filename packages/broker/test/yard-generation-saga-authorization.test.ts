import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { YardGenerationPlan } from "../src/index.js";
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
		attemptId: "attempt:authorized",
	});
	if (!decision.allowed) throw new Error(decision.reason);
	return { connector, plan: decision.plan };
}

describe("standalone Yard generation authorization", () => {
	it("does not provision a plan without an explicit host authorization", async () => {
		const { connector, plan } = fixture();
		const provision = vi.fn(async (received: YardGenerationPlan) => ({
			attemptId: received.attemptId,
			status: "ready" as const,
			yardId: received.expectedYardId,
			externalRefs: {},
			outputHash: contentHashOf("ready"),
		}));
		const saga = createYardGenerationSaga({
			connectors: new Map([[connector.id, { ...connector, provision }]]),
		});
		const result = await saga.run(plan);
		expect(result.status).toBe("failed");
		expect(result.failure?.code).toBe("generation-authorization-required");
		expect(provision).not.toHaveBeenCalled();
	});

	it("provisions only after an explicit host decision", async () => {
		const { connector, plan } = fixture();
		const provision = vi.fn(connector.provision.bind(connector));
		const authorizePlan = vi.fn(
			(candidate: YardGenerationPlan) =>
				contentHashOf(candidate) === contentHashOf(plan),
		);
		const saga = createYardGenerationSaga({
			authorizePlan,
			connectors: new Map([[connector.id, { ...connector, provision }]]),
		});
		expect((await saga.run(plan)).status).toBe("ready");
		expect(authorizePlan).toHaveBeenCalledTimes(3);
		expect(provision).toHaveBeenCalledTimes(1);
	});

	it.each([
		"denied",
		"throws",
		"mutates-plan",
		"replaces-decision",
	] as const)("does not call the provider when the host decision %s", async (mode) => {
		const { connector, plan } = fixture();
		const provision = vi.fn(connector.provision.bind(connector));
		const options = {
			connectors: new Map([[connector.id, { ...connector, provision }]]),
			authorizePlan(candidate: YardGenerationPlan): boolean {
				if (mode === "denied") return false;
				if (mode === "throws") throw new Error("decision unavailable");
				if (mode === "mutates-plan")
					Object.assign(candidate.inputs, { ownerTenantId: "other" });
				if (mode === "replaces-decision") options.authorizePlan = () => true;
				return true;
			},
		};
		const saga = createYardGenerationSaga(options);
		const result = await saga.run(plan);
		expect(result.failure?.code).toBe("generation-authorization-denied");
		expect(provision).not.toHaveBeenCalled();
		options.authorizePlan = () => true;
		expect(saga.inspect(plan.idempotencyKey)).toBeUndefined();
	});

	it("rechecks a revoked decision at the provider boundary", async () => {
		const { connector, plan } = fixture();
		const provision = vi.fn(connector.provision.bind(connector));
		let allowed = true;
		let calls = 0;
		const saga = createYardGenerationSaga({
			connectors: new Map([[connector.id, { ...connector, provision }]]),
			authorizePlan() {
				if (++calls === 1)
					queueMicrotask(() => {
						allowed = false;
					});
				return allowed;
			},
		});
		const result = await saga.run(plan);
		expect(result.failure?.code).toBe("generation-authorization-denied");
		expect(provision).not.toHaveBeenCalled();
		allowed = true;
		expect(saga.inspect(plan.idempotencyKey)?.status).toBe("started");
	});

	it("rechecks authorization before returning a cached result", async () => {
		const { connector, plan } = fixture();
		const provision = vi.fn(connector.provision.bind(connector));
		let allowed = true;
		const saga = createYardGenerationSaga({
			connectors: new Map([[connector.id, { ...connector, provision }]]),
			authorizePlan: () => allowed,
		});
		expect((await saga.run(plan)).status).toBe("ready");
		allowed = false;
		expect((await saga.run(plan)).failure?.code).toBe(
			"generation-authorization-denied",
		);
		expect(provision).toHaveBeenCalledTimes(1);
	});

	it("does not expose a cached result through inspection after authorization is revoked", async () => {
		const { connector, plan } = fixture();
		let allowed = true;
		const saga = createYardGenerationSaga({
			connectors: new Map([[connector.id, connector]]),
			authorizePlan: () => allowed,
		});
		expect((await saga.run(plan)).status).toBe("ready");
		allowed = false;
		expect(saga.inspect(plan.idempotencyKey)).toBeUndefined();
		allowed = true;
		expect(saga.inspect(plan.idempotencyKey)?.status).toBe("ready");
	});

	it.each([
		"throws",
		"mutates-plan",
		"replaces-decision",
	] as const)("refuses inspection when its host decision %s", async (mode) => {
		const { connector, plan } = fixture();
		const options = {
			connectors: new Map([[connector.id, connector]]),
			authorizePlan: (_candidate: YardGenerationPlan): boolean => true,
		};
		const saga = createYardGenerationSaga(options);
		expect((await saga.run(plan)).status).toBe("ready");
		options.authorizePlan = (candidate) => {
			if (mode === "throws") throw new Error("decision unavailable");
			if (mode === "mutates-plan")
				Object.assign(candidate.inputs, { ownerTenantId: "other" });
			if (mode === "replaces-decision") options.authorizePlan = () => true;
			return true;
		};
		expect(saga.inspect(plan.idempotencyKey)).toBeUndefined();
		options.authorizePlan = () => true;
		expect(saga.inspect(plan.idempotencyKey)?.status).toBe("ready");
	});

	it("keeps the inspection plan separate from the provider's input", async () => {
		const { connector, plan } = fixture();
		const seenTenants: string[] = [];
		const saga = createYardGenerationSaga({
			connectors: new Map([
				[
					connector.id,
					{
						...connector,
						async provision(received: YardGenerationPlan) {
							Object.assign(received.inputs, { ownerTenantId: "other" });
							return connector.provision(received);
						},
					},
				],
			]),
			authorizePlan(candidate) {
				seenTenants.push(String(candidate.inputs.ownerTenantId));
				return candidate.inputs.ownerTenantId === "tenant";
			},
		});
		expect((await saga.run(plan)).status).toBe("ready");
		expect(saga.inspect(plan.idempotencyKey)?.status).toBe("ready");
		expect(seenTenants).toEqual(["tenant", "tenant", "tenant", "tenant"]);
	});

	it("enforces the current inspection decision for generated cases", async () => {
		await fc.assert(
			fc.asyncProperty(fc.boolean(), async (allowed) => {
				const { connector, plan } = fixture();
				let current = true;
				const saga = createYardGenerationSaga({
					connectors: new Map([[connector.id, connector]]),
					authorizePlan: () => current,
				});
				await saga.run(plan);
				current = allowed;
				expect(Boolean(saga.inspect(plan.idempotencyKey))).toBe(allowed);
			}),
			{ seed: 614_600, numRuns: 40 },
		);
	});

	it("does not return an in-flight result to callers whose authorization is revoked", async () => {
		const { connector, plan } = fixture();
		let resume = () => {};
		let started = () => {};
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const provision = vi.fn(async (candidate: YardGenerationPlan) => {
			started();
			await waiting;
			return connector.provision(candidate);
		});
		let allowed = true;
		const saga = createYardGenerationSaga({
			connectors: new Map([[connector.id, { ...connector, provision }]]),
			authorizePlan: () => allowed,
		});
		const first = saga.run(plan);
		await entered;
		const retry = saga.run(plan);
		allowed = false;
		resume();
		const results = await Promise.all([first, retry]);
		expect(results.map((result) => result.failure?.code)).toEqual([
			"generation-authorization-denied",
			"generation-authorization-denied",
		]);
		expect(provision).toHaveBeenCalledTimes(1);
		expect(saga.inspect(plan.idempotencyKey)).toBeUndefined();
		allowed = true;
		expect(saga.inspect(plan.idempotencyKey)?.status).toBe("ready");
	});

	it("does not return a provider error after authorization is revoked", async () => {
		const { connector, plan } = fixture();
		let resume = () => {};
		let started = () => {};
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const provision = vi.fn(async () => {
			started();
			await waiting;
			throw new Error("provider detail");
		});
		let allowed = true;
		const saga = createYardGenerationSaga({
			connectors: new Map([[connector.id, { ...connector, provision }]]),
			authorizePlan: () => allowed,
		});
		const first = saga.run(plan);
		await entered;
		const retry = saga.run(plan);
		allowed = false;
		resume();
		const outcomes = await Promise.allSettled([first, retry]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual([
			"fulfilled",
			"fulfilled",
		]);
		const results = outcomes.flatMap((outcome) =>
			outcome.status === "fulfilled" ? [outcome.value] : [],
		);
		expect(results.map((result) => result.failure?.code)).toEqual([
			"generation-authorization-denied",
			"generation-authorization-denied",
		]);
		allowed = true;
		expect(saga.inspect(plan.idempotencyKey)?.status).toBe("started");
	});

	it("checks each waiting caller separately when the provider finishes", async () => {
		const { connector, plan } = fixture();
		let resume = () => {};
		let started = () => {};
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		let completed = false;
		let deliveries = 0;
		const provision = vi.fn(async (candidate: YardGenerationPlan) => {
			started();
			await waiting;
			const result = await connector.provision(candidate);
			completed = true;
			return result;
		});
		const saga = createYardGenerationSaga({
			connectors: new Map([[connector.id, { ...connector, provision }]]),
			authorizePlan: () => !completed || ++deliveries === 1,
		});
		const first = saga.run(plan);
		await entered;
		const retry = saga.run(plan);
		resume();
		const results = await Promise.all([first, retry]);
		expect(results.map((result) => result.status).sort()).toEqual([
			"failed",
			"ready",
		]);
		expect(deliveries).toBe(2);
		expect(provision).toHaveBeenCalledTimes(1);
	});

	it("checks generated provider outcomes and authorization changes for all waiters", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				async (revoked, throws, retry) => {
					const { connector, plan } = fixture();
					let resume = () => {};
					let started = () => {};
					const waiting = new Promise<void>((resolve) => {
						resume = resolve;
					});
					const entered = new Promise<void>((resolve) => {
						started = resolve;
					});
					let allowed = true;
					const provision = vi.fn(async (candidate: YardGenerationPlan) => {
						started();
						await waiting;
						if (throws) throw new Error("provider detail");
						return connector.provision(candidate);
					});
					const saga = createYardGenerationSaga({
						connectors: new Map([[connector.id, { ...connector, provision }]]),
						authorizePlan: () => allowed,
					});
					const first = saga.run(plan);
					await entered;
					const requests = retry ? [first, saga.run(plan)] : [first];
					allowed = !revoked;
					resume();
					const outcomes = await Promise.allSettled(requests);
					for (const outcome of outcomes) {
						if (revoked) {
							expect(outcome.status).toBe("fulfilled");
							if (outcome.status === "fulfilled")
								expect(outcome.value.failure?.code).toBe(
									"generation-authorization-denied",
								);
						} else if (throws) {
							expect(outcome.status).toBe("rejected");
						} else {
							expect(outcome.status).toBe("fulfilled");
							if (outcome.status === "fulfilled")
								expect(outcome.value.status).toBe("ready");
						}
					}
					expect(provision).toHaveBeenCalledTimes(1);
					allowed = true;
					expect(saga.inspect(plan.idempotencyKey)?.status).toBe(
						throws ? "started" : "ready",
					);
				},
			),
			{ seed: 614_601, numRuns: 32 },
		);
	});

	it("does not expose the provider's plan to a retained authorization input", async () => {
		const { connector, plan } = fixture();
		let observedTenant = "";
		let decisions = 0;
		const provision = vi.fn(async (received: YardGenerationPlan) => {
			await Promise.resolve();
			observedTenant = String(received.inputs.ownerTenantId);
			return connector.provision(received);
		});
		const saga = createYardGenerationSaga({
			connectors: new Map([[connector.id, { ...connector, provision }]]),
			authorizePlan(candidate) {
				if (++decisions === 2)
					queueMicrotask(() => {
						Object.assign(candidate.inputs, { ownerTenantId: "other" });
					});
				return true;
			},
		});
		await saga.run(plan);
		expect(provision).toHaveBeenCalledTimes(1);
		expect(observedTenant).toBe("tenant");
	});

	it("requires both initial and provider-boundary decisions for generated cases", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.boolean(),
				fc.boolean(),
				async (initial, boundary) => {
					const { connector, plan } = fixture();
					const provision = vi.fn(connector.provision.bind(connector));
					let calls = 0;
					const saga = createYardGenerationSaga({
						connectors: new Map([[connector.id, { ...connector, provision }]]),
						authorizePlan: () => (++calls === 1 ? initial : boundary),
					});
					const result = await saga.run(plan);
					expect(provision.mock.calls.length).toBe(initial && boundary ? 1 : 0);
					expect(result.status).toBe(initial && boundary ? "ready" : "failed");
				},
			),
			{ seed: 614_599, numRuns: 40 },
		);
	});
});
