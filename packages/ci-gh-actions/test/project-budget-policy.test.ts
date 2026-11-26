import { ciBudgetPolicyJson } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import {
	ciEnvironmentPolicySha256,
	defineCiProjectConfig,
	parseCiProjectConfig,
	selectCiEnvironment,
} from "../src/project-config.js";
import { commonBudget, commonCiIntent } from "./fixtures/common-budget.js";
import { config } from "./fixtures.js";

function source(budget = commonBudget()) {
	const account = config().accounts[0];
	if (!account) throw new Error("fixture account missing");
	return {
		defaultEnvironment: "local",
		environments: {
			local: {
				relayOrigin: "https://relay.example.test",
				policy: commonCiIntent(account, budget),
			},
		},
	};
}

describe("common budget policy in project authoring", () => {
	it("preserves every control through project parsing and the SDK envelope", () => {
		const input = source({
			...commonBudget(),
			constraints: [
				{ key: "ci.queue.duration", workload: "ci", unit: "ms", maximum: 1000 },
			],
		});
		const parsed = parseCiProjectConfig(JSON.stringify(input));
		const selected = selectCiEnvironment(parsed);
		const sdk = defineCiProjectConfig({
			defaultEnvironment: "local",
			environments: {
				local: { relayOrigin: selected.relayOrigin, policy: selected.policy },
			},
		});
		expect(
			ciBudgetPolicyJson(selectCiEnvironment(sdk).policy.budgetPolicy),
		).toBe(ciBudgetPolicyJson(input.environments.local.policy.budgetPolicy));
		expect(Object.isFrozen(selectCiEnvironment(sdk).policy.budgetPolicy)).toBe(
			true,
		);
	});

	it("preserves a shared budget alongside a Kubernetes scale-set provider in the SDK envelope", () => {
		const input = source();
		const project = {
			...input,
			environments: {
				local: {
					...input.environments.local,
					policy: {
						...input.environments.local.policy,
						providers: [
							...input.environments.local.policy.providers,
							{
								id: "kubernetes-provider",
								kind: "kubernetes",
								connectionRef: "yard:kubernetes",
								runsOn: "hobo-arc",
								enabled: true,
								scaleSet: {
									name: "hobo-arc",
									minRunners: 0,
									maxRunners: 4,
									namespace: "arc-runners",
								},
							},
						],
					},
				},
			},
		};
		const selected = selectCiEnvironment(
			parseCiProjectConfig(JSON.stringify(project)),
		);
		const defined = defineCiProjectConfig({
			defaultEnvironment: "local",
			environments: {
				local: { relayOrigin: selected.relayOrigin, policy: selected.policy },
			},
		});
		const policy = selectCiEnvironment(defined).policy;
		expect(ciBudgetPolicyJson(policy.budgetPolicy)).toBe(
			ciBudgetPolicyJson(input.environments.local.policy.budgetPolicy),
		);
		expect(
			policy.providers.find((provider) => provider.id === "kubernetes-provider")
				?.capacity,
		).toMatchObject({
			case: "scaleSet",
			value: { name: "hobo-arc", minRunners: 0, maxRunners: 4 },
		});
	});

	it("pins equivalent common policy content independently of JSON key or workload order", async () => {
		const input = source();
		const common = input.environments.local.policy.budgetPolicy;
		const reordered = Object.fromEntries(Object.entries(common).reverse());
		reordered.workloads = [...common.workloads].reverse();
		const second = {
			...input,
			environments: {
				local: {
					...input.environments.local,
					policy: {
						...input.environments.local.policy,
						budgetPolicy: reordered,
					},
				},
			},
		};
		expect(
			await ciEnvironmentPolicySha256(
				parseCiProjectConfig(JSON.stringify(input)),
				"local",
			),
		).toBe(
			await ciEnvironmentPolicySha256(
				parseCiProjectConfig(JSON.stringify(second)),
				"local",
			),
		);
	});

	it("rejects duplicate controls including escaped aliases before JSON normalization", () => {
		const text = JSON.stringify(source()).replace(
			'"revision":"revision-a"',
			String.raw`"revision":"revision-a","rev\u0069sion":"revision-b"`,
		);
		expect(() => parseCiProjectConfig(text)).toThrow(
			"invalid CI project configuration",
		);
	});

	it("rejects unknown common controls in JSON and in SDK inputs before metadata stripping", () => {
		const input = source();
		const unknown = {
			...input,
			environments: {
				local: {
					...input.environments.local,
					policy: {
						...input.environments.local.policy,
						budgetPolicy: { ...commonBudget(), rounding: "dollars" },
					},
				},
			},
		};
		expect(() => parseCiProjectConfig(JSON.stringify(unknown))).toThrow();
		const metadata = {
			...unknown,
			environments: {
				local: {
					...input.environments.local,
					policy: {
						...input.environments.local.policy,
						budgetPolicy: {
							...commonBudget(),
							$typeName: "unreviewed-control",
						},
					},
				},
			},
		};
		expect(() => defineCiProjectConfig(metadata)).toThrow();
	});

	it("uses the shared semantic validator for dependent period bounds", () => {
		const input = source();
		for (const budgetPolicy of [
			{ ...commonBudget(), periodStartsAtMs: 1, periodEndsAtMs: 2 },
			{
				...commonBudget(),
				periodKind: "fixed-window",
				periodStartsAtMs: 2,
				periodEndsAtMs: 1,
			},
		])
			expect(() =>
				parseCiProjectConfig(
					JSON.stringify({
						...input,
						environments: {
							local: {
								...input.environments.local,
								policy: { ...input.environments.local.policy, budgetPolicy },
							},
						},
					}),
				),
			).toThrow();
	});

	it("replaces a complete inherited common policy and refuses partial control overrides", () => {
		const input = source({
			...commonBudget(),
			constraints: [
				{ key: "ci.queue.duration", workload: "ci", unit: "ms", maximum: 1000 },
			],
		});
		const document = {
			defaultEnvironment: "local",
			templates: { base: input.environments.local },
			environments: {
				local: { extends: "base", policy: { budgetPolicy: commonBudget() } },
			},
		};
		expect(
			selectCiEnvironment(parseCiProjectConfig(JSON.stringify(document))).policy
				.budgetPolicy?.constraints,
		).toEqual([]);
		const partial = {
			...document,
			environments: {
				local: {
					extends: "base",
					policy: { budgetPolicy: { limitMicros: 0 } },
				},
			},
		};
		expect(() => parseCiProjectConfig(JSON.stringify(partial))).toThrow();
	});
});
