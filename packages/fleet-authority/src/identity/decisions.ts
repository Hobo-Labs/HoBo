/**
 * `PolicyDecisionRecorder` over @hobo/policy (§6.13): every governed decision
 * becomes one `policy.Decided` event, the type @hobo/policy's IR names, with
 * the request's canonical hash so an auditor can match a decision to the
 * exact input it was made on. Never retried or rewritten (ADR-0136).
 */
import { createHash } from "node:crypto";
import type { JsonObject, PolicyDecision, PolicyRequest } from "@hobo/core";
import type { PolicyDecisionRecorder } from "@hobo/fleet";
import { canonicalJson, POLICY_DECIDED_EVENT_TYPE } from "@hobo/policy";

function requestJson(request: PolicyRequest): JsonObject {
	const subject: JsonObject = {
		identity: request.subject.identity,
		tenantId: request.subject.tenantId,
		tags: [...request.subject.tags],
	};
	const resource: JsonObject = {
		kind: request.resource.kind,
		id: request.resource.id,
		tenantId: request.resource.tenantId,
	};
	return request.context === undefined
		? { subject, action: request.action, resource }
		: { subject, action: request.action, resource, context: request.context };
}

export function createPolicyDecisionRecorder(): PolicyDecisionRecorder {
	return {
		toEvent(request, decision: PolicyDecision) {
			const input = requestJson(request);
			const inputHash = `sha256:${createHash("sha256").update(canonicalJson(input), "utf8").digest("hex")}`;
			return {
				type: POLICY_DECIDED_EVENT_TYPE,
				data: {
					action: request.action,
					effect: decision.effect,
					engineId: decision.engineId,
					reasons: [...decision.reasons],
					obligations: [...(decision.obligations ?? [])],
					subject: request.subject.identity,
					subjectTags: [...request.subject.tags],
					resourceKind: request.resource.kind,
					resourceId: request.resource.id,
					decidedAt: decision.audit.decidedAt,
					inputHash,
				},
			};
		},
	};
}
