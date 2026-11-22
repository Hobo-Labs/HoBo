import { randomUUID } from "node:crypto";
import type { PolicyDecision, PolicyRequest } from "@hobo/core";
import type { AuthorityDeps, Outcome } from "./ports.js";

const POLICY_DECISION_STREAM_PREFIX = "fleet-policy-";
const POLICY_DECISION_ACTOR = {
	kind: "service",
	id: "hobo-fleet-authority",
} as const;

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
