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

// public-contract: engine id for the initial tag/ACL PolicyEngine.
export const TAG_ACL_POLICY_ENGINE_ID = "hobo.policy.tag-acl/v1" as const;

export type TagAclPolicyEngineOptions = Readonly<{
	readonly metering?: MeteringBus;
	/**
	 * Environment isolation evaluation context (membership, grants, elevated).
	 * When omitted, env isolation still runs with tag-derived classes only.
	 */
	readonly envIsolation?: EnvIsolationEvalContext;
	/**
	 * When false, skip env isolation (tests / migration only). Default true.
	 */
	readonly enforceEnvIsolation?: boolean;
}>;

/**
 * Tenant-aware + environment-isolation tag/ACL evaluator.
 * - Cross-tenant access denied unless resource tags include `shared:true`.
 * - Cross-env access denied unless elevated capability / cross-env grant / break-glass.
 * - Missing env tags → deny (fail closed) when enforceEnvIsolation is true.
 * - Optional required tags on the resource must all be present on the subject.
 * - Fail closed when envIsolation.engineUnavailable is set.
 */
export function createTagAclPolicyEngine(
	options?: TagAclPolicyEngineOptions,
): PolicyEngine {
	const metering = options?.metering;
	const enforceEnv = options?.enforceEnvIsolation !== false;

	return {
		engineId: TAG_ACL_POLICY_ENGINE_ID,
		async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
			// (0) Fail closed on simulated engine outage.
			if (options?.envIsolation?.engineUnavailable === true) {
				const decision = denyDecision(TAG_ACL_POLICY_ENGINE_ID, request, [
					"policy engine unavailable — fail closed",
				]);
				await meter(metering, request, decision);
				return decision;
			}

			// (1) Tenant axis
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

			// (2) Environment isolation axis (soft floor always on)
			if (enforceEnv) {
				const envVerdict = await evaluateEnvIsolation(
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

			// (3) require:* tags
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
