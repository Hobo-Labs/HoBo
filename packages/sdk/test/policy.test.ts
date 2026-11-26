import {
	evaluatePolicyPack,
	type PolicyDecisionRequest,
} from "@hobo/contracts";
import { describe, expect, it } from "vitest";

import {
	POLICY_PACK_SCHEMA,
	policyPack,
	rule,
	SdkDeclarationError,
} from "../src/index.js";

function request(
	overrides: Partial<PolicyDecisionRequest>,
): PolicyDecisionRequest {
	return {
		subject: { kind: "user", id: "ci@acme.yard" },
		action: "resource.deploy",
		resource: { kind: "resource", id: "orders" },
		phase: "apply",
		context: {},
		...overrides,
	};
}

// The walkthrough §4.3 acme-baseline pack, verbatim call shape.
const acmeBaseline = policyPack("acme-baseline", { mandatory: true }, [
	rule("prod-deletes-need-approval", {
		phase: "apply",
		when: { env: "production", action: "resource.delete" },
		effect: "require-approval",
	}),
	rule("public-endpoints-need-auth", {
		phase: "plan",
		when: { exposes: "public" },
		effect: "mutate",
		add: "auth-middleware",
	}),
	rule("eu-data-stays-in-eu", {
		phase: "apply",
		when: { dataClass: "pii", region: "!eu" },
		effect: "deny",
	}),
	rule("model-change-needs-shadow", {
		phase: "promote",
		when: { kind: "trainable" },
		effect: "require-approval",
		obligation: "shadow-eval",
	}),
]);

describe("rule", () => {
	it("produces a frozen compiled rule carrying its declaration", () => {
		const compiled = rule("r1", {
			phase: "apply",
			when: { env: "production" },
			effect: "deny",
		});
		expect(Object.isFrozen(compiled)).toBe(true);
		expect(Object.isFrozen(compiled.whenClause)).toBe(true);
		expect(compiled.id).toBe("r1");
		expect(compiled.phase).toBe("apply");
		expect(compiled.effect).toBe("deny");
	});

	it("rejects unknown effects with a typed error", () => {
		expect(() =>
			rule("bad", { phase: "apply", when: {}, effect: "explode" as never }),
		).toThrow(SdkDeclarationError);
	});

	it("rejects non-scalar when-clause values", () => {
		expect(() =>
			rule("bad", {
				phase: "apply",
				when: { env: { nested: true } as never },
				effect: "deny",
			}),
		).toThrow(SdkDeclarationError);
	});
});

describe("policyPack", () => {
	it("produces a frozen, schema-versioned pack", () => {
		expect(Object.isFrozen(acmeBaseline)).toBe(true);
		expect(acmeBaseline.schema).toBe(POLICY_PACK_SCHEMA);
		expect(acmeBaseline.mandatory).toBe(true);
		expect(acmeBaseline.rules).toHaveLength(4);
	});

	it("rejects duplicate rule ids", () => {
		const r = rule("dup", { phase: "apply", when: {}, effect: "warn" });
		expect(() => policyPack("p", {}, [r, r])).toThrow(SdkDeclarationError);
	});

	it("rejects rules not authored with rule()", () => {
		expect(() => policyPack("p", {}, [{ id: "raw" } as never])).toThrow(
			SdkDeclarationError,
		);
	});
});

describe("evaluatePolicyPack composition", () => {
	it("denies pii landing outside the eu (walkthrough §4.6 denial)", () => {
		const evaluation = evaluatePolicyPack({
			request: request({
				context: { dataClass: "pii", region: "us-east-1" },
			}),
			pack: acmeBaseline,
		});
		expect(evaluation.decision.effect).toBe("deny");
		expect(evaluation.matchedRuleIds).toEqual(["eu-data-stays-in-eu"]);
	});

	it("requires approval for prod deletes", () => {
		const evaluation = evaluatePolicyPack({
			request: request({
				action: "resource.delete",
				context: { env: "production" },
			}),
			pack: acmeBaseline,
		});
		expect(evaluation.decision.effect).toBe("require-approval");
		expect(evaluation.matchedRuleIds).toEqual(["prod-deletes-need-approval"]);
	});

	it("mutates public endpoints in plan and carries the added artifact", () => {
		const evaluation = evaluatePolicyPack({
			request: request({ phase: "plan", context: { exposes: "public" } }),
			pack: acmeBaseline,
		});
		expect(evaluation.decision.effect).toBe("mutate");
		expect(evaluation.decision.obligations).toEqual([
			{ kind: "mutation", add: "auth-middleware" },
		]);
	});

	it("attaches obligations on require-approval rules", () => {
		const evaluation = evaluatePolicyPack({
			request: request({ phase: "promote", context: { kind: "trainable" } }),
			pack: acmeBaseline,
		});
		expect(evaluation.decision.effect).toBe("require-approval");
		expect(evaluation.decision.obligations).toEqual([
			{ kind: "obligation", id: "shadow-eval" },
		]);
	});

	it("allows when no rule matches, still through the engine", () => {
		const evaluation = evaluatePolicyPack({
			request: request({ context: { env: "staging" } }),
			pack: acmeBaseline,
		});
		expect(evaluation.decision.effect).toBe("allow");
	});
});
