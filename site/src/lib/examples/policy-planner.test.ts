import { describe, expect, it } from "vitest";

import {
	DEFAULT_BUDGET_POLICY,
	mergeBudgetPolicy,
	resolveDeployPlan,
	type StationTarget,
} from "./policy-planner";

const targets: readonly StationTarget[] = [
	{
		id: "cloudflare",
		yardId: "yard-cloudflare",
		providerId: "cloudflare",
		resourceClass: "anonymous-remote",
		canHostNow: true,
		estimatedMonthlySpendUsd: 0,
	},
	{
		id: "webernetes",
		yardId: "yard-webernetes",
		providerId: "webernetes",
		resourceClass: "local",
		canHostNow: true,
		estimatedMonthlySpendUsd: 0,
	},
	{
		id: "browser-wasm",
		yardId: "yard-browser-wasm",
		providerId: "browser-wasm",
		resourceClass: "local",
		canHostNow: true,
		estimatedMonthlySpendUsd: 0,
	},
];

describe("mergeBudgetPolicy", () => {
	it("merges sparse app and deployment policy without clobbering later redundancy", () => {
		expect(
			mergeBudgetPolicy(
				{ routing: "latency-first", monthlySpendCapUsd: 12 },
				{ redundancy: "active-passive", maxReplicas: 2 },
			),
		).toEqual({
			...DEFAULT_BUDGET_POLICY,
			routing: "latency-first",
			monthlySpendCapUsd: 12,
			redundancy: "active-passive",
			maxReplicas: 2,
		});
	});

	it("derives the replica default from a sparse redundancy override", () => {
		expect(mergeBudgetPolicy({}, { redundancy: "active-passive" }).maxReplicas).toBe(
			2,
		);
		expect(mergeBudgetPolicy({}, { redundancy: "mirror" }).maxReplicas).toBe(3);
		expect(
			mergeBudgetPolicy(
				{ maxReplicas: 1 },
				{ redundancy: "active-passive" },
			).maxReplicas,
		).toBe(1);
	});
});

describe("resolveDeployPlan", () => {
	it("keeps providers available while provisioning only the replica budget", () => {
		const plan = resolveDeployPlan(targets, DEFAULT_BUDGET_POLICY);

		expect(plan.provision.map(({ target, role }) => [target.id, role])).toEqual([
			["browser-wasm", "primary"],
		]);
		expect(plan.skipped.map(({ target, reason }) => [target.id, reason])).toEqual([
			["cloudflare", "over-replica-budget"],
			["webernetes", "over-replica-budget"],
		]);
		expect(plan.summary).toBe(
			"redundancy=none → provision 1 primary host → browser-wasm",
		);
	});

	it("prefers a remote standby for active-passive redundancy", () => {
		const plan = resolveDeployPlan(
			targets,
			mergeBudgetPolicy({ redundancy: "active-passive", maxReplicas: 2 }),
		);

		expect(plan.provision.map(({ target, role }) => [target.id, role])).toEqual([
			["browser-wasm", "primary"],
			["cloudflare", "standby"],
		]);
		expect(plan.junction).toEqual({
			yardIds: ["yard-browser-wasm", "yard-cloudflare"],
			routing:
				"local-first · primary=browser-wasm · standby=cloudflare",
		});
		expect(plan.summary).toBe(
			"redundancy=active-passive → provision 2 hosts → browser-wasm primary + cloudflare standby",
		);
	});

	it("composes only yard-allowed targets into a mirror Junction", () => {
		const vercel: StationTarget = {
			id: "vercel",
			yardId: "yard-vercel",
			providerId: "vercel",
			resourceClass: "local",
			canHostNow: true,
			estimatedMonthlySpendUsd: 0,
		};
		const plan = resolveDeployPlan(
			[...targets, vercel],
			mergeBudgetPolicy({ redundancy: "mirror", maxReplicas: 3 }),
			["yard-browser-wasm", "yard-webernetes", "yard-cloudflare"],
		);

		expect(plan.provision.map(({ target, role }) => [target.id, role])).toEqual([
			["browser-wasm", "primary"],
			["webernetes", "replica"],
			["cloudflare", "replica"],
		]);
		expect(plan.skipped).toEqual([
			expect.objectContaining({
				target: vercel,
				reason: "yard-blocked",
			}),
		]);
		expect(plan.junction?.yardIds).toEqual([
			"yard-browser-wasm",
			"yard-webernetes",
			"yard-cloudflare",
		]);
	});

	it("filters resource class, spend, and hostability before replica ranking", () => {
		const paid: StationTarget = {
			id: "paid-edge",
			yardId: "yard-paid-edge",
			providerId: "paid-edge",
			resourceClass: "paid-remote",
			canHostNow: true,
			estimatedMonthlySpendUsd: 9,
		};
		const blocked: StationTarget = {
			id: "remote-bridge",
			yardId: "yard-remote-bridge",
			providerId: "remote-bridge",
			resourceClass: "anonymous-remote",
			canHostNow: false,
			unavailableReason: "remote bootstrap requires bridge",
			estimatedMonthlySpendUsd: 0,
		};
		const plan = resolveDeployPlan(
			[...targets, paid, blocked],
			mergeBudgetPolicy({
				resourcePool: ["anonymous-remote", "paid-remote"],
				monthlySpendCapUsd: 5,
			}),
		);

		expect(plan.provision.map(({ target }) => target.id)).toEqual([
			"cloudflare",
		]);
		expect(
			Object.fromEntries(
				plan.skipped.map(({ target, reason }) => [target.id, reason]),
			),
		).toEqual({
			"browser-wasm": "not-in-resource-pool",
			"paid-edge": "spend-cap",
			"remote-bridge": "cannot-host",
			webernetes: "not-in-resource-pool",
		});
		expect(
			plan.skipped.find(({ target }) => target.id === "remote-bridge")?.detail,
		).toBe("remote bootstrap requires bridge");
	});

	it("enforces the spend cap across all selected paid hosts", () => {
		const paid = (id: string, spend: number): StationTarget => ({
			id,
			yardId: `yard-${id}`,
			providerId: id,
			resourceClass: "paid-remote",
			canHostNow: true,
			estimatedMonthlySpendUsd: spend,
		});
		const plan = resolveDeployPlan(
			[paid("paid-a", 6), paid("paid-b", 6)],
			mergeBudgetPolicy({
				resourcePool: ["paid-remote"],
				monthlySpendCapUsd: 10,
				redundancy: "active-active",
				maxReplicas: 2,
			}),
		);

		expect(plan.provision.map(({ target }) => target.id)).toEqual(["paid-a"]);
		expect(plan.skipped).toEqual([
			expect.objectContaining({
				target: expect.objectContaining({ id: "paid-b" }),
				reason: "spend-cap",
				detail: "cumulative estimate $12/month exceeds $10 cap",
			}),
		]);
	});

	it("uses webernetes as standby when no remote can host and ignores maxConcurrent for live count", () => {
		const kubernetes: StationTarget = {
			id: "kubernetes",
			yardId: "yard-kubernetes",
			providerId: "kubernetes",
			resourceClass: "local",
			canHostNow: true,
			estimatedMonthlySpendUsd: 0,
		};
		const candidates = targets.map((target) =>
			target.id === "cloudflare"
				? {
						...target,
						canHostNow: false,
						unavailableReason: "remote bootstrap requires bridge",
					}
				: target,
		);
		const plan = resolveDeployPlan(
			[...candidates, kubernetes],
			mergeBudgetPolicy({
				redundancy: "active-passive",
				maxReplicas: 2,
				maxConcurrent: 1,
			}),
		);

		expect(plan.provision.map(({ target }) => target.id)).toEqual([
			"browser-wasm",
			"webernetes",
		]);
		expect(plan.replicas).toBe(2);
		expect(plan.policy.maxConcurrent).toBe(1);
	});

	it("never turns redundancy none into multi-host by inflating maxReplicas", () => {
		const plan = resolveDeployPlan(
			targets,
			mergeBudgetPolicy({ redundancy: "none", maxReplicas: 3 }),
		);

		expect(plan.provision.map(({ target }) => target.id)).toEqual([
			"browser-wasm",
		]);
		expect(plan.replicas).toBe(1);
		expect(plan.skipped).toHaveLength(2);
	});

	it("fails closed for invalid budgets and ambiguous target identities", () => {
		expect(() =>
			resolveDeployPlan(
				targets,
				mergeBudgetPolicy({ maxReplicas: -1 }),
			),
		).toThrow("maxReplicas must be a non-negative integer");
		expect(() =>
			resolveDeployPlan(
				[targets[0]!, { ...targets[0]!, yardId: "another-yard" }],
				DEFAULT_BUDGET_POLICY,
			),
		).toThrow("duplicate target id: cloudflare");
	});
});
