/**
 * The registered adapter descriptor.
 *
 * ADR-0038 keeps a named `hobo:auth` adapter set; ADR-0161 adds Better Auth to
 * it as the default *self-hosted, full-featured* option, sitting between the
 * thin built-in issuer (passkey / magic link, for dev and air-gap) and the
 * hosted IdPs. Matching selects among registered adapters only, so a descriptor
 * is how this adapter becomes selectable at all.
 *
 * The `requiredPorts` list is the honest part. ADR-0161 decision 2 ships Better
 * Auth as a bundle *over existing ports* rather than a component owning private
 * infrastructure: it borrows the relational store, the brokered secret, and the
 * HTTP route mount. Declaring those three means a Camp that cannot satisfy one
 * of them refuses the adapter at plan time instead of failing at first login.
 */

import { BetterAuthRuntimeUnavailableError } from "./errors.js";
import {
	AUTH_ADAPTER_CONTRACT,
	BETTER_AUTH_ADAPTER_ID,
	BETTER_AUTH_CLAIMS_MAPPING_VERSION,
} from "./ids.js";

export const AUTH_ADAPTER_HOSTINGS = Object.freeze([
	"hosted",
	"self-hosted",
] as const);

export type AuthAdapterHosting = (typeof AUTH_ADAPTER_HOSTINGS)[number];

export interface AuthAdapterDescriptor {
	readonly contract: typeof AUTH_ADAPTER_CONTRACT;
	readonly id: string;
	readonly displayName: string;
	readonly hosting: AuthAdapterHosting;
	readonly requiredPorts: readonly string[];
	readonly claimsMappingVersion: string;
	readonly supportsOrganizations: boolean;
}

/**
 * Ports the bundle composes. Sorted, so the descriptor is byte-stable and two
 * readings of it hash identically.
 *
 * - `hobo:data/relational` — Better Auth's user, session, account, and
 *   organization tables live in the governed data plane, evolving through
 *   ADR-0160 gated migrations rather than adapter-private DDL.
 * - `hobo:http` — the route mount for `${basePath}/*`, on the declared
 *   `api()`/`web()` surface.
 * - `hobo:secrets` — brokered custody for the signing secret. The app holds a
 *   locator; it never holds the material (ADR-0113).
 */
export const BETTER_AUTH_REQUIRED_PORTS = Object.freeze([
	"hobo:data/relational",
	"hobo:http",
	"hobo:secrets",
] as const);

export const BETTER_AUTH_DESCRIPTOR: AuthAdapterDescriptor = Object.freeze({
	contract: AUTH_ADAPTER_CONTRACT,
	id: BETTER_AUTH_ADAPTER_ID,
	displayName: "Better Auth",
	hosting: "self-hosted",
	requiredPorts: BETTER_AUTH_REQUIRED_PORTS,
	claimsMappingVersion: BETTER_AUTH_CLAIMS_MAPPING_VERSION,
	supportsOrganizations: true,
});

/** The npm package the bundle needs in order to actually serve auth routes. */
export const BETTER_AUTH_RUNTIME_MODULE = "better-auth"; // public-contract: the npm specifier emitted bundles import at runtime

/**
 * Gate the declared-but-not-vendored runtime.
 *
 * This package does not depend on `better-auth` and does not run an auth
 * server; see the README's HONEST SCOPE section. A host that wants to execute
 * the bundle asks this first, passing whether the dependency resolved. Absent,
 * it refuses with remediation — it never degrades to the thin built-in issuer,
 * because a silent downgrade would change who can log in without saying so.
 *
 * Presence is supplied by the caller rather than probed here, so this stays a
 * pure function with no module resolution or filesystem access in a planning
 * path.
 */
export function assertBetterAuthRuntimeAvailable(options?: {
	readonly runtimePresent?: boolean;
}): void {
	if (options?.runtimePresent === true) return;
	throw new BetterAuthRuntimeUnavailableError(
		`the ${BETTER_AUTH_RUNTIME_MODULE} runtime is not present, so this bundle cannot serve auth routes`,
		`install ${BETTER_AUTH_RUNTIME_MODULE} in the deployed bundle and re-run; @hobo/adapter-better-auth ships the descriptor, config parse, and claims mapping only, and refuses rather than falling back to the built-in passkey/magic-link issuer`,
	);
}
