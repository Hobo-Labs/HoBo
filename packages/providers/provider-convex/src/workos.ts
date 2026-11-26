/**
 * WorkOS AuthKit external contract for Convex swaghaus (fail-closed).
 * Secrets ride Camp secretRef / broker — never Bindle plaintext.
 */

export const WORKOS_REQUIRED_ENV = Object.freeze([
	"VITE_WORKOS_CLIENT_ID",
	"VITE_WORKOS_REDIRECT_URI",
	"WORKOS_CLIENT_ID",
] as const);

export type WorkOsAuthKitPreflight = {
	readonly ready: boolean;
	readonly missing: readonly string[];
	readonly remediation: string;
};

/**
 * Presence-only preflight for WorkOS AuthKit. Values are never returned.
 */
export function describeWorkOsAuthKit(
	env: Record<string, string | undefined>,
): WorkOsAuthKitPreflight {
	const missing = WORKOS_REQUIRED_ENV.filter((name) => !env[name]?.trim());
	return Object.freeze({
		ready: missing.length === 0,
		missing,
		remediation:
			missing.length === 0
				? "WorkOS AuthKit env present (presence-only)"
				: `Missing WorkOS AuthKit env: ${missing.join(", ")}. ` +
					"Provide via Camp secretRef / b.external WorkOS connector — never Bindle config.",
	});
}

export class WorkOsCredentialsError extends Error {
	readonly missing: readonly string[];

	constructor(missing: readonly string[]) {
		super(
			`WorkOS AuthKit is credential-gated: missing ${missing.join(", ")}. ` +
				"Route Camp secretRef / external connector (never Bindle config).",
		);
		this.name = "WorkOsCredentialsError";
		this.missing = missing;
	}
}

/** Throw when AuthKit is required and env is incomplete. */
export function requireWorkOsAuthKit(
	env: Record<string, string | undefined>,
): void {
	const preflight = describeWorkOsAuthKit(env);
	if (!preflight.ready) {
		throw new WorkOsCredentialsError(preflight.missing);
	}
}
