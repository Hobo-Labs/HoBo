/**
 * `decideGoverned`: the one path every governed action takes (design §6.13,
 * §7.3). Plumbing written in the contract commit; it holds no decision of its
 * own. It asks the injected `PolicyEngine`, appends the `policy.Decided` event
 * the injected `PolicyDecisionRecorder` builds, and fails closed: an engine
 * error, a non-allow decision or a failed append are all `forbidden` (rule 1
 * of §3.3). The append is made once and never retried (ADR-0136).
 */
import { randomUUID } from "node:crypto";
import type { PolicyDecision, PolicyRequest } from "@hobo/core";
import type { AuthorityDeps, Outcome } from "./ports.js";

/*
 * Where the decision lands. §7.5 says only "policy decisions | policy.Decided |
 * through the injected recorder" and names no stream or actor, so these two
 * are module-private (not exported, not in the API snapshot) and await a §7.5
 * amendment by the coordinator: one stream per decision, appended once at
 * `expectedSeq: 0`, which is what "never retried" needs.
 */
const POLICY_DECISION_STREAM_PREFIX = "fleet-policy-";
const POLICY_DECISION_ACTOR = {
	kind: "service",
	id: "hobo-fleet-authority",
} as const;

/** Fail closed: any error or non-allow decision is `forbidden`. Appends `policy.Decided` through deps.decisions; never retried (ADR-0136). Written in the contract commit. */
export async function decideGoverned(
	deps: Pick<
		AuthorityDeps,
		"tenant" | "store" | "policy" | "decisions" | "now"
	>,
	request: PolicyRequest,
): Promise<Outcome<PolicyDecision>> {
	const decisionId = randomUUID();
	let decision: PolicyDecision;
	try {
		decision = await deps.policy.evaluate(request);
	} catch {
		return denied(decisionId, "the policy engine failed");
	}
	try {
		await deps.store.append(
			`${POLICY_DECISION_STREAM_PREFIX}${decisionId}`,
			[deps.decisions.toEvent(request, decision)],
			{
				expectedSeq: 0,
				actor: POLICY_DECISION_ACTOR,
				tenant: deps.tenant,
			},
		);
	} catch {
		return denied(decisionId, "the policy decision could not be recorded");
	}
	if (decision.effect !== "allow")
		return denied(decisionId, decision.reasons.join("; ") || "policy denied");
	return { ok: true, value: decision };
}

function denied(decisionId: string, message: string): Outcome<PolicyDecision> {
	return {
		ok: false,
		error: { code: "forbidden", message, detail: { decision: decisionId } },
	};
}
