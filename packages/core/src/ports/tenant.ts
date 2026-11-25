/**
 * Multi-tenant foundations — soft isolation via tenant IDs + policy.
 * Hard isolation: separate overlay networks and/or control-plane partitions.
 */
import type { ResidencyConstraint } from "./jurisdiction.js";

// public-contract: brand tag for tenant identifiers.
export type TenantId = string & { readonly __brand: "TenantId" };

// public-contract: brand tag for project identifiers scoped under a tenant.
export type ProjectId = string & { readonly __brand: "ProjectId" };

/**
 * Isolation strength for a tenant's network / control plane.
 * - soft: shared data plane; isolation via IDs + PolicyEngine ACLs
 * - hard-overlay: dedicated overlay network identity (tags/namespace per tenant)
 * - hard-control-plane: dedicated control-plane partition key + hard-overlay
 */
export type TenantIsolationMode =
	| "soft"
	| "hard-overlay"
	| "hard-control-plane";

export function parseTenantId(raw: string): TenantId {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new TypeError("tenantId must be non-empty");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return trimmed as TenantId;
}

export function parseProjectId(raw: string): ProjectId {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new TypeError("projectId must be non-empty");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return trimmed as ProjectId;
}

/** First-class tenant / organization entity. */
export interface Tenant {
	readonly id: TenantId;
	readonly slug: string;
	readonly displayName: string;
	readonly createdAt: string;
	readonly isolationMode?: TenantIsolationMode;
	/**
	 * Per-tenant residency constraint (Plan 50 §G / ADR-0146): where this
	 * tenant's data may live, evaluated by `evaluateResidency` at plan time
	 * and consumed by can-trail/can-migrate as residency-conflict input.
	 */
	readonly residency?: ResidencyConstraint;
	/**
	 * Hard isolation: stable overlay network namespace (e.g. tailnet key or
	 * Netbird setup key scope). Soft mode leaves this undefined.
	 */
	readonly overlayNetworkId?: string;
	/**
	 * Hard control-plane partition key (separate event store / broker stream).
	 */
	readonly controlPlanePartition?: string;
	readonly metadata?: Readonly<Record<string, string>>;
}

/** Any resource that is tenant-scoped by default. */
export interface TenantScoped {
	readonly tenantId: TenantId;
}

/** Tenant + optional project + environment stack context for naming / policy. */
export interface TenantContext extends TenantScoped {
	readonly projectId?: ProjectId;
	readonly env?: string;
	readonly branch?: string;
}

/** Single-tenant local default used when HOBO_TENANT is unset. */
// public-contract: default tenant id for pure-local / single-tenant mode.
export const LOCAL_DEFAULT_TENANT_ID = parseTenantId("local");

export function tenantContextFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): TenantContext {
	const tenantRaw = env.HOBO_TENANT ?? env.HOBO_MCP_TENANT ?? "local";
	const projectRaw = env.HOBO_PROJECT;
	const branchRaw = env.HOBO_BRANCH ?? env.GIT_BRANCH;
	const envName = env.HOBO_ENV ?? env.NODE_ENV;
	return {
		tenantId: parseTenantId(tenantRaw),
		...(projectRaw !== undefined && projectRaw.trim() !== ""
			? { projectId: parseProjectId(projectRaw) }
			: undefined),
		...(branchRaw !== undefined && branchRaw.trim() !== ""
			? { branch: branchRaw }
			: undefined),
		...(envName !== undefined && envName.trim() !== ""
			? { env: envName }
			: undefined),
	};
}
