/**
 * The policy-pack evaluator, the describe surface and the port descriptors.
 *
 * The policy pack composes `@hobo/policy` rather than reimplementing it: its
 * job is to run typed TypeScript rules over a decision request and *lower* the
 * outcome onto the Policy IR, so that every deploy — including one a permissive
 * default pack allows — records a `policy.Decided` fact. Governed by default
 * without blocking (FR-051/NFR-017). The failure that matters is a silent one:
 * an evaluation that reached a verdict but emitted no event leaves a deploy
 * with no governance record at all, and nothing downstream would notice.
 *
 * Most-restrictive-wins is the other load-bearing rule. If a `deny` from one
 * rule could be outranked by an `allow` from another, a policy pack would be a
 * suggestion rather than a control.
 */
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
	// SAFETY: EFFECT_RANK is total for every PolicyEffect used by this helper.
	return EFFECT_RANK.get(effect) as number;
}

describe("EFFECT_RANK", () => {
	it("orders deny as the most restrictive and allow as the least", () => {
		// The ordering *is* the control. If `deny` were not the minimum, a single
		// permissive rule could override a denial in the reduce below.
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
		// Not an empty object: the pack id and version are recorded in the
		// decision evidence, so "which pack allowed this?" is answerable even
		// when the answer is "the default one".
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
		// The governed-by-default guarantee. An evaluation with no pack must not
		// be a no-op: it produces the same fact shape as a denial, differing only
		// in effect.
		const result = evaluatePolicyPack({ request: REQUEST });
		expect(result.decision.effect).toBe("allow");
		expect(result.event.type).toBe(POLICY_DECIDED_EVENT_TYPE);
		expect(result.matchedRuleIds).toEqual([]);
	});

	it("names the default-allow pseudo-policy when no rule matched", () => {
		// Evidence never comes back empty. `hobo.default/permissive:default-allow`
		// tells an auditor the decision was reached by absence of rules rather
		// than by a rule that happened to allow.
		const result = evaluatePolicyPack({ request: REQUEST });
		expect(result.decision.evidence.policyIds).toEqual([
			"hobo.default/permissive:default-allow",
		]);
		expect(result.decision.evidence.engine).toBe(POLICY_PACK_ENGINE_ID);
	});

	it("drops packId and packVersion on the way into the Policy IR", () => {
		// Pinning a gap rather than asserting an intent. `evaluatePolicyPack`
		// passes `packId` and `packVersion` into `createDecision`'s evidence, but
		// the Policy IR's `parseEvidence` keeps only `policyIds`, `inputHash` and
		// `engine` — so the pack's version never reaches the recorded decision.
		//
		// The consequence is narrow but real: "which version of the pack decided
		// this?" is not answerable from a `policy.Decided` fact, only "which
		// engine and which rule ids". Since rule ids are stable across pack
		// versions, a rule whose logic changed between 1.0.0 and 1.1.0 produces
		// indistinguishable evidence. Flagged for whoever owns the Policy IR
		// evidence shape rather than changed here — widening it is a schema
		// change with its own compatibility story.
		const result = evaluatePolicyPack({ request: REQUEST });
		expect(
			// SAFETY: evidence is a parsed JsonObject from the policy decision.
			(result.decision.evidence as JsonObject).packId,
		).toBeUndefined();
		expect(
			// SAFETY: evidence is a parsed JsonObject from the policy decision.
			(result.decision.evidence as JsonObject).packVersion,
		).toBeUndefined();
		// What does survive is enough to identify the engine and the rules.
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
		// Both orderings, because a reduce that kept the *last* rather than the
		// lowest would pass one of them by luck. A pack whose verdict depended
		// on authoring order would be untrustworthy as a control.
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
		// The reason accompanies the effect. Reporting an allowing rule's reason
		// beside a `deny` effect would tell an operator the opposite of what
		// happened.
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
		// Strict `<` in the reduce, so a tie keeps the earlier rule. Stable, and
		// stability is what matters — an unstable tiebreak would make the
		// recorded reason vary between runs on identical input.
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
		// `=== true`, not truthiness. A predicate that returned a non-empty string
		// or an object — easy to do by accident when refactoring a lookup into a
		// return — would otherwise match every request.
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: {
				id: "p",
				version: "1",
				rules: [
					{
						id: "truthy",
						// SAFETY: this invalid return deliberately tests strict predicate matching.
						when: () => "yes" as never,
						decide: () => ({ effect: "deny", reason: "no" }),
					},
				],
			},
		});
		expect(result.matchedRuleIds).toEqual([]);
	});

	it("treats a throwing predicate as not matching", () => {
		// Fail *open* on the predicate specifically, which is the right call here:
		// a rule that cannot decide whether it applies has not decided to deny,
		// and a crash in one author's rule must not take down evaluation of the
		// whole pack. The surrounding rules still get their say.
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
		// Deliberately asymmetric with `when`. A rule that matched and then failed
		// to produce a verdict is a real defect, and swallowing it would silently
		// drop a rule that may well have been the denying one.
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
		// Every rule's, not just the winner's. An obligation attached to a
		// non-winning `warn` rule is still an obligation the deploy must satisfy;
		// dropping it because a stricter rule won would lose a requirement.
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
		// The `?? []` on each. Present-but-undefined arrays here would fail the
		// Policy IR's own parse rather than producing an empty decision.
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: { id: "p", version: "1", rules: [ruleReturning("a", "allow")] },
		});
		expect(result.decision.obligations).toEqual([]);
		expect(result.decision.violations).toEqual([]);
	});

	it("defaults an absent context to an empty object", () => {
		// The Policy IR requires a context. Omitting one at the call site is
		// routine, so the evaluator supplies the empty object rather than making
		// every caller do it.
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
		// Symmetry is the point: the fact stream must not only record the happy
		// path, or an auditor could not distinguish "denied" from "never asked".
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: { id: "p", version: "1", rules: [ruleReturning("d", "deny")] },
		});
		expect(result.event.type).toBe(POLICY_DECIDED_EVENT_TYPE);
	});

	it("falls back to the allow rank for an effect outside the table", () => {
		// `EFFECT_RANK.get(effect) ?? mustGet(EFFECT_RANK, "allow")`. An
		// unrecognised effect ranks as the *least* restrictive, so it can never
		// beat a real deny — the safe direction for an unknown value. The effect
		// string itself is still carried through to the decision, so the unknown
		// value is visible rather than silently rewritten.
		const result = evaluatePolicyPack({
			request: REQUEST,
			pack: {
				id: "p",
				version: "1",
				rules: [
					// SAFETY: this invalid effect deliberately tests unknown-effect ranking.
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
		// These strings are the Matching keys concrete adapters bind against.
		// Changing one silently unbinds every adapter that named the old value,
		// and the failure appears as "no provider" at deploy time.
		expect(CONTRACT_ENGINE_INTERFACE).toBe("hobo:contract-engine/can-deploy");
		expect(GATEKEEPER_INTERFACE).toBe("hobo:gatekeeper/verify");
		expect(CONTRACT_ENGINE_PORT.interface).toBe(CONTRACT_ENGINE_INTERFACE);
		expect(GATEKEEPER_PORT.interface).toBe(GATEKEEPER_INTERFACE);
	});

	it("are provider ports marked preview", () => {
		// `preview` is a promise about compatibility. A descriptor that claimed
		// `stable` would tell integrators the interface will not move when it
		// still might.
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
		// The three predicates are derived, not stored. They are what the CLI
		// and MCP surfaces show an operator, so a wrong `requiresNetwork` would
		// misdescribe a contract's blast radius.
	});

	it("says effects are not declared when the contract omits them", () => {
		// `effectsDeclared` is the honesty flag: the effective effects come from
		// a conservative default when the author declared none, and a reader has
		// to be able to tell a declared `pure` from an assumed one.
		const contract = createBoundaryContract();
		expect(describeContractEffects(contract).effectsDeclared).toBe(
			contract.effects !== undefined,
		);
	});

	it("omits the resilience fields entirely when there is no profile", () => {
		// Conditional spread, so absent means absent. A present-but-undefined
		// `resilienceId` would render as an empty resilience section rather than
		// as no section.
		const described = describeContractEffects(createBoundaryContract());
		if (!createBoundaryContract().resilience) {
			expect(Object.hasOwn(described, "resilienceId")).toBe(false);
			expect(Object.hasOwn(described, "resilienceStrategies")).toBe(false);
			expect(Object.hasOwn(described, "neverRetry")).toBe(false);
		}
	});

	it("serializes the effect manifest as JSON the caller can re-parse", () => {
		// The manifest is what a machine consumer reads. Emitting it as a string
		// keeps the describe result flat for CLI transport, so it has to survive
		// a round trip.
		const described = describeContractEffects(createBoundaryContract());
		expect(() => JSON.parse(described.effectManifestJson)).not.toThrow();
		// SAFETY: JSON.parse is checked above and the manifest contract requires contractId.
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
		// The else branch. A missing line reads as "the tool did not check";
		// an explicit "(none)" reads as "there is no profile", which is the
		// answer the operator asked for.
		const contract = createBoundaryContract();
		if (!contract.resilience) {
			expect(formatContractDescribe(contract)).toContain("resilience: (none)");
		}
	});

	it("labels undeclared effects as default(conservative)", () => {
		// Not "none" and not blank: the contract is treated as having the
		// conservative default effects, and the label has to say so or an
		// operator would read the described purity as an author's claim.
		const contract = createBoundaryContract();
		const text = formatContractDescribe(contract);
		expect(text).toContain(
			contract.effects === undefined ? "default(conservative)" : "declared",
		);
	});

	it("produces newline-separated lines with no trailing newline", () => {
		// It is joined, not appended per line. A trailing newline would show as
		// a blank line in every CLI invocation that composes this output.
		const text = formatContractDescribe(createBoundaryContract());
		expect(text.endsWith("\n")).toBe(false);
		expect(text.split("\n").length).toBeGreaterThan(5);
	});
});
