
// public-contract: zone label that namespaces all HoBo hierarchical names.
export const HOBO_ZONE_LABEL = "hobo" as const;

// public-contract: default TLD for pure-local / portless names.
export const DEFAULT_LOCAL_TLD = "localhost" as const;

// public-contract: default TLD for overlay / internal names (RFC 6761 .test).
export const DEFAULT_OVERLAY_TLD = "test" as const;

// public-contract: environment segment value that is omitted from names.
export const DEFAULT_OMITTED_ENV = "prod" as const;

const BARE_HOBO_SUFFIX = `.${HOBO_ZONE_LABEL}`;

export type NamedEndpointMode = "local" | "overlay";

export interface NamedEndpointParams {
	readonly resource: string;
	readonly app: string;
	readonly env?: string;
	readonly branch?: string;
	readonly project?: string;
	readonly tenant?: string;
	readonly mode: NamedEndpointMode;
	readonly tld?: string;
	readonly defaultEnv?: string;
	readonly requireTenant?: boolean;
}

export function sanitizeDnsLabel(input: string, maxLength = 63): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, maxLength)
		.replace(/-$/, "");
}

function requireNonEmptyLabel(raw: string, field: string): string {
	const label = sanitizeDnsLabel(raw);
	if (label.length === 0) {
		throw new TypeError(`named endpoint ${field} sanitizes to empty label`);
	}
	return label;
}

export function getNamedEndpointHost(params: NamedEndpointParams): string {
	const resource = requireNonEmptyLabel(params.resource, "resource");
	const app = requireNonEmptyLabel(params.app, "app");
	const defaultEnv = params.defaultEnv ?? DEFAULT_OMITTED_ENV;
	const tldRaw =
		params.tld ??
		(params.mode === "local" ? DEFAULT_LOCAL_TLD : DEFAULT_OVERLAY_TLD);
	const tld = requireNonEmptyLabel(tldRaw, "tld");

	if (
		params.requireTenant === true &&
		(params.tenant === undefined || params.tenant.trim() === "")
	) {
		throw new TypeError("named endpoint requires tenant in multi-tenant mode");
	}

	const segments: string[] = [resource, app];

	if (params.env !== undefined && params.env.trim() !== "") {
		const env = sanitizeDnsLabel(params.env);
		if (env.length > 0 && env !== sanitizeDnsLabel(defaultEnv)) {
			segments.push(env);
		}
	}

	if (params.branch !== undefined && params.branch.trim() !== "") {
		const branch = sanitizeDnsLabel(params.branch);
		if (branch.length > 0) segments.push(branch);
	}

	if (params.project !== undefined && params.project.trim() !== "") {
		const project = sanitizeDnsLabel(params.project);
		if (project.length > 0) segments.push(project);
	}

	if (params.tenant !== undefined && params.tenant.trim() !== "") {
		const tenant = sanitizeDnsLabel(params.tenant);
		if (tenant.length > 0) segments.push(tenant);
	}

	segments.push(HOBO_ZONE_LABEL, tld);
	const host = segments.join(".");

	if (host.endsWith(BARE_HOBO_SUFFIX) || host === HOBO_ZONE_LABEL) {
		throw new Error(`refusing bare .hobo hostname: ${host}`);
	}
	if (!host.includes(`.${HOBO_ZONE_LABEL}.`)) {
		throw new Error(`hostname missing hobo zone label: ${host}`);
	}

	return host;
}

export function getNamedEndpoint(
	params: NamedEndpointParams & {
		readonly scheme?: "http" | "https";
		readonly port?: number;
	},
): string {
	const host = getNamedEndpointHost(params);
	const scheme = params.scheme ?? "https";
	const port = params.port;
	const omitPort =
		port === undefined ||
		port <= 0 ||
		(scheme === "https" && port === 443) ||
		(scheme === "http" && port === 80);
	return omitPort ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}

export function isHoboHierarchicalName(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (host.endsWith(BARE_HOBO_SUFFIX) || host === HOBO_ZONE_LABEL) return false;
	return host.includes(`.${HOBO_ZONE_LABEL}.`);
}
