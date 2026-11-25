/**
 * Extensible PolicyEngine port.
 *
 * Initial implementations wrap overlay ACLs/tags; future engines may use
 * attribute-based rules, Rego/OPA, time windows, etc. without rewriting callers.
 */

import type { JsonObject } from "../json.js";
import type { TenantId } from "./tenant.js";

export type PolicyDecisionEffect = "allow" | "deny";

export interface PolicySubject {
	readonly identity: string;
	readonly tenantId: TenantId;
	/** Overlay / capability tags, e.g. `role:junction`, `tenant:acme`. */
	readonly tags: readonly string[];
	readonly attributes?: Readonly<Record<string, string>>;
}

export interface PolicyResource {
	readonly kind: string;
	readonly id: string;
	readonly tenantId: TenantId;
	readonly tags?: readonly string[];
	readonly attributes?: Readonly<Record<string, string>>;
}

export interface PolicyRequest {
	readonly subject: PolicySubject;
	readonly action: string;
	readonly resource: PolicyResource;
	readonly context?: JsonObject;
}

export interface PolicyDecision {
	readonly effect: PolicyDecisionEffect;
	readonly engineId: string;
	readonly reasons: readonly string[];
	readonly obligations?: readonly string[];
	readonly audit: {
		readonly decidedAt: string;
		readonly tenantId: TenantId;
		readonly action: string;
		readonly resourceKind: string;
		readonly resourceId: string;
		readonly subjectIdentity: string;
	};
}

export interface PolicyEngine {
	readonly engineId: string;
	evaluate(request: PolicyRequest): Promise<PolicyDecision>;
}

export function denyDecision(
	engineId: string,
	request: PolicyRequest,
	reasons: readonly string[],
): PolicyDecision {
	return {
		effect: "deny",
		engineId,
		reasons,
		audit: {
			decidedAt: new Date().toISOString(),
			tenantId: request.subject.tenantId,
			action: request.action,
			resourceKind: request.resource.kind,
			resourceId: request.resource.id,
			subjectIdentity: request.subject.identity,
		},
	};
}

export function allowDecision(
	engineId: string,
	request: PolicyRequest,
	reasons: readonly string[] = ["allowed"],
	obligations?: readonly string[],
): PolicyDecision {
	return {
		effect: "allow",
		engineId,
		reasons,
		...(obligations !== undefined ? { obligations } : undefined),
		audit: {
			decidedAt: new Date().toISOString(),
			tenantId: request.subject.tenantId,
			action: request.action,
			resourceKind: request.resource.kind,
			resourceId: request.resource.id,
			subjectIdentity: request.subject.identity,
		},
	};
}
