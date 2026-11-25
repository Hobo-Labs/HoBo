import type { ResidencyConstraint } from "./jurisdiction.js";

// public-contract: brand tag for tenant identifiers.
export type TenantId = string & { readonly __brand: "TenantId" };

// public-contract: brand tag for project identifiers scoped under a tenant.
export type ProjectId = string & { readonly __brand: "ProjectId" };

export type TenantIsolationMode =
	| "soft"
	| "hard-overlay"
	| "hard-control-plane";

export function parseTenantId(raw: string): TenantId {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new TypeError("tenantId must be non-empty");
	}
	return trimmed as TenantId;
}

export function parseProjectId(raw: string): ProjectId {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new TypeError("projectId must be non-empty");
	}
	return trimmed as ProjectId;
}

export interface Tenant {
	readonly id: TenantId;
	readonly slug: string;
	readonly displayName: string;
	readonly createdAt: string;
	readonly isolationMode?: TenantIsolationMode;
	readonly residency?: ResidencyConstraint;
	readonly overlayNetworkId?: string;
	readonly controlPlanePartition?: string;
	readonly metadata?: Readonly<Record<string, string>>;
}

export interface TenantScoped {
	readonly tenantId: TenantId;
}

export interface TenantContext extends TenantScoped {
	readonly projectId?: ProjectId;
	readonly env?: string;
	readonly branch?: string;
}

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
