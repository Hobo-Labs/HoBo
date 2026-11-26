/**
 * Agent guardrails: the parse boundary, the classifier, and the gate branches
 * the end-to-end scenarios in `agent-guardrails.test.ts` do not reach.
 *
 * This is the thing standing between an autonomous agent and a `destroy`, so
 * the failure each assertion prevents is generally "an action executes that a
 * human never sanctioned" or "a refusal is recorded with evidence that does
 * not say why". Both are silent at runtime, which is why they are pinned here.
 */
import { describe, expect, it } from "vitest";

import {
	ACTION_CLASS_EFFECTS,
	ACTION_CLASSES,
	AGENT_GUARDRAILS_ENGINE_ID,
	AGENT_GUARDRAILS_SCHEMA_VERSION,
	canAgentProceed,
	classifyActionClass,
	evaluateAgentGuardrail,
	parseAgentGuardrailPolicy,
	rebuildAgentGuardrailState,
} from "../src/agent-guardrails.js";
import { POLICY_IR_SCHEMA_VERSION } from "../src/policy-ir.js";

const AGENT_ID = "tenant-a/agent-deploy";

function req(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: POLICY_IR_SCHEMA_VERSION,
		subject: {
			kind: "agent",
			id: "agent:tenant-a/agent-deploy",
			delegatedBy: "user:platform-admin",
		},
		action: "hobo:deployment:apply",
		resource: { kind: "deployment", id: "d-1" },
		phase: "apply",
		context: { costEstimateUsd: 0 },
		...overrides,
	};
}

function policy(overrides: Record<string, unknown> = {}) {
	return {
		agentId: AGENT_ID,
		actionClasses: {
			read: "auto-allow",
			write: "require-approval",
			deploy: "require-approval",
			destroy: "deny",
			token: "require-approval",
			admin: "deny",
		},
		spendCapUsd: 50,
		allowedApprovers: ["user:platform-admin"],
		...overrides,
	};
}

describe("classifyActionClass", () => {
	it("is checked in precedence order, destroy first", () => {
		// The order is the safety property: an action naming both `destroy` and
		// `deployment:apply` must classify as the *more* dangerous class, or a
		// destroy would be gated by the deploy policy.
		expect(classifyActionClass("hobo:deployment:apply-destroy")).toBe(
			"destroy",
		);
		expect(classifyActionClass("hobo:resource.delete")).toBe("destroy");
		expect(classifyActionClass("admin:token:mint")).toBe("token");
		expect(classifyActionClass("deployment:promote:admin")).toBe("deploy");
	});

	it("classifies each deployment mutation verb as deploy", () => {
		for (const verb of ["apply", "promote", "rollback"]) {
			expect(classifyActionClass(`hobo:deployment:${verb}`)).toBe("deploy");
		}
		// `deployment:get` is not a mutation and must fall through to read, or
		// every dashboard poll would demand an approval.
		expect(classifyActionClass("hobo:deployment:get")).toBe("read");
	});

	it("classifies each read verb", () => {
		for (const verb of ["get", "list", "read", "inspect", "tail"]) {
			expect(classifyActionClass(`hobo:camp:${verb}`)).toBe("read");
		}
	});

	it("classifies token and admin actions", () => {
		expect(classifyActionClass("hobo:token:rotate")).toBe("token");
		expect(classifyActionClass("hobo:admin:impersonate")).toBe("admin");
	});

	it("is case-insensitive", () => {
		// Action strings come from callers with different conventions. A
		// case-sensitive match would let `DESTROY` fall through to `write`, which
		// is the least restrictive default.
		expect(classifyActionClass("HOBO:RESOURCE.DELETE")).toBe("destroy");
		expect(classifyActionClass("Hobo:Camp:List")).toBe("read");
	});

	it("defaults unknown actions to write, not read", () => {
		// Fail-closed-ish: an action nobody classified must land in a class that
		// is gated by default rather than in `read`, which is typically
		// auto-allow.
		expect(classifyActionClass("hobo:camp:frobnicate")).toBe("write");
		expect(classifyActionClass("")).toBe("write");
		expect(classifyActionClass(undefined)).toBe("write");
		expect(classifyActionClass(null)).toBe("write");
	});

	it("stringifies a non-string action rather than throwing", () => {
		expect(classifyActionClass(7)).toBe("write");
		expect(classifyActionClass({ toString: () => "hobo:destroy" })).toBe(
			"destroy",
		);
	});
});

describe("parseAgentGuardrailPolicy", () => {
	it("parses a full policy", () => {
		const parsed = parseAgentGuardrailPolicy(policy());
		expect(parsed.schemaVersion).toBe(AGENT_GUARDRAILS_SCHEMA_VERSION);
		expect(parsed.agentId).toBe(AGENT_ID);
		expect(parsed.spendCapUsd).toBe(50);
		expect(parsed.allowedApprovers).toEqual(["user:platform-admin"]);
		expect(parsed.destroyGrant).toEqual({ granted: false, grantId: null });
	});

	it("defaults every unlisted action class to require-approval", () => {
		const parsed = parseAgentGuardrailPolicy({ agentId: AGENT_ID });
		// Fail-closed default. If an unlisted class defaulted to auto-allow, a
		// policy author who forgot `destroy` would grant it silently.
		for (const actionClass of ACTION_CLASSES) {
			expect(parsed.actionClasses[actionClass]).toBe("require-approval");
		}
	});

	it("fills in only the classes the author omitted", () => {
		const parsed = parseAgentGuardrailPolicy({
			agentId: AGENT_ID,
			actionClasses: { read: "auto-allow" },
		});
		expect(parsed.actionClasses.read).toBe("auto-allow");
		expect(parsed.actionClasses.destroy).toBe("require-approval");
	});

	it("ignores action classes outside the vocabulary", () => {
		const parsed = parseAgentGuardrailPolicy({
			agentId: AGENT_ID,
			actionClasses: { read: "auto-allow", teleport: "auto-allow" },
		});
		// The loop iterates the *vocabulary*, not the document, so an invented
		// class cannot introduce a gate nothing consults — and cannot smuggle an
		// invalid effect past the validity check either.
		expect(Object.keys(parsed.actionClasses).sort()).toEqual(
			[...ACTION_CLASSES].sort(),
		);
	});

	it("rejects an effect outside the vocabulary and names the class", () => {
		expect(() =>
			parseAgentGuardrailPolicy({
				agentId: AGENT_ID,
				actionClasses: { destroy: "allow" },
			}),
		).toThrowError(/policy\.actionClasses\.destroy/u);
		// "allow" is a *policy IR* effect but not an action-class effect. Silently
		// accepting it would make the class gate read as neither allow nor deny.
		expect(ACTION_CLASS_EFFECTS).toEqual([
			"auto-allow",
			"require-approval",
			"deny",
		]);
	});

	it("rejects a non-object policy or actionClasses", () => {
		expect(() => parseAgentGuardrailPolicy(null)).toThrowError(
			/policy must be an object/u,
		);
		expect(() => parseAgentGuardrailPolicy([])).toThrowError(
			/policy must be an object/u,
		);
		expect(() =>
			parseAgentGuardrailPolicy({ agentId: AGENT_ID, actionClasses: [] }),
		).toThrowError(/policy\.actionClasses must be an object/u);
	});

	it("requires a non-empty agentId and trims it", () => {
		// The agentId is the metering key and the policy id. An empty one would
		// read spend for `agent:` — a bucket shared by every misconfigured agent.
		expect(() => parseAgentGuardrailPolicy({})).toThrowError(
			/policy\.agentId/u,
		);
		expect(() => parseAgentGuardrailPolicy({ agentId: "   " })).toThrowError(
			/policy\.agentId/u,
		);
		expect(
			parseAgentGuardrailPolicy({ agentId: ` ${AGENT_ID} ` }).agentId,
		).toBe(AGENT_ID);
	});

	it("treats an absent or null spendCapUsd as no cap", () => {
		// `null` means uncapped, and `0` means "no spend at all". Conflating them
		// via a truthiness check would turn a zero cap into unlimited spend.
		expect(
			parseAgentGuardrailPolicy({ agentId: AGENT_ID }).spendCapUsd,
		).toBeNull();
		expect(
			parseAgentGuardrailPolicy({ agentId: AGENT_ID, spendCapUsd: null })
				.spendCapUsd,
		).toBeNull();
		expect(
			parseAgentGuardrailPolicy({ agentId: AGENT_ID, spendCapUsd: 0 })
				.spendCapUsd,
		).toBe(0);
	});

	it("rounds the spend cap to cents and rejects negative or non-finite caps", () => {
		expect(
			parseAgentGuardrailPolicy({ agentId: AGENT_ID, spendCapUsd: 10.005 })
				.spendCapUsd,
		).toBe(10.01);
		// A negative or NaN cap would compare false against every projected spend
		// and gate nothing.
		for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "abc"]) {
			expect(() =>
				parseAgentGuardrailPolicy({ agentId: AGENT_ID, spendCapUsd: bad }),
			).toThrowError(/policy\.spendCapUsd/u);
		}
		// A numeric string is coerced, which is deliberate for JSON-ish configs.
		expect(
			parseAgentGuardrailPolicy({ agentId: AGENT_ID, spendCapUsd: "25" })
				.spendCapUsd,
		).toBe(25);
	});

	it("defaults allowedApprovers to an empty list and rejects non-string members", () => {
		expect(
			parseAgentGuardrailPolicy({ agentId: AGENT_ID }).allowedApprovers,
		).toEqual([]);
		// Empty means "any approver"; the gates below check `length > 0` first.
		// A numeric member would never match an approverId string, so it would
		// silently narrow the allow-list to nothing.
		expect(() =>
			parseAgentGuardrailPolicy({ agentId: AGENT_ID, allowedApprovers: [1] }),
		).toThrowError(/policy\.allowedApprovers/u);
		expect(() =>
			parseAgentGuardrailPolicy({ agentId: AGENT_ID, allowedApprovers: "u" }),
		).toThrowError(/policy\.allowedApprovers/u);
	});

	it("copies allowedApprovers so the caller cannot mutate the parsed policy", () => {
		const approvers = ["user:a"];
		const parsed = parseAgentGuardrailPolicy({
			agentId: AGENT_ID,
			allowedApprovers: approvers,
		});
		approvers.push("user:attacker");
		// Without the copy, a caller holding the source array could add itself to
		// the allow-list after parsing and before evaluation.
		expect(parsed.allowedApprovers).toEqual(["user:a"]);
	});

	it("normalizes destroyGrant, requiring a literal true to grant", () => {
		expect(
			parseAgentGuardrailPolicy({ agentId: AGENT_ID }).destroyGrant,
		).toEqual({ granted: false, grantId: null });
		expect(
			parseAgentGuardrailPolicy({ agentId: AGENT_ID, destroyGrant: null })
				.destroyGrant,
		).toEqual({ granted: false, grantId: null });
		expect(
			parseAgentGuardrailPolicy({
				agentId: AGENT_ID,
				destroyGrant: { granted: true, grantId: 42 },
			}).destroyGrant,
		).toEqual({ granted: true, grantId: "42" });
		// `granted: "true"` is a string that a truthiness check would honour.
		// Destroy is irreversible, so only the boolean counts.
		expect(
			parseAgentGuardrailPolicy({
				agentId: AGENT_ID,
				destroyGrant: { granted: "true" },
			}).destroyGrant,
		).toEqual({ granted: false, grantId: null });
		expect(() =>
			parseAgentGuardrailPolicy({ agentId: AGENT_ID, destroyGrant: "yes" }),
		).toThrowError(/policy\.destroyGrant must be an object/u);
	});
});

describe("evaluateAgentGuardrail — input normalization", () => {
	it("rejects a non-object input", () => {
		expect(() => evaluateAgentGuardrail(null)).toThrowError(
			/input must be an object/u,
		);
	});

	it("defaults the enforcement point to gateway and accepts runtime", () => {
		const gateway = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
		});
		expect(gateway.decision.evidence.enforcementPoint ?? "gateway").toBe(
			"gateway",
		);
		const runtime = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
			enforcementPoint: "runtime",
		});
		// The two points are gated by the same policy but audited separately, so
		// an unrecognized value must collapse to the stricter-to-explain default
		// rather than being echoed back into the audit record.
		expect(runtime.events[0].audit.enforcementPoint).toBe("runtime");
		expect(
			evaluateAgentGuardrail({
				request: req({ action: "hobo:camp:list" }),
				policy: policy(),
				enforcementPoint: "sidecar",
			}).events[0].audit.enforcementPoint,
		).toBe("gateway");
	});

	it("treats an absent metering view as zero prior spend", () => {
		const result = evaluateAgentGuardrail({
			request: req({
				action: "hobo:camp:list",
				context: { costEstimateUsd: 5 },
			}),
			policy: policy({ spendCapUsd: 10 }),
		});
		// A missing view must not read as "unknown, therefore block" or as
		// "unknown, therefore ignore the cap" — it reads as zero spent so far.
		expect(result.events[0].audit.currentSpendUsd).toBe(0);
		expect(result.events[0].audit.projectedSpendUsd).toBe(5);
		expect(result.decision.effect).toBe("allow");
	});

	it("reads agent spend from a scoped numeric entry or a cost object", () => {
		for (const entry of [12.5, { cost: 12.5 }]) {
			const result = evaluateAgentGuardrail({
				request: req({
					action: "hobo:camp:list",
					context: { costEstimateUsd: 1 },
				}),
				policy: policy(),
				meteringView: { seq: 3, scopeCosts: { [`agent:${AGENT_ID}`]: entry } },
			});
			// Both shapes are emitted by the metering view depending on version;
			// reading only one would silently report zero spend for the other.
			expect(result.events[0].audit.currentSpendUsd).toBe(12.5);
		}
	});

	it("reads zero for an entry with no cost and for another agent's scope", () => {
		const other = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
			meteringView: { scopeCosts: { "agent:someone-else": 999 } },
		});
		// Spend is per-agent. Reading an unscoped total would block one agent for
		// another's usage.
		expect(other.events[0].audit.currentSpendUsd).toBe(0);
		const noCost = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
			meteringView: { scopeCosts: { [`agent:${AGENT_ID}`]: {} } },
		});
		expect(noCost.events[0].audit.currentSpendUsd).toBe(0);
	});

	it("tolerates a metering view with a non-numeric seq or missing scopeCosts", () => {
		const result = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
			meteringView: { seq: "ten" },
		});
		expect(result.decision.effect).toBe("allow");
		expect(() =>
			evaluateAgentGuardrail({
				request: req({ action: "hobo:camp:list" }),
				policy: policy(),
				meteringView: "none",
			}),
		).toThrowError(/meteringView must be an object/u);
	});

	it("accepts either cost key and rounds to cents", () => {
		for (const key of ["costEstimateUsd", "estimatedCostUsd"]) {
			const result = evaluateAgentGuardrail({
				request: req({ action: "hobo:camp:list", context: { [key]: 2.345 } }),
				policy: policy(),
			});
			// Both spellings appear in callers. Reading only one would make a
			// priced action look free and slip under the cap.
			expect(result.events[0].audit.estimatedCostUsd).toBe(2.35);
		}
	});

	it("rounds half-cents by binary representation, not consistently half-up", () => {
		// Pinning a wart rather than asserting the tidy behaviour. `roundUsd` is
		// `Math.round(value * 100) / 100`, and the multiply is done in binary
		// floating point, so exact half-cents land either way depending on the
		// value: `1.005 * 100` is 100.49999999999999 (rounds down to 1.00) while
		// `10.005 * 100` is 1000.5000000000001 (rounds up to 10.01).
		//
		// The effect is bounded at one cent on a single estimate and the cap
		// comparison is `<=`, so the worst case is an action slipping under a cap
		// by $0.005. Left as-is deliberately: changing the rounding would move
		// every spend-gate boundary and every `estimatedCostUsd` in stored audit
		// records, which is not a call to make inside a coverage change. Flagged
		// rather than fixed.
		const at = (cost: number) =>
			evaluateAgentGuardrail({
				request: req({
					action: "hobo:camp:list",
					context: { costEstimateUsd: cost },
				}),
				policy: policy(),
			}).events[0].audit.estimatedCostUsd;
		expect(at(1.005)).toBe(1);
		expect(at(10.005)).toBe(10.01);
	});

	it("rejects a malformed approval", () => {
		for (const approval of [
			{ decision: "maybe", approverId: "u", approvedAt: "t" },
			{ approverId: "u", approvedAt: "t" },
		]) {
			expect(() =>
				evaluateAgentGuardrail({ request: req(), policy: policy(), approval }),
			).toThrowError(/approval\.decision/u);
		}
		expect(() =>
			evaluateAgentGuardrail({
				request: req(),
				policy: policy(),
				approval: { decision: "approved", approvedAt: "t" },
			}),
		).toThrowError(/approval\.approverId/u);
		// `approvedAt` is the audit timestamp for a human sign-off; an approval
		// with no time cannot be reconciled against a change window.
		expect(() =>
			evaluateAgentGuardrail({
				request: req(),
				policy: policy(),
				approval: { decision: "approved", approverId: "u" },
			}),
		).toThrowError(/approval\.approvedAt/u);
		expect(() =>
			evaluateAgentGuardrail({
				request: req(),
				policy: policy(),
				approval: "approved",
			}),
		).toThrowError(/approval must be an object/u);
	});

	it("treats a null approval as no approval", () => {
		const result = evaluateAgentGuardrail({
			request: req(),
			policy: policy(),
			approval: null,
		});
		expect(result.decision.effect).toBe("require-approval");
		expect(result.events[0].audit.approverId).toBeNull();
	});
});

describe("evaluateAgentGuardrail — action class gate", () => {
	it("auto-allows a class marked auto-allow and emits a cleared event", () => {
		const result = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
		});
		expect(result.actionClass).toBe("read");
		expect(result.decision.effect).toBe("allow");
		expect(result.decision.reason).toBe("read action allowed");
		// The cleared event is what a downstream executor waits on; an allow with
		// no cleared event would stall the agent rather than release it.
		const cleared = result.events.find(
			(e) => e.type === "agent.GuardrailCleared",
		);
		expect(cleared?.data.canProceed).toBe(true);
	});

	it("denies a class marked deny and emits a blocked event", () => {
		const result = evaluateAgentGuardrail({
			request: req({ action: "hobo:admin:impersonate" }),
			policy: policy(),
		});
		expect(result.actionClass).toBe("admin");
		expect(result.decision.effect).toBe("deny");
		expect(result.decision.reason).toContain("denied");
		expect(
			result.events.find((e) => e.type === "agent.GuardrailBlocked")?.data
				.canProceed,
		).toBe(false);
	});

	it("a denied class ignores an otherwise-valid approval", () => {
		const result = evaluateAgentGuardrail({
			request: req({ action: "hobo:admin:impersonate" }),
			policy: policy(),
			approval: {
				decision: "approved",
				approverId: "user:platform-admin",
				approvedAt: "2026-07-01T00:00:00.000Z",
			},
		});
		// `deny` returns before the approval is ever consulted. A class an
		// operator marked deny must not be reachable by finding any approver.
		expect(result.decision.effect).toBe("deny");
		expect(result.decision.approvals).toEqual([]);
	});

	it("raises an approval obligation when none is supplied", () => {
		const result = evaluateAgentGuardrail({ request: req(), policy: policy() });
		expect(result.decision.effect).toBe("require-approval");
		const obligation = result.decision.obligations[0];
		expect(obligation.kind).toBe("agent.approval.required");
		// The id and effectRef bind the obligation to this agent *and* this
		// action, so a satisfaction event for a different action cannot release
		// it — `canAgentProceed` compares both.
		expect(obligation.id).toBe(`approval:${AGENT_ID}:hobo:deployment:apply`);
		expect(obligation.effectRef).toBe(
			`agent-guardrail:${AGENT_ID}:hobo:deployment:apply`,
		);
	});

	it("consumes an approval from an allowed approver", () => {
		const result = evaluateAgentGuardrail({
			request: req(),
			policy: policy(),
			approval: {
				decision: "approved",
				approverId: "user:platform-admin",
				approvedAt: "2026-07-01T00:00:00.000Z",
			},
		});
		expect(result.decision.effect).toBe("allow");
		expect(result.decision.approvals[0].approverId).toBe("user:platform-admin");
		expect(result.events[0].audit.approverId).toBe("user:platform-admin");
	});

	it("denies on an explicit approval denial", () => {
		const result = evaluateAgentGuardrail({
			request: req(),
			policy: policy(),
			approval: {
				decision: "denied",
				approverId: "user:platform-admin",
				approvedAt: "2026-07-01T00:00:00.000Z",
			},
		});
		// A denial is stronger than a missing approval: it must produce `deny`,
		// not another obligation the agent could re-request until someone says yes.
		expect(result.decision.effect).toBe("deny");
		expect(result.decision.reason).toBe(
			"approval denied by user:platform-admin",
		);
	});

	it("rejects an approver outside a non-empty allow-list", () => {
		const result = evaluateAgentGuardrail({
			request: req(),
			policy: policy(),
			approval: {
				decision: "approved",
				approverId: "user:intern",
				approvedAt: "2026-07-01T00:00:00.000Z",
			},
		});
		expect(result.decision.effect).toBe("deny");
		expect(result.decision.reason).toBe(
			"user:intern is not an allowed approver",
		);
	});

	it("accepts any approver when the allow-list is empty", () => {
		const result = evaluateAgentGuardrail({
			request: req(),
			policy: policy({ allowedApprovers: [] }),
			approval: {
				decision: "approved",
				approverId: "user:anyone",
				approvedAt: "2026-07-01T00:00:00.000Z",
			},
		});
		// Empty is "unrestricted", not "nobody" — otherwise a policy that omits
		// the key would be unapprovable and the agent permanently stuck.
		expect(result.decision.effect).toBe("allow");
	});
});

describe("evaluateAgentGuardrail — destroy protection", () => {
	const destroyReq = (context: Record<string, unknown> = {}) =>
		req({
			action: "hobo:resource.delete",
			context: { costEstimateUsd: 0, ...context },
		});

	it("denies a destroy with no grant anywhere and emits a support event", () => {
		const result = evaluateAgentGuardrail({
			request: destroyReq(),
			policy: policy({ actionClasses: { destroy: "auto-allow" } }),
		});
		// Note the policy says auto-allow: destroy protection is a *second*
		// independent gate, so a permissive action-class policy alone can never
		// authorize a destroy.
		expect(result.decision.effect).toBe("deny");
		expect(result.decision.reason).toBe(
			"destroy denied without explicit grant",
		);
		expect(result.events.some((e) => e.type === "agent.DestroyDenied")).toBe(
			true,
		);
	});

	it("accepts a grant from the policy, from context.destroyGrant, or context.destroyGranted", () => {
		const cases: Array<
			[string, Record<string, unknown>, Record<string, unknown>]
		> = [
			["policy grant", { destroyGrant: { granted: true, grantId: "g-1" } }, {}],
			["context grant object", {}, { destroyGrant: { granted: true } }],
			["context boolean", {}, { destroyGranted: true }],
		];
		for (const [label, policyOverrides, context] of cases) {
			const result = evaluateAgentGuardrail({
				request: destroyReq(context),
				policy: policy({
					actionClasses: { destroy: "auto-allow" },
					...policyOverrides,
				}),
			});
			// Three grant channels exist because a grant can be standing (policy)
			// or per-request (context). Any one of them must suffice, or an
			// operator following the documented path would still be refused.
			expect(result.decision.effect, label).toBe("allow");
		}
	});

	it("requires a literal true from the context channels too", () => {
		for (const context of [
			{ destroyGrant: { granted: "true" } },
			{ destroyGranted: "true" },
			{ destroyGrant: {} },
			{ destroyGranted: 1 },
		]) {
			// The context is attacker-adjacent — it is caller-supplied request
			// data. A truthy string must not authorize an irreversible action.
			expect(
				evaluateAgentGuardrail({
					request: destroyReq(context),
					policy: policy({ actionClasses: { destroy: "auto-allow" } }),
				}).decision.effect,
			).toBe("deny");
		}
	});

	it("still applies the action-class gate on top of a valid destroy grant", () => {
		const result = evaluateAgentGuardrail({
			request: destroyReq({ destroyGranted: true }),
			policy: policy(),
		});
		// The default policy denies the destroy class. A grant relaxes destroy
		// *protection*, not the class policy — both must pass.
		expect(result.decision.effect).toBe("deny");
	});

	it("leaves non-destroy actions untouched by the destroy gate", () => {
		const result = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
		});
		expect(result.events.some((e) => e.type === "agent.DestroyDenied")).toBe(
			false,
		);
	});
});

describe("evaluateAgentGuardrail — spend cap gate", () => {
	const priced = (costEstimateUsd: number) =>
		req({ action: "hobo:camp:list", context: { costEstimateUsd } });

	it("is inert when the policy has no cap", () => {
		const result = evaluateAgentGuardrail({
			request: priced(1_000_000),
			policy: policy({ spendCapUsd: null }),
		});
		// Uncapped means uncapped. Blocking here would make an unset cap stricter
		// than any set one.
		expect(result.decision.effect).toBe("allow");
		expect(result.events.some((e) => e.type === "spend.CapGateEvaluated")).toBe(
			false,
		);
	});

	it("is inert for a zero or negative estimate even over the cap", () => {
		for (const cost of [0, -5]) {
			const result = evaluateAgentGuardrail({
				request: priced(cost),
				policy: policy({ spendCapUsd: 1 }),
				meteringView: { scopeCosts: { [`agent:${AGENT_ID}`]: 999 } },
			});
			// A free action must not be blocked by spend already incurred; the gate
			// is about *this* action's marginal cost.
			expect(result.decision.effect).toBe("allow");
		}
	});

	it("allows a projection exactly at the cap", () => {
		const result = evaluateAgentGuardrail({
			request: priced(10),
			policy: policy({ spendCapUsd: 50 }),
			meteringView: { scopeCosts: { [`agent:${AGENT_ID}`]: 40 } },
		});
		// `<=`, not `<`. A cap of 50 means 50 is permitted; an off-by-one here
		// would block the last legitimate action under every budget.
		expect(result.events[0].audit.projectedSpendUsd).toBe(50);
		expect(result.decision.effect).toBe("allow");
	});

	it("raises a cap obligation one cent over the cap", () => {
		const result = evaluateAgentGuardrail({
			request: priced(10.01),
			policy: policy({ spendCapUsd: 50 }),
			meteringView: { scopeCosts: { [`agent:${AGENT_ID}`]: 40 } },
		});
		expect(result.decision.effect).toBe("require-approval");
		expect(result.decision.reason).toBe("agent spendCapUsd requires approval");
		const obligation = result.decision.obligations[0];
		expect(obligation.kind).toBe("spend.agent-cap-approval");
		expect(obligation.id).toBe(`spend-cap:${AGENT_ID}:hobo:camp:list`);
		// The obligation carries the numbers a human needs to decide, so an
		// approver is not asked to sign off on an unexplained block.
		expect(obligation.spendCapUsd).toBe(50);
		expect(obligation.projectedSpendUsd).toBe(50.01);
		expect(
			result.events.some(
				(e) =>
					e.type === "spend.CapGateEvaluated" && e.data.capExceeded === true,
			),
		).toBe(true);
	});

	it("clears the cap with an approval from an allowed approver", () => {
		const result = evaluateAgentGuardrail({
			request: priced(100),
			policy: policy({ spendCapUsd: 50 }),
			approval: {
				decision: "approved",
				approverId: "user:platform-admin",
				approvedAt: "2026-07-01T00:00:00.000Z",
			},
		});
		expect(result.decision.effect).toBe("allow");
		expect(result.decision.approvals[0].kind).toBe("spend.agent-cap-approval");
		expect(result.decision.approvals[0].projectedSpendUsd).toBe(100);
	});

	it("denies on a spend approval denial or a disallowed approver", () => {
		for (const [approverId, decision, reason] of [
			[
				"user:platform-admin",
				"denied",
				"approval denied by user:platform-admin",
			],
			["user:intern", "approved", "user:intern is not an allowed approver"],
		] as const) {
			const result = evaluateAgentGuardrail({
				request: priced(100),
				policy: policy({ spendCapUsd: 50 }),
				approval: {
					decision,
					approverId,
					approvedAt: "2026-07-01T00:00:00.000Z",
				},
			});
			// The spend gate repeats the approver checks rather than sharing them
			// with the class gate; both copies must refuse, or the cheaper path
			// becomes the way around the allow-list.
			expect(result.decision.effect).toBe("deny");
			expect(result.decision.reason).toBe(reason);
		}
	});

	it("both gates can fire, and the destroy reason wins", () => {
		const result = evaluateAgentGuardrail({
			request: req({
				action: "hobo:resource.delete",
				context: { costEstimateUsd: 100 },
			}),
			policy: policy({ spendCapUsd: 1 }),
		});
		expect(result.decision.effect).toBe("deny");
		// `chooseReason` scans for a violation mentioning "destroy" first, so the
		// irreversible problem is what an operator reads — not "over budget".
		expect(result.decision.reason).toBe(
			"destroy denied without explicit grant",
		);
		expect(result.decision.violations.length).toBeGreaterThan(1);
	});

	it("a violation outranks an obligation in the final effect", () => {
		const result = evaluateAgentGuardrail({
			request: req({
				action: "hobo:admin:x",
				context: { costEstimateUsd: 100 },
			}),
			policy: policy({ spendCapUsd: 1 }),
		});
		// deny beats require-approval: an action that is forbidden must not be
		// presented to a human as merely needing sign-off.
		expect(result.decision.effect).toBe("deny");
	});
});

describe("evaluateAgentGuardrail — emitted evidence", () => {
	it("stamps the guardrail engine id and a scoped policy id", () => {
		const result = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
		});
		// Evidence must name what decided and under whose policy, so a replay can
		// tell a guardrail verdict from a residency-pack verdict.
		expect(result.decision.evidence.engine).toBe(AGENT_GUARDRAILS_ENGINE_ID);
		expect(result.decision.evidence.policyIds).toEqual([
			`agent-guardrail:${AGENT_ID}`,
		]);
		expect(result.schemaVersion).toBe(AGENT_GUARDRAILS_SCHEMA_VERSION);
	});

	it("puts policy.Decided first and the guardrail outcome last", () => {
		const result = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
		});
		expect(result.events[0].type).toBe("policy.Decided");
		expect(result.events.at(-1)?.type).toBe("agent.GuardrailCleared");
	});

	it("prefers context.actorId, then delegatedBy, then the subject id", () => {
		const withActor = evaluateAgentGuardrail({
			request: req({
				action: "hobo:camp:list",
				context: { actorId: "user:on-call" },
			}),
			policy: policy(),
		});
		expect(withActor.events[0].audit.actorId).toBe("user:on-call");

		const withDelegate = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
		});
		// The audit trail must name a *human* wherever one exists; falling
		// straight to the agent's own id would make every action self-authorized
		// in the record.
		expect(withDelegate.events[0].audit.actorId).toBe("user:platform-admin");

		const bare = evaluateAgentGuardrail({
			request: req({
				action: "hobo:camp:list",
				subject: { kind: "agent", id: "agent:solo" },
			}),
			policy: policy(),
		});
		expect(bare.events[0].audit.actorId).toBe("agent:solo");
	});

	it("uses the request's correlationId and occurredAt when present", () => {
		const result = evaluateAgentGuardrail({
			request: req({
				action: "hobo:camp:list",
				context: {
					correlationId: "corr-1",
					occurredAt: "2026-09-09T00:00:00.000Z",
				},
			}),
			policy: policy(),
		});
		const cleared = result.events.at(-1);
		// Correlation is how a guardrail verdict is joined to the request that
		// triggered it across services.
		expect(cleared?.correlationId).toBe("corr-1");
		expect(cleared?.occurredAt).toBe("2026-09-09T00:00:00.000Z");
	});

	it("falls back to the input hash as a correlation id", () => {
		const result = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
		});
		// Deterministic and request-bound: two evaluations of the same request
		// correlate together even with no caller-supplied id.
		expect(result.events.at(-1)?.correlationId).toBe(
			result.decision.evidence.inputHash,
		);
	});
});

describe("rebuildAgentGuardrailState", () => {
	const decided = (data: Record<string, unknown>) => ({
		type: "policy.Decided",
		seq: 1,
		data,
	});

	it("sorts events by seq before folding", () => {
		const state = rebuildAgentGuardrailState([
			{ type: "agent.GuardrailCleared", seq: 2, data: { canProceed: true } },
			decided({ effect: "allow", reason: "ok", obligations: [] }),
		]);
		// Events arrive from a stream that does not guarantee order. Folding a
		// cleared event before its decision would leave `canProceed` true with no
		// decision behind it.
		expect(state.policyDecision?.effect).toBe("allow");
		expect(state.canProceed).toBe(true);
	});

	it("treats a missing seq as zero rather than throwing", () => {
		const state = rebuildAgentGuardrailState([
			{ type: "agent.GuardrailCleared", data: { canProceed: true } },
			decided({ effect: "allow", reason: "ok", obligations: [] }),
		]);
		expect(state.policyDecision).not.toBeNull();
	});

	it("does not mutate the caller's array", () => {
		const events = [
			{ type: "agent.GuardrailCleared", seq: 2, data: { canProceed: true } },
			decided({ effect: "allow", reason: "ok", obligations: [] }),
		];
		rebuildAgentGuardrailState(events);
		// `sort` is in-place; without the spread this would reorder a caller's
		// event log as a side effect of reading it.
		expect(events[0].type).toBe("agent.GuardrailCleared");
	});

	it("a blocked event forces canProceed false", () => {
		const state = rebuildAgentGuardrailState([
			decided({ effect: "deny", reason: "no", obligations: [] }),
			{ type: "agent.GuardrailBlocked", seq: 2, data: { canProceed: false } },
		]);
		expect(state.blocked).not.toBeNull();
		expect(state.canProceed).toBe(false);
	});

	it("a cleared event requires a literal true", () => {
		// `canProceed: "yes"` from a hand-written or replayed event must not
		// release the agent.
		expect(
			rebuildAgentGuardrailState([
				{ type: "agent.GuardrailCleared", seq: 2, data: { canProceed: "yes" } },
			]).canProceed,
		).toBe(false);
	});

	it("indexes obligation satisfactions by id and ignores unknown event types", () => {
		const state = rebuildAgentGuardrailState([
			{ type: "policy.ObligationSatisfied", seq: 3, data: { id: "o-1" } },
			{ type: "some.Other", seq: 4, data: {} },
		]);
		expect(state.obligationsSatisfied.get("o-1")).toEqual({ id: "o-1" });
		// An unknown type must not clear or set any flag — forward compatibility
		// with a newer writer.
		expect(state.canProceed).toBe(false);
	});

	it("starts from a fully closed state", () => {
		const state = rebuildAgentGuardrailState([]);
		expect(state).toMatchObject({
			policyDecision: null,
			blocked: null,
			cleared: null,
			canProceed: false,
		});
		expect(state.obligationsSatisfied.size).toBe(0);
	});
});

describe("canAgentProceed", () => {
	function blockedRun() {
		return evaluateAgentGuardrail({ request: req(), policy: policy() });
	}

	it("refuses when there is no policy.Decided at all", () => {
		// No decision means nothing authorized this. Defaulting to "proceed"
		// would make a dropped event a permission grant.
		expect(canAgentProceed([])).toEqual({
			canProceed: false,
			reason: "missing policy.Decided",
		});
	});

	it("refuses a denied decision and surfaces its reason", () => {
		const run = evaluateAgentGuardrail({
			request: req({ action: "hobo:admin:x" }),
			policy: policy(),
		});
		expect(canAgentProceed(run.events)).toEqual({
			canProceed: false,
			reason: run.decision.reason,
		});
	});

	it("refuses a require-approval decision with no satisfaction event", () => {
		expect(canAgentProceed(blockedRun().events)).toEqual({
			canProceed: false,
			reason: "approval obligation unsatisfied",
		});
	});

	it("releases on a satisfaction that matches id, effectRef, agentId and action", () => {
		const run = blockedRun();
		const obligation = run.decision.obligations[0];
		const result = canAgentProceed([
			...run.events,
			{
				type: "policy.ObligationSatisfied",
				seq: 3,
				data: {
					id: obligation.id,
					effectRef: obligation.effectRef,
					agentId: obligation.agentId,
					action: obligation.action,
				},
			},
		]);
		expect(result).toEqual({ canProceed: true, reason: "approval satisfied" });
	});

	it("refuses a satisfaction that mismatches any bound field", () => {
		const run = blockedRun();
		const obligation = run.decision.obligations[0];
		for (const override of [
			{ effectRef: "agent-guardrail:other:action" },
			{ agentId: "tenant-b/agent" },
			{ action: "hobo:camp:list" },
			{ id: "approval:other" },
		]) {
			const result = canAgentProceed([
				...run.events,
				{
					type: "policy.ObligationSatisfied",
					seq: 3,
					data: {
						id: obligation.id,
						effectRef: obligation.effectRef,
						agentId: obligation.agentId,
						action: obligation.action,
						...override,
					},
				},
			]);
			// Every field is part of the binding. If any one were unchecked, an
			// approval granted for a cheap read could release an expensive deploy.
			expect(result.canProceed, JSON.stringify(override)).toBe(false);
		}
	});

	it("accepts a satisfaction for an obligation that carries no action", () => {
		// The spend-cap obligation has no `action` field, so the comparison is
		// conditional. Requiring it unconditionally would make every cap approval
		// unsatisfiable.
		const run = evaluateAgentGuardrail({
			request: req({
				action: "hobo:camp:list",
				context: { costEstimateUsd: 100 },
			}),
			policy: policy({ spendCapUsd: 1 }),
		});
		const obligation = run.decision.obligations[0];
		expect(obligation.kind).toBe("spend.agent-cap-approval");
		expect(obligation.action).toBeUndefined();
		expect(
			canAgentProceed([
				...run.events,
				{
					type: "policy.ObligationSatisfied",
					seq: 3,
					data: {
						id: obligation.id,
						effectRef: obligation.effectRef,
						agentId: obligation.agentId,
					},
				},
			]),
		).toEqual({ canProceed: true, reason: "approval satisfied" });
	});

	it("refuses a require-approval decision carrying no approval obligation", () => {
		// Defensive: a decision that says "require-approval" but names no
		// obligation is unsatisfiable by construction, and must read as blocked
		// rather than as vacuously satisfied.
		expect(
			canAgentProceed([
				{
					type: "policy.Decided",
					seq: 1,
					data: {
						effect: "require-approval",
						reason: "r",
						obligations: [{ kind: "notify" }],
					},
				},
			]),
		).toEqual({ canProceed: false, reason: "missing approval obligation" });
	});

	it("releases an allowed decision only once a cleared event says so", () => {
		const run = evaluateAgentGuardrail({
			request: req({ action: "hobo:camp:list" }),
			policy: policy(),
		});
		expect(canAgentProceed(run.events)).toEqual({
			canProceed: true,
			reason: run.decision.reason,
		});
		// Strip the cleared event: the decision alone is not a release, because
		// the cleared event is what the executor's own state machine keys on.
		expect(
			canAgentProceed(
				run.events.filter((e) => e.type !== "agent.GuardrailCleared"),
			),
		).toEqual({ canProceed: false, reason: "guardrail not cleared" });
	});
});
