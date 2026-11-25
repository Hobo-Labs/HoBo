/**
 * DNS-valid hierarchical naming for HoBo endpoints.
 *
 * Construction:
 *   {resource}.{app}.{env?}.{branch?}.{project?}.{tenant?}.hobo.{tld}
 *
 * Rules:
 * - `hobo` is a zone label, never a TLD. Bare `.hobo` is invalid and never emitted.
 * - Default local TLD = `localhost`; default overlay/internal TLD = `test`.
 * - The `prod` environment segment is omitted (configurable via defaultEnv).
 * - All dynamic labels are sanitized (Vercel-inspired).
 */

// public-contract: zone label that namespaces all HoBo hierarchical names.
export const HOBO_ZONE_LABEL = "hobo" as const;

// public-contract: default TLD for pure-local / portless names.
export const DEFAULT_LOCAL_TLD = "localhost" as const;

// public-contract: default TLD for overlay / internal names (RFC 6761 .test).
export const DEFAULT_OVERLAY_TLD = "test" as const;

// public-contract: environment segment value that is omitted from names.
export const DEFAULT_OMITTED_ENV = "prod" as const;

/** Invalid endings that must never be produced. */
const BARE_HOBO_SUFFIX = `.${HOBO_ZONE_LABEL}`;

export type NamedEndpointMode = "local" | "overlay";

export interface NamedEndpointParams {
	readonly resource: string;
	readonly app: string;
	/** Omitted when equal to defaultEnv (default `"prod"`). */
	readonly env?: string;
	/** Git branch / worktree for preview isolation. */
	readonly branch?: string;
	readonly project?: string;
	/** Required in multi-tenant mode; elidable for single-tenant local. */
	readonly tenant?: string;
	readonly mode: NamedEndpointMode;
	/** Override TLD; defaults from mode. */
	readonly tld?: string;
	/** Env value that is dropped from the hierarchy (default `"prod"`). */
	readonly defaultEnv?: string;
	/**
	 * When true, throw if `tenant` is missing (multi-tenant control plane).
	 * Default false so local single-tenant remains zero-config.
	 */
	readonly requireTenant?: boolean;
}

/**
 * Vercel-inspired DNS label sanitizer.
 * Lowercases, replaces non-alphanumerics with `-`, collapses dashes, trims, caps length.
 */
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

/**
 * Build a DNS-valid hierarchical hostname (no scheme).
 * Never ends in bare `.hobo`.
 */
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

/**
 * Build a full URL for a named endpoint (default scheme https).
 * Pass `port` when the name is bound to a loopback listener that is not 80/443.
 */
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

/** True when a hostname is a legal HoBo hierarchical name (ends with .hobo.<tld>). */
export function isHoboHierarchicalName(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (host.endsWith(BARE_HOBO_SUFFIX) || host === HOBO_ZONE_LABEL) return false;
	return host.includes(`.${HOBO_ZONE_LABEL}.`);
}
