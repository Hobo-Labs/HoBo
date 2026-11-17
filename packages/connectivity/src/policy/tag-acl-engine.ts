import {
	allowDecision,
	createUsageEvent,
	denyDecision,
	type MeteringBus,
	type PolicyDecision,
	type PolicyEngine,
	type PolicyRequest,
} from "@hobo/core";

import {
	type EnvIsolationEvalContext,
	evaluateEnvIsolation,
} from "../env-isolation/evaluate.js";

// public-contract:
export const TAG_ACL_POLICY_ENGINE_ID = "hobo.policy.tag-acl/v1" as const;

export type TagAclPolicyEngineOptions = Readonly<{
	readonly metering?: MeteringBus;
	readonly envIsolation?: EnvIsolationEvalContext;
	readonly enforceEnvIsolation?: boolean;
}>;

export function createTagAclPolicyEngine(
	options?: TagAclPolicyEngineOptions,
): PolicyEngine {
	const metering = options?.metering;
	const enforceEnv = options?.enforceEnvIsolation !== false;

	return {
		engineId: TAG_ACL_POLICY_ENGINE_ID,
		async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
			if (options?.envIsolation?.engineUnavailable === true) {
				const decision = denyDecision(TAG_ACL_POLICY_ENGINE_ID, request, [
					"policy engine unavailable — fail closed",
				]);
				await meter(metering, request, decision);
				return decision;
			}

			const sameTenant = request.subject.tenantId === request.resource.tenantId;
			const shared =
				request.resource.tags?.includes("shared:true") === true ||
				request.resource.attributes?.shared === "true";

			if (!sameTenant && !shared) {
				const decision = denyDecision(TAG_ACL_POLICY_ENGINE_ID, request, [
					"cross-tenant access denied",
				]);
				await meter(metering, request, decision, { axis: "tenant" });
				return decision;
			}

			if (enforceEnv) {
				const envVerdict = evaluateEnvIsolation(
					request,
					options?.envIsolation ?? {},
				);
				if (!envVerdict.allow) {
					const decision = denyDecision(
						TAG_ACL_POLICY_ENGINE_ID,
						request,
						envVerdict.reasons,
					);
					await meter(metering, request, decision, {
						axis: "environment",
						code: envVerdict.code ?? "cross-env-denied",
						subjectClass: envVerdict.subjectClass ?? "",
						resourceClass: envVerdict.resourceClass ?? "",
					});
					return decision;
				}
			}

			const required = (request.resource.tags ?? []).filter((t) =>
				t.startsWith("require:"),
			);
			const missing = required.filter(
				(tag) => !request.subject.tags.includes(tag.slice("require:".length)),
			);
			if (missing.length > 0) {
				const decision = denyDecision(TAG_ACL_POLICY_ENGINE_ID, request, [
					`missing required tags: ${missing.join(", ")}`,
				]);
				await meter(metering, request, decision);
				return decision;
			}

			const decision = allowDecision(TAG_ACL_POLICY_ENGINE_ID, request, [
				sameTenant ? "same-tenant" : "shared-resource",
				enforceEnv ? "env-isolation-ok" : "env-isolation-skipped",
			]);
			await meter(metering, request, decision, { axis: "allow" });
			return decision;
		},
	};
}

async function meter(
	metering: MeteringBus | undefined,
	request: PolicyRequest,
	decision: PolicyDecision,
	extra?: Readonly<Record<string, string>>,
): Promise<void> {
	if (!metering) return;
	await metering.emit(
		createUsageEvent({
			tenantId: request.subject.tenantId,
			eventType: "policy.evaluate",
			resource: `${request.resource.kind}:${request.resource.id}`,
			metadata: {
				effect: decision.effect,
				action: request.action,
				engineId: TAG_ACL_POLICY_ENGINE_ID,
				...extra,
			},
		}),
	);
}
