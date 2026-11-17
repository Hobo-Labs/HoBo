import { createHash } from "node:crypto";
import {
	createTargetPricingInventory,
	targetPricingModel,
	targetPricingUnavailable,
} from "@hobo/pricing";
import { describe, expect, it, vi } from "vitest";
import {
	makeScenario,
	perUnitCharge,
	usage,
	workload,
} from "../../pricing/test/fixtures.js";
import {
	executeRankedIacTargets as executeWithAuthority,
	rankIacTargets,
} from "../src/iac-target-routing.js";

// These combinatorial dispatcher tests isolate routing decisions; separate tests
// exercise the actual SQLite authority and cross-process claim semantics.
function executeRankedIacTargets(
	input: Omit<
		Parameters<typeof executeWithAuthority>[0],
		"authority" | "tenantId" | "operation"
	>,
) {
	const authority = {
		persistence: "durable-cas" as const,
		claim: ({
			tenantId,
			requestId,
			operationId,
		}: {
			tenantId: string;
			requestId: string;
			operationId: string;
		}) => ({
			tenantId,
			requestId,
			operationId,
			status: "claimed" as const,
			claimToken: "A".repeat(43),
		}),
		inspect: () => undefined,
		beginAttempt: ({
			tenantId,
			requestId,
			targetId,
			inventoryHash,
			operationId,
		}: {
			tenantId: string;
			requestId: string;
			targetId: string;
			inventoryHash: string;
			operationId: string;
		}) => ({
			tenantId,
			requestId,
			targetId,
			inventoryHash,
			operationId,
			attemptId: "B".repeat(43),
		}),
		denyAttempt: () => ({ status: "denied" as const }),
		finish: ({
			outcome,
		}: {
			outcome: import("../src/iac-route.js").IacRouteOutcome;
		}) => ({ status: "finished" as const, outcome }),
		verifyAttempt: () => true,
		consumeAttempt: () => true,
	};
	const candidates = input.candidates.map((candidate) => ({
		...candidate,
		run: async (
			requestId: string,
			expected: import("../src/iac-target-routing.js").IacRoutingExpectation,
			permit: import("../src/iac-route.js").IacRoutePermit,
		) => {
			if (!authority.consumeAttempt()) throw new Error("permit consumed");
			return candidate.run(requestId, expected, permit);
		},
	}));
	return executeWithAuthority({
		...input,
		candidates,
		authority,
		tenantId: "tenant-a",
		operation: {
			operationId: `sha256:${createHash("sha256").update(input.requestId).digest("hex")}`,
			authorization: "host-proof",
		},
	});
}

const digest = `sha256:${"a".repeat(64)}`;
function candidate(targetId: string, price: string) {
	const scenario = makeScenario({
		charges: [perUnitCharge("runtime", "minute", price)],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
	});
	const inventory = createTargetPricingInventory({
		targetId,
		tenantId: "tenant-a",
		planDigest: digest,
		complete: true,
		evidenceRef: "inventory:1",
		resources: [
			{
				resourceId: "service",
				providerId: "sandbox",
				providerAccountRef: "account-a",
				productId: "sandbox",
			},
		],
	});
	return {
		inventory,
		pricing: targetPricingModel({
			modelId: `terms-${targetId}`,
			revision: "1",
			planDigest: digest,
			scenario,
			bindings: [{ resourceId: "service", candidateIndex: 0 }],
		}),
		workloadRef: "workload:1",
	};
}
function request(candidates: ReturnType<typeof candidate>[]) {
	const first = candidates[0];
	if (
		first?.pricing.state.case !== "model" ||
		first.pricing.state.value.scenario === undefined
	)
		throw new Error("fixture missing");
	const { at, horizon, action } = first.pricing.state.value.scenario;
	return {
		tenantId: "tenant-a",
		workloadRef: "workload:1",
		at,
		horizon,
		action,
		candidates,
	};
}

describe("whole-target price ranking", () => {
	it.each([
		"root-accessor",
		"root-proxy",
		"root-revoked-proxy",
		"candidates-proxy",
		"candidate-proxy",
		"candidate-accessor",
		"inventory-accessor",
		"nested-proxy",
		"revoked-proxy",
		"missing-state",
		"sparse-candidates",
		"extra-array-property",
	] as const)("refuses %s before reading untrusted fields", (kind) => {
		const input = request([candidate("safe", "1")]);
		const first = input.candidates[0];
		if (!first) throw new Error("missing fixture");
		let traps = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted accessor");
		};
		const handler = {
			get: fail,
			getPrototypeOf: fail,
			ownKeys: fail,
			getOwnPropertyDescriptor: fail,
		};
		let received = input;
		if (kind === "root-accessor")
			Object.defineProperty(input, "tenantId", { enumerable: true, get: fail });
		if (kind === "root-proxy") received = new Proxy(input, handler);
		if (kind === "root-revoked-proxy") {
			const revoked = Proxy.revocable(input, handler);
			revoked.revoke();
			received = revoked.proxy;
		}
		if (kind === "candidates-proxy")
			input.candidates = new Proxy(input.candidates, handler);
		if (kind === "candidate-proxy")
			input.candidates[0] = new Proxy(first, handler);
		if (kind === "candidate-accessor")
			Object.defineProperty(first, "pricing", { enumerable: true, get: fail });
		if (kind === "inventory-accessor")
			Object.defineProperty(first.inventory, "targetId", {
				enumerable: true,
				get: fail,
			});
		if (kind === "nested-proxy") {
			const pricing = first.pricing;
			if (pricing.state.case !== "model") throw new Error("missing fixture");
			pricing.state.value = new Proxy(pricing.state.value, handler);
		}
		if (kind === "revoked-proxy") {
			const revoked = Proxy.revocable(first.inventory, handler);
			revoked.revoke();
			first.inventory = revoked.proxy;
		}
		if (kind === "missing-state")
			Reflect.deleteProperty(first.pricing, "state");
		if (kind === "sparse-candidates") input.candidates.length = 2;
		if (kind === "extra-array-property")
			Object.defineProperty(input.candidates, "extra", {
				value: "ignored",
				enumerable: true,
			});
		expect(rankIacTargets(received)).toMatchObject({
			code: "ROUTING_INPUT_INVALID",
			coverage: "partial",
			ranking: [],
			rejected: [],
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
		});
		expect(traps).toBe(0);
	});

	it("ranks complete targets and reports unknown prices and the absence of budget admission", () => {
		const expensive = candidate("expensive", "1");
		const cheap = candidate("cheap", "0.25");
		const unknown = candidate("unknown", "1");
		unknown.pricing = targetPricingUnavailable("no model");
		const result = rankIacTargets(request([expensive, cheap, unknown]));
		expect(result).toMatchObject({
			coverage: "partial",
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
			ranking: [
				{ targetId: "cheap", incrementalBilled: { decimal: "1" } },
				{ targetId: "expensive" },
			],
			rejected: [{ targetId: "unknown", code: "PRICING_MODEL_UNAVAILABLE" }],
		});
	});

	it.each([
		"inventory",
		"model",
	] as const)("retains a valid ranking beside an inspectable malformed %s", (kind) => {
		const good = candidate("good", "1");
		const malformed = candidate("bad", "1");
		if (kind === "inventory") {
			const resource = malformed.inventory.resources[0];
			if (!resource) throw new Error("missing fixture resource");
			Reflect.set(resource, "providerId", 123);
		} else Reflect.set(malformed.pricing, "unexpected", true);
		const result = rankIacTargets(request([good, malformed]));
		expect(result).toMatchObject({
			coverage: "partial",
			ranking: [{ targetId: "good" }],
			rejected: [{ targetId: "bad" }],
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
		});
		expect(result.rejected[0]?.code).not.toBe("PRICING_MODEL_UNAVAILABLE");
	});

	it.each([
		"text",
		"nodes",
	] as const)("bounds repeated aliased model %s across the whole request before cloning", (kind) => {
		const candidates = Array.from(
			{ length: kind === "text" ? 2 : 16 },
			(_, index) => candidate(`target-${index}`, "1"),
		);
		const first = candidates[0];
		if (!first) throw new Error("missing fixture");
		const input = request(candidates);
		const padding =
			kind === "text"
				? Array(600).fill("x".repeat(4096))
				: Array(1000).fill(Array(8).fill(0));
		Reflect.set(first.pricing, "padding", padding);
		for (const item of candidates) item.pricing = first.pricing;
		const clone = vi.spyOn(globalThis, "structuredClone");
		try {
			expect(rankIacTargets(input)).toMatchObject({
				code: "ROUTING_INPUT_INVALID",
				ranking: [],
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
			});
			expect(clone).not.toHaveBeenCalled();
		} finally {
			clone.mockRestore();
		}
	});

	it("checks cheap root fields and duplicate target IDs before cloning", () => {
		const first = candidate("first", "1");
		const invalidRootCandidate = candidate("invalid-root", "1");
		const invalidRoot = request([invalidRootCandidate]);
		invalidRoot.tenantId = "";
		let traps = 0;
		Object.defineProperty(invalidRootCandidate, "pricing", {
			enumerable: true,
			get: () => {
				traps++;
				throw new Error("candidate must not be read");
			},
		});
		const duplicate = request([first, first]);
		const clone = vi.spyOn(globalThis, "structuredClone");
		try {
			for (const input of [invalidRoot, duplicate]) {
				expect(rankIacTargets(input)).toMatchObject({
					code: "ROUTING_INPUT_INVALID",
					ranking: [],
					budget: { evaluation: "not-evaluated", reservation: "not-created" },
				});
			}
			expect(clone).not.toHaveBeenCalled();
			expect(traps).toBe(0);
		} finally {
			clone.mockRestore();
		}
	});

	it("accepts a bounded full-size batch with a shared unavailable model", () => {
		const candidates = Array.from({ length: 256 }, (_, index) =>
			candidate(`target-${index}`, "1"),
		);
		const input = request(candidates);
		const unavailable = targetPricingUnavailable("no model");
		for (const item of candidates) item.pricing = unavailable;
		const result = rankIacTargets(input);
		expect(result).toMatchObject({
			coverage: "partial",
			ranking: [],
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
		});
		expect(result.code).toBeUndefined();
		expect(result.rejected).toHaveLength(256);
		expect(
			result.rejected.every(
				(item) => item.code === "PRICING_MODEL_UNAVAILABLE",
			),
		).toBe(true);
	}, 15_000);

	it.each([
		"oversized-time",
		"oversized-target",
		"malformed-inventory",
	] as const)("does not rank %s data or imply budget admission", (kind) => {
		const input = request([candidate("safe", "1")]);
		const first = input.candidates[0];
		if (!first) throw new Error("missing fixture");
		if (kind === "oversized-time") input.at = "2".repeat(500);
		if (kind === "oversized-target") first.inventory.targetId = "x".repeat(500);
		if (kind === "malformed-inventory") {
			const resource = first.inventory.resources[0];
			if (!resource) throw new Error("missing fixture resource");
			Reflect.set(resource, "providerId", 123);
		}
		const result = rankIacTargets(input);
		expect(result).toMatchObject({
			coverage: "partial",
			ranking: [],
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
		});
		expect(
			result.rejected.every(
				(entry) => entry.code !== "PRICING_MODEL_UNAVAILABLE",
			),
		).toBe(true);
	});

	it("excludes different workloads, tenants or quote horizons", () => {
		const good = candidate("good", "1");
		const otherWorkload = {
			...candidate("other-workload", "1"),
			workloadRef: "workload:2",
		};
		const otherTenant = candidate("other-tenant", "1");
		otherTenant.inventory.tenantId = "tenant-b";
		const otherHorizon = candidate("other-horizon", "1");
		if (
			otherHorizon.pricing.state.case !== "model" ||
			otherHorizon.pricing.state.value.scenario === undefined
		)
			throw new Error("fixture missing");
		otherHorizon.pricing.state.value.scenario.horizon = "2026-01-10T00:00:00Z";
		const result = rankIacTargets(
			request([good, otherWorkload, otherTenant, otherHorizon]),
		);
		expect(result.ranking.map((entry) => entry.targetId)).toEqual(["good"]);
		expect(result.rejected.map((entry) => entry.code)).toEqual([
			"PRICING_NOT_COMPARABLE",
			"PRICING_NOT_COMPARABLE",
			"PRICING_NOT_COMPARABLE",
		]);
	});

	it("rejects duplicate target identifiers instead of choosing ambiguously", () => {
		const result = rankIacTargets(
			request([candidate("same", "1"), candidate("same", "2")]),
		);
		expect(result).toMatchObject({
			ranking: [],
			code: "ROUTING_INPUT_INVALID",
		});
	});
});

describe("budget-aware target execution", () => {
	function decision(
		targetId: string,
		status: "admitted" | "denied" | "uncertain" | "replay",
	) {
		const base = {
			requestId: "route-1",
			targetId,
			status,
			code:
				status === "denied"
					? "budget.exhausted"
					: status === "uncertain"
						? "RESERVATION_OUTCOME_UNKNOWN"
						: status === "replay"
							? "EXECUTION_ALREADY_CLAIMED"
							: "",
			message: "",
			budget:
				status === "denied"
					? { evaluation: "denied", reservation: "not-created" }
					: status === "uncertain"
						? { evaluation: "unavailable", reservation: "unknown" }
						: { evaluation: "allowed", reservation: "held" },
		};
		return status === "admitted" || status === "replay"
			? { ...base, reservation: { reservationId: "iac:route-1" } }
			: base;
	}
	it("tries the next ranked target only after a definitive refusal without a reservation", async () => {
		const ranking = rankIacTargets(
			request([candidate("cheap", "0.25"), candidate("expensive", "1")]),
		);
		const calls: string[] = [];
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async (id) => {
						calls.push(`${id}/cheap`);
						throw {
							requiresReconciliation: false,
							executionOutcome: "not-started",
							admission: decision("cheap", "denied"),
						};
					},
				},
				{
					targetId: "expensive",
					run: async (id, expected) => {
						calls.push(`${id}/expensive`);
						return {
							outputs: {},
							admission: { ...decision("expensive", "admitted"), ...expected },
						};
					},
				},
			],
		});
		expect(result).toMatchObject({
			status: "selected",
			targetId: "expensive",
			budget: { evaluation: "allowed", reservation: "held" },
			attempts: [
				{ targetId: "cheap", status: "denied" },
				{ targetId: "expensive", status: "admitted" },
			],
		});
		expect(calls).toEqual(["route-1/cheap", "route-1/expensive"]);
	});

	it.each([
		"error-proxy",
		"receipt-proxy",
		"budget-proxy",
		"reservation-accessor",
		"budget-accessor",
		"revoked-error",
		"error-inherited-reservation",
		"error-inherited-accessor",
		"error-proxy-prototype",
		"receipt-inherited-reservation",
		"receipt-proxy-prototype",
	] as const)("does not fall back on uninspectable %s denial evidence", async (kind) => {
		const ranking = rankIacTargets(
			request([candidate("cheap", "0.25"), candidate("expensive", "1")]),
		);
		let traps = 0;
		let next = 0;
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async () => {
						let admission = decision("cheap", "denied");
						if (kind === "reservation-accessor")
							Object.defineProperty(admission, "reservation", {
								get: () => {
									traps++;
									return undefined;
								},
							});
						if (kind === "budget-accessor")
							Object.defineProperty(admission.budget, "reservation", {
								get: () => {
									traps++;
									return "not-created";
								},
							});
						if (kind === "budget-proxy")
							admission.budget = new Proxy(admission.budget, {
								get: (target, key) => {
									traps++;
									return Object.getOwnPropertyDescriptor(target, key)?.value;
								},
							});
						if (kind === "receipt-proxy")
							admission = new Proxy(admission, {
								get: (target, key) => {
									traps++;
									return Object.getOwnPropertyDescriptor(target, key)?.value;
								},
							});
						if (kind === "receipt-inherited-reservation")
							Object.setPrototypeOf(admission, {
								reservation: { reservationId: "iac:route-1" },
							});
						if (kind === "receipt-proxy-prototype")
							Object.setPrototypeOf(
								admission,
								new Proxy(
									{},
									{
										getOwnPropertyDescriptor: () => {
											traps++;
											return undefined;
										},
									},
								),
							);
						const failure = {
							admission,
							requiresReconciliation: false,
							executionOutcome: "not-started",
						};
						if (kind === "error-inherited-reservation")
							Object.setPrototypeOf(failure, { reservationId: "iac:route-1" });
						if (kind === "error-inherited-accessor")
							Object.setPrototypeOf(
								failure,
								Object.defineProperty({}, "reservationId", {
									get: () => {
										traps++;
										return undefined;
									},
								}),
							);
						if (kind === "error-proxy-prototype")
							Object.setPrototypeOf(
								failure,
								new Proxy(
									{},
									{
										getOwnPropertyDescriptor: () => {
											traps++;
											return undefined;
										},
									},
								),
							);
						if (kind === "error-proxy")
							throw new Proxy(failure, {
								ownKeys: (target) => {
									traps++;
									return Reflect.ownKeys(target);
								},
							});
						if (kind === "revoked-error") {
							const revoked = Proxy.revocable(failure, {});
							revoked.revoke();
							throw revoked.proxy;
						}
						throw failure;
					},
				},
				{
					targetId: "expensive",
					run: async (_id, expected) => {
						next++;
						return {
							outputs: {},
							admission: { ...decision("expensive", "admitted"), ...expected },
						};
					},
				},
			],
		});
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
		expect(next).toBe(0);
		expect(traps).toBe(0);
	});

	it.each([
		"outputs-proxy",
		"outputs-accessor",
	] as const)("retains a hold without reading %s", async (kind) => {
		const ranking = rankIacTargets(request([candidate("cheap", "1")]));
		let traps = 0;
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async (_id, expected) => {
						const returned = {
							outputs: {},
							admission: { ...decision("cheap", "admitted"), ...expected },
						};
						if (kind === "outputs-proxy")
							returned.outputs = new Proxy(
								{},
								{
									getPrototypeOf: () => {
										traps++;
										return Object.prototype;
									},
								},
							);
						else
							Object.defineProperty(returned, "outputs", {
								get: () => {
									traps++;
									return {};
								},
							});
						return returned;
					},
				},
			],
		});
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "allowed", reservation: "held" },
			reservationId: "iac:route-1",
		});
		expect(traps).toBe(0);
	});

	it("retains a proven hold when an unrelated error field is an accessor", async () => {
		const ranking = rankIacTargets(request([candidate("cheap", "1")]));
		let traps = 0;
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async (_id, expected) => {
						const error = {
							admission: { ...decision("cheap", "admitted"), ...expected },
							reservationId: "iac:route-1",
							requiresReconciliation: true,
							executionOutcome: "unknown",
						};
						Object.defineProperty(error, "code", {
							get: () => {
								traps++;
								return "ERROR";
							},
						});
						throw error;
					},
				},
			],
		});
		expect(result).toMatchObject({
			status: "uncertain",
			reservationId: "iac:route-1",
			budget: { evaluation: "allowed", reservation: "held" },
		});
		expect(traps).toBe(0);
	});

	it.each([
		"returned-denial",
		"uncertain-denial",
		"receipt-with-reservation",
		"error-with-reservation",
	] as const)("does not fall back on an inconsistent %s", async (mode) => {
		const ranking = rankIacTargets(
			request([candidate("cheap", "0.25"), candidate("expensive", "1")]),
		);
		let next = 0;
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async () => {
						const admission = decision("cheap", "denied");
						if (mode === "returned-denial") return { outputs: {}, admission };
						if (mode === "receipt-with-reservation")
							throw {
								admission: {
									...admission,
									reservation: { reservationId: "iac:route-1" },
								},
							};
						if (mode === "error-with-reservation")
							throw { admission, reservationId: "iac:route-1" };
						throw { admission, requiresReconciliation: true };
					},
				},
				{
					targetId: "expensive",
					run: async (_id, expected) => {
						next++;
						return {
							outputs: {},
							admission: { ...decision("expensive", "admitted"), ...expected },
						};
					},
				},
			],
		});
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
		expect(next).toBe(0);
	});
	it("preserves a verified budget hold when execution completed but outputs are unavailable", async () => {
		const ranking = rankIacTargets(
			request([candidate("cheap", "0.25"), candidate("expensive", "1")]),
		);
		let next = 0;
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async (_id, expected) => {
						throw {
							code: "OUTPUT_UNREPRESENTABLE",
							requiresReconciliation: true,
							executionOutcome: "completed",
							reservationId: "iac:route-1",
							admission: { ...decision("cheap", "admitted"), ...expected },
						};
					},
				},
				{
					targetId: "expensive",
					run: async (_id, expected) => {
						next++;
						return {
							outputs: {},
							admission: { ...decision("expensive", "admitted"), ...expected },
						};
					},
				},
			],
		});
		expect(result).toMatchObject({
			status: "uncertain",
			code: "OUTPUT_UNREPRESENTABLE",
			targetId: "cheap",
			executionOutcome: "completed",
			reservationId: "iac:route-1",
			budget: { evaluation: "allowed", reservation: "held" },
		});
		expect(next).toBe(0);
	});
	it.each([
		"uncertain",
		"replay",
		"lost-error",
	] as const)("does not try another target after %s", async (mode) => {
		const ranking = rankIacTargets(
			request([candidate("cheap", "0.25"), candidate("expensive", "1")]),
		);
		let next = 0;
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async () => {
						if (mode === "lost-error") throw new Error("lost response");
						throw { admission: decision("cheap", mode) };
					},
				},
				{
					targetId: "expensive",
					run: async (_id, expected) => {
						next++;
						return {
							outputs: {},
							admission: { ...decision("expensive", "admitted"), ...expected },
						};
					},
				},
			],
		});
		expect(result.status).toBe(mode === "replay" ? "replay" : "uncertain");
		if (mode === "replay") expect(result.reservationId).toBe("iac:route-1");
		expect(next).toBe(0);
	});

	it("does not trust a replay receipt for a different reservation", async () => {
		const ranking = rankIacTargets(request([candidate("cheap", "1")]));
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async () => {
						throw {
							admission: {
								...decision("cheap", "replay"),
								reservation: { reservationId: "iac:other" },
							},
						};
					},
				},
			],
		});
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
	});
	it("treats a receipt for another request as uncertain and stops", async () => {
		const ranking = rankIacTargets(
			request([candidate("cheap", "0.25"), candidate("expensive", "1")]),
		);
		let next = 0;
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async () => {
						throw {
							admission: { ...decision("cheap", "denied"), requestId: "other" },
						};
					},
				},
				{
					targetId: "expensive",
					run: async (_id, expected) => {
						next++;
						return {
							outputs: {},
							admission: { ...decision("expensive", "admitted"), ...expected },
						};
					},
				},
			],
		});
		expect(result.status).toBe("uncertain");
		expect(next).toBe(0);
	});

	it("does not trust a successful receipt for a different reservation", async () => {
		const ranking = rankIacTargets(request([candidate("cheap", "1")]));
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async (_id, expected) => ({
						outputs: {},
						admission: {
							...decision("cheap", "admitted"),
							...expected,
							reservation: { reservationId: "iac:other" },
						},
					}),
				},
			],
		});
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
	});

	it.each([
		null,
		0,
		"invalid",
		[],
	])("stops safely on malformed admission %j", async (bad) => {
		const ranking = rankIacTargets(request([candidate("cheap", "1")]));
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async () => {
						throw { admission: bad };
					},
				},
			],
		});
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
	});

	it("treats throwing receipt accessors as uncertain", async () => {
		const ranking = rankIacTargets(request([candidate("cheap", "1")]));
		const admission = Object.defineProperty({}, "requestId", {
			get() {
				throw new Error("unreadable");
			},
		});
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async () => {
						throw { admission };
					},
				},
			],
		});
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
	});

	it("returns the validated receipt, not a mutable provider-owned object", async () => {
		const ranking = rankIacTargets(request([candidate("cheap", "1")]));
		let providerReceipt: ReturnType<typeof decision> | undefined;
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async (_id, expected) => {
						providerReceipt = { ...decision("cheap", "admitted"), ...expected };
						return { outputs: {}, admission: providerReceipt };
					},
				},
			],
		});
		expect(result.status).toBe("selected");
		if (providerReceipt === undefined)
			throw new Error("provider was not called");
		providerReceipt.budget.reservation = "not-created";
		expect(result.admission?.budget?.reservation).toBe("held");
	});

	it("does not invoke getters in provider outputs", async () => {
		const ranking = rankIacTargets(request([candidate("cheap", "1")]));
		let calls = 0;
		const outputs = Object.defineProperty({}, "output", {
			enumerable: true,
			get() {
				calls++;
				return "value";
			},
		});
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async (_id, expected) => ({
						outputs,
						admission: { ...decision("cheap", "admitted"), ...expected },
					}),
				},
			],
		});
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "allowed", reservation: "held" },
		});
		expect(calls).toBe(0);
	});

	it.each([
		null,
		1,
		["value"],
		{ output: 1 },
	])("retains the hold when provider outputs are malformed: %j", async (bad) => {
		const ranking = rankIacTargets(request([candidate("cheap", "1")]));
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async (_id, expected) => ({
						// SAFETY: deliberately violate the provider contract to test the boundary parser.
						outputs: bad as Record<string, string>,
						admission: { ...decision("cheap", "admitted"), ...expected },
					}),
				},
			],
		});
		expect(result).toMatchObject({
			status: "uncertain",
			reservationId: "iac:route-1",
			budget: { evaluation: "allowed", reservation: "held" },
		});
	});

	it("reports partial coverage when a ranked quote changes before admission", async () => {
		const ranking = rankIacTargets(
			request([candidate("cheap", "0.25"), candidate("expensive", "1")]),
		);
		const result = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: [
				{
					targetId: "cheap",
					run: async () => {
						throw {
							requiresReconciliation: false,
							executionOutcome: "not-started",
							admission: {
								...decision("cheap", "denied"),
								code: "ROUTING_QUOTE_CHANGED",
							},
						};
					},
				},
				{
					targetId: "expensive",
					run: async (_id, expected) => ({
						outputs: {},
						admission: { ...decision("expensive", "admitted"), ...expected },
					}),
				},
			],
		});
		expect(result).toMatchObject({
			status: "selected",
			targetId: "expensive",
			coverage: "partial",
		});
	});

	it("matches the bounded routing oracle for all three-target outcome combinations", async () => {
		const states = ["denied", "admitted", "uncertain", "replay"] as const;
		const ids = ["a", "b", "c"] as const;
		const ranking = rankIacTargets(
			request(ids.map((id) => candidate(id, "1"))),
		);
		for (const a of states)
			for (const b of states)
				for (const c of states) {
					const outcomes = [a, b, c] as const;
					const calls: string[] = [];
					const result = await executeRankedIacTargets({
						requestId: "route-1",
						ranking,
						candidates: ids.map((targetId, index) => ({
							targetId,
							run: async (_id, expected) => {
								calls.push(targetId);
								const state = outcomes[index];
								if (state === undefined)
									throw new Error("missing oracle state");
								const receipt = { ...decision(targetId, state), ...expected };
								if (state === "admitted")
									return { outputs: {}, admission: receipt };
								throw {
									requiresReconciliation: false,
									executionOutcome: "not-started",
									admission: receipt,
								};
							},
						})),
					});
					const firstFinal = outcomes.findIndex((state) => state !== "denied");
					const expectedCalls = firstFinal < 0 ? ids.length : firstFinal + 1;
					const expectedStatus =
						firstFinal < 0
							? "denied"
							: outcomes[firstFinal] === "admitted"
								? "selected"
								: outcomes[firstFinal];
					expect(result.status, `${a}/${b}/${c}`).toBe(expectedStatus);
					expect(calls, `${a}/${b}/${c}`).toEqual(ids.slice(0, expectedCalls));
					expect(result.attempts).toHaveLength(expectedCalls);
				}
	});

	it("stops at every terminal position within the 256-target limit", async () => {
		const seed = rankIacTargets(request([candidate("seed", "1")]));
		const first = seed.ranking[0];
		if (first === undefined) throw new Error("seed ranking missing");
		const ranking = {
			...seed,
			ranking: Array.from({ length: 256 }, (_, index) => ({
				...first,
				targetId: `target-${String(index).padStart(3, "0")}`,
				rank: index + 1,
			})),
		};
		for (const terminal of ["admitted", "uncertain", "replay"] as const) {
			for (let stop = 0; stop < ranking.ranking.length; stop++) {
				let calls = 0;
				const result = await executeRankedIacTargets({
					requestId: "route-1",
					ranking,
					candidates: ranking.ranking.map((entry, index) => ({
						targetId: entry.targetId,
						run: async (_id, expected) => {
							calls++;
							if (index < stop)
								throw {
									requiresReconciliation: false,
									executionOutcome: "not-started",
									admission: decision(entry.targetId, "denied"),
								};
							if (index > stop)
								throw new Error("routing continued after a terminal outcome");
							const receipt = {
								...decision(entry.targetId, terminal),
								...expected,
							};
							if (terminal === "admitted")
								return { outputs: {}, admission: receipt };
							throw {
								requiresReconciliation: false,
								executionOutcome: "not-started",
								admission: receipt,
							};
						},
					})),
				});
				expect(result.status, `${terminal}/${stop}`).toBe(
					terminal === "admitted" ? "selected" : terminal,
				);
				expect(calls, `${terminal}/${stop}`).toBe(stop + 1);
			}
		}
		const denied = await executeRankedIacTargets({
			requestId: "route-1",
			ranking,
			candidates: ranking.ranking.map((entry) => ({
				targetId: entry.targetId,
				run: async () => {
					throw {
						requiresReconciliation: false,
						executionOutcome: "not-started",
						admission: decision(entry.targetId, "denied"),
					};
				},
			})),
		});
		expect(denied).toMatchObject({
			status: "denied",
			code: "NO_ADMISSIBLE_TARGET",
			budget: { evaluation: "denied", reservation: "not-created" },
		});
		expect(denied.attempts).toHaveLength(256);
		const oversizedRanking = {
			...ranking,
			ranking: [
				...ranking.ranking,
				{ ...first, targetId: "target-overflow", rank: 257 },
			],
		};
		let extraCalls = 0;
		const oversized = await executeRankedIacTargets({
			requestId: "route-1",
			ranking: oversizedRanking,
			candidates: oversizedRanking.ranking.map((entry) => ({
				targetId: entry.targetId,
				run: async () => {
					extraCalls++;
					throw new Error("must not run");
				},
			})),
		});
		expect(oversized).toMatchObject({
			status: "uncertain",
			code: "ROUTING_INPUT_UNINSPECTABLE",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
		expect(extraCalls).toBe(0);
	}, 20_000);
});
