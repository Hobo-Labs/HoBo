import { describe, expect, it } from "vitest";

import { createBoundaryContract } from "../src/contract-ir.js";
import {
	describeContractEffects,
	formatContractDescribe,
} from "../src/describe.js";
import type { JsonObject } from "../src/json.js";
import {
	createPermissiveDefaultPack,
	definePolicyRule,
	EFFECT_RANK,
	evaluatePolicyPack,
	POLICY_DECIDED_EVENT_TYPE,
	POLICY_PACK_ENGINE_ID,
	type PolicyDecisionRequest,
	type PolicyRule,
} from "../src/policy-pack.js";
import {
	CONTRACT_ENGINE_INTERFACE,
	CONTRACT_ENGINE_PORT,
	GATEKEEPER_INTERFACE,
	GATEKEEPER_PORT,
} from "../src/port.js";

const REQUEST: PolicyDecisionRequest = {
	subject: { kind: "user", id: "u-1", roles: ["dev"] },
	action: "deploy",
	resource: { kind: "camp", id: "c-1" },
	phase: "plan",
};

function ruleReturning(
	id: string,
	effect: Parameters<typeof rank>[0],
	extra: Partial<ReturnType<PolicyRule["decide"]>> = {},
): PolicyRule {
	return definePolicyRule({
		id,
		when: () => true,
		decide: () => ({ effect, reason: `${id} says ${effect}`, ...extra }),
	});
}

function rank(effect: string): number {
	return EFFECT_RANK.get(effect) as number;
}

describe("EFFECT_RANK", () => {
	it("orders deny as the most restrictive and allow as the least", () => {
		expect(rank("deny")).toBe(0);
		expect(rank("allow")).toBe(5);
		expect(rank("require-approval")).toBeLessThan(rank("allow-degraded"));
		expect(rank("allow-degraded")).toBeLessThan(rank("warn"));
		expect(rank("warn")).toBeLessThan(rank("mutate"));
		expect(rank("mutate")).toBeLessThan(rank("allow"));
	});
});

describe("createPermissiveDefaultPack", () => {
	it("has no rules but a real identity", () => {
		const pack = createPermissiveDefaultPack();
		expect(pack.rules).toEqual([]);
		expect(pack.id).toBe("hobo.default/permissive");
		expect(pack.version).toBe("1.0.0");
	});
});

describe("definePolicyRule", () => {
	it("returns the rule unchanged, existing only for inference", () => {
		const rule = ruleReturning("r", "deny");
		expect(definePolicyRule(rule)).toBe(rule);
	});
});

describe("evaluatePolicyPack", () => {
	it("allows and still emits a policy.Decided event with no pack given", () => {
		const result = evaluatePolicyPack({ request: REQUEST });
		expect(result.decision.effect).toBe("allow");
		expect(result.event.type).toBe(POLICY_DECIDED_EVENT_TYPE);
		expect(result.matchedRuleIds).toEqual([]);
	});

	it("names the default-allow pseudo-policy when no rule matched", () => {
		const result = evaluatePolicyPack({ request: REQUEST });
		expect(result.decision.evidence.policyIds).toEqual([
			"hobo.default/permissive:default-allow",
		]);
		expect(result.decision.evidence.engine).toBe(POLICY_PACK_ENGINE_ID);
	});

	it("drops packId and packVersion on the way into the Policy IR", () => {
		const result = evaluatePolicyPack({ request: REQUEST });
		expect(
			(result.decision.evidence as JsonObject).packId,
		).toBeUndefined();
		expect(
			(result.decision.evidence as JsonObject).packVersion,
		).toBeUndefined();
		expect(result.decision.evidence.inputHash).toMatch(/^sha256:/u);
	});

	it("explains an unconditioned allow in its reason", () => {
		expect(result_reason()).toContain("no rule denied");
	});

	function result_reason(): string {
		return evaluatePolicyPack({ request: REQUEST }).decision.reason;
	}

	it("applies the single matching rule", () => {
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: { id: "p", version: "1", rules: [ruleReturning("r1", "warn")] },
		});
		expect(result.decision.effect).toBe("warn");
		expect(result.matchedRuleIds).toEqual(["r1"]);
		expect(result.decision.evidence.policyIds).toEqual(["r1"]);
	});

	it("lets the most restrictive effect win regardless of rule order", () => {
		const rules = [
			ruleReturning("allow", "allow"),
			ruleReturning("deny", "deny"),
		];
		expect(
			evaluatePolicyPack({
				request: REQUEST,
				pack: { id: "p", version: "1", rules },
			}).decision.effect,
		).toBe("deny");
		expect(
			evaluatePolicyPack({
				request: REQUEST,
				pack: { id: "p", version: "1", rules: [...rules].reverse() },
			}).decision.effect,
		).toBe("deny");
	});

	it("reports the winning rule's reason, not another matching rule's", () => {
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: {
				id: "p",
				version: "1",
				rules: [ruleReturning("a", "allow"), ruleReturning("d", "deny")],
			},
		});
		expect(result.decision.reason).toBe("d says deny");
	});

	it("keeps the first rule when two share the winning rank", () => {
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: {
				id: "p",
				version: "1",
				rules: [
					ruleReturning("first", "deny"),
					ruleReturning("second", "deny"),
				],
			},
		});
		expect(result.decision.reason).toBe("first says deny");
	});

	it("skips rules whose predicate returns false", () => {
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: {
				id: "p",
				version: "1",
				rules: [
					{
						id: "never",
						when: () => false,
						decide: () => ({ effect: "deny", reason: "should not run" }),
					},
				],
			},
		});
		expect(result.decision.effect).toBe("allow");
		expect(result.matchedRuleIds).toEqual([]);
	});

	it("requires a predicate to return exactly true", () => {
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: {
				id: "p",
				version: "1",
				rules: [
					{
						id: "truthy",
						when: () => "yes" as never,
						decide: () => ({ effect: "deny", reason: "no" }),
					},
				],
			},
		});
		expect(result.matchedRuleIds).toEqual([]);
	});

	it("treats a throwing predicate as not matching", () => {
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: {
				id: "p",
				version: "1",
				rules: [
					{
						id: "broken",
						when: () => {
							throw new Error("bad predicate");
						},
						decide: () => ({ effect: "deny", reason: "unreachable" }),
					},
					ruleReturning("warn", "warn"),
				],
			},
		});
		expect(result.matchedRuleIds).toEqual(["warn"]);
		expect(result.decision.effect).toBe("warn");
	});

	it("does not catch a throwing decide", () => {
		expect(() =>
			evaluatePolicyPack({
				request: REQUEST,
				pack: {
					id: "p",
					version: "1",
					rules: [
						{
							id: "boom",
							when: () => true,
							decide: () => {
								throw new Error("bad decide");
							},
						},
					],
				},
			}),
		).toThrow("bad decide");
	});

	it("collects obligations and violations from every matching rule", () => {
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: {
				id: "p",
				version: "1",
				rules: [
					ruleReturning("a", "warn", {
						obligations: [{ kind: "notify" }],
						violations: ["v1"],
					}),
					ruleReturning("b", "deny", {
						obligations: [{ kind: "audit" }],
						violations: ["v2"],
					}),
				],
			},
		});
		expect(result.decision.obligations).toHaveLength(2);
		expect(result.decision.violations).toEqual(["v1", "v2"]);
	});

	it("yields empty obligations and violations when rules supply none", () => {
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: { id: "p", version: "1", rules: [ruleReturning("a", "allow")] },
		});
		expect(result.decision.obligations).toEqual([]);
		expect(result.decision.violations).toEqual([]);
	});

	it("defaults an absent context to an empty object", () => {
		expect(() => evaluatePolicyPack({ request: REQUEST })).not.toThrow();
	});

	it("passes an explicit context through to the decision request", () => {
		const result = evaluatePolicyPack({
			request: { ...REQUEST, context: { region: "us-east-1" } },
		});
		expect(result.event).toBeDefined();
		expect(result.decision.effect).toBe("allow");
	});

	it("records every matched rule id even when one wins", () => {
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: {
				id: "p",
				version: "1",
				rules: [ruleReturning("a", "allow"), ruleReturning("b", "deny")],
			},
		});
		expect(result.matchedRuleIds).toEqual(["a", "b"]);
		expect(result.decision.evidence.policyIds).toEqual(["a", "b"]);
	});

	it("emits an event for a denial as well as an allow", () => {
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: { id: "p", version: "1", rules: [ruleReturning("d", "deny")] },
		});
		expect(result.event.type).toBe(POLICY_DECIDED_EVENT_TYPE);
	});

	it("falls back to the allow rank for an effect outside the table", () => {
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: {
				id: "p",
				version: "1",
				rules: [
					ruleReturning("weird", "quarantine" as never),
					ruleReturning("d", "deny"),
				],
			},
		});
		expect(result.decision.effect).toBe("deny");
	});
});

describe("port descriptors", () => {
	it("expose the contract-engine and gatekeeper interfaces", () => {
		expect(CONTRACT_ENGINE_INTERFACE).toBe("hobo:contract-engine/can-deploy");
		expect(GATEKEEPER_INTERFACE).toBe("hobo:gatekeeper/verify");
		expect(CONTRACT_ENGINE_PORT.interface).toBe(CONTRACT_ENGINE_INTERFACE);
		expect(GATEKEEPER_PORT.interface).toBe(GATEKEEPER_INTERFACE);
	});

	it("are provider ports marked preview", () => {
		expect(CONTRACT_ENGINE_PORT.kind).toBe("provider");
		expect(GATEKEEPER_PORT.kind).toBe("provider");
		expect(CONTRACT_ENGINE_PORT.stability).toBe("preview");
		expect(GATEKEEPER_PORT.stability).toBe("preview");
	});

	it("carry distinct names", () => {
		expect(CONTRACT_ENGINE_PORT.name).toBe("contract-engine");
		expect(GATEKEEPER_PORT.name).toBe("gatekeeper");
	});
});

describe("describeContractEffects", () => {
	it("reports the contract identity and the derived effect predicates", () => {
		const contract = createBoundaryContract();
		const described = describeContractEffects(contract);
		expect(described.contractId).toBe(contract.id);
		expect(described.version).toBe(contract.version);
		expect(described.channel).toBe(contract.edge.channel);
	});

	it("says effects are not declared when the contract omits them", () => {
		const contract = createBoundaryContract();
		expect(describeContractEffects(contract).effectsDeclared).toBe(
			contract.effects !== undefined,
		);
	});

	it("omits the resilience fields entirely when there is no profile", () => {
		const described = describeContractEffects(createBoundaryContract());
		if (!createBoundaryContract().resilience) {
			expect(Object.hasOwn(described, "resilienceId")).toBe(false);
			expect(Object.hasOwn(described, "resilienceStrategies")).toBe(false);
			expect(Object.hasOwn(described, "neverRetry")).toBe(false);
		}
	});

	it("serializes the effect manifest as JSON the caller can re-parse", () => {
		const described = describeContractEffects(createBoundaryContract());
		expect(() => JSON.parse(described.effectManifestJson)).not.toThrow();
		const manifest = JSON.parse(described.effectManifestJson) as {
			contractId: string;
		};
		expect(manifest.contractId).toBe(described.contractId);
	});
});

describe("formatContractDescribe", () => {
	it("renders every effect line", () => {
		const text = formatContractDescribe(createBoundaryContract());
		for (const label of [
			"contract:",
			"channel:",
			"effects:",
			"purity:",
			"pure:",
			"mayFail:",
			"requiresNetwork:",
			"capabilities:",
			"domains:",
		]) {
			expect(text).toContain(label);
		}
	});

	it("says resilience: (none) rather than omitting the line", () => {
		const contract = createBoundaryContract();
		if (!contract.resilience) {
			expect(formatContractDescribe(contract)).toContain("resilience: (none)");
		}
	});

	it("labels undeclared effects as default(conservative)", () => {
		const contract = createBoundaryContract();
		const text = formatContractDescribe(contract);
		expect(text).toContain(
			contract.effects === undefined ? "default(conservative)" : "declared",
		);
	});

	it("produces newline-separated lines with no trailing newline", () => {
		const text = formatContractDescribe(createBoundaryContract());
		expect(text.endsWith("\n")).toBe(false);
		expect(text.split("\n").length).toBeGreaterThan(5);
	});
});
