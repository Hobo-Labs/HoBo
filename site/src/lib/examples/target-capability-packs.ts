/**
 * Matching-honest target packs for the Examples console.
 *
 * Native ports mirror each @hobo/provider-* EQUIVALENCE_CLASSES (HOBO-93
 * default Resource Definitions). Prefer-degrades for missing ports follow
 * Matching remediation language (prefer → lower / in-memory) — not a new
 * policy DSL. Keep in sync when provider equivalence changes.
 */

import { supportsAnonymousTemporaryDeploy as vercelSupportsAnonymousTemporaryDeploy } from "@hobo/provider-vercel/temporary-capability";
import type { ResourceClass } from "./policy-planner.js";

export type TargetCapabilityPack = {
	readonly label: string;
	readonly resourceClass: ResourceClass;
	readonly canHostNow: boolean;
	readonly unavailableReason?: string;
	/** Ports the provider advertises natively (Matching catalog truth). */
	readonly native: readonly string[];
	/**
	 * Prefer-style degrades when a Bindle port is absent from `native`
	 * (Matching prefer + partial / missing-port remediation).
	 */
	readonly preferDegrades: Readonly<Record<string, string>>;
	readonly environment: string;
	readonly supportsAnonymousTemporaryDeploy: boolean;
};

/** Bindle ports the Examples apps commonly declare. */
export const EXAMPLES_BINDLE_PORTS = Object.freeze([
	"http",
	"compute",
	"kv",
	"queue",
	"container",
	"objectStore",
	"database",
] as const);

/**
 * Map a missing Bindle port to a Matching-style prefer degrade label.
 * Queue/kv without a provider surface → in-memory binding (prefer, not require).
 */
export function preferDegradeForMissingPort(port: string): string | undefined {
	switch (port) {
		case "kv":
			return "memory";
		case "queue":
			return "memory";
		case "container":
			return "not native — prefer capsule/worker compute";
		case "database":
			return "not native — select provider with database port";
		case "objectStore":
			return "not native — select provider with objectStore port";
		default:
			return undefined;
	}
}

export function preferDegradesFromNative(
	native: readonly string[],
): Readonly<Record<string, string>> {
	const nativeSet = new Set(native);
	// http is served by compute for Matching purposes
	if (nativeSet.has("compute")) nativeSet.add("http");
	const lowers: Record<string, string> = {};
	for (const port of EXAMPLES_BINDLE_PORTS) {
		if (nativeSet.has(port)) continue;
		const degrade = preferDegradeForMissingPort(port);
		if (degrade) lowers[port] = degrade;
	}
	return Object.freeze(lowers);
}

export function packFromNative(input: {
	readonly label: string;
	readonly resourceClass: ResourceClass;
	readonly native: readonly string[];
	readonly environment: string;
	readonly supportsAnonymousTemporaryDeploy: boolean;
	readonly canHostNow?: boolean;
	readonly unavailableReason?: string;
}): TargetCapabilityPack {
	const canHostNow = input.canHostNow ?? input.supportsAnonymousTemporaryDeploy;
	return {
		label: input.label,
		resourceClass: input.resourceClass,
		canHostNow,
		...(input.unavailableReason
			? { unavailableReason: input.unavailableReason }
			: !canHostNow
				? {
						unavailableReason:
							"No password-free temporary/agent provision API — fail closed (no permanent tokens)",
					}
				: {}),
		native: Object.freeze([...input.native]),
		preferDegrades: preferDegradesFromNative(input.native),
		environment: input.environment,
		supportsAnonymousTemporaryDeploy: input.supportsAnonymousTemporaryDeploy,
	};
}

/**
 * OOB Examples yard packs — native ports synced to provider packages.
 * Temporary/agent only for canHostNow.
 */
export const TARGET_CAPABILITY_PACKS = {
	"browser-wasm": packFromNative({
		label: "Browser WASM",
		resourceClass: "local",
		native: ["http", "compute", "kv", "queue"],
		environment: "browser Component Model guest host (temporary local station)",
		supportsAnonymousTemporaryDeploy: true,
	}),
	webernetes: packFromNative({
		label: "Webernetes (local)",
		resourceClass: "local",
		native: ["http", "compute", "kv", "queue", "container"],
		environment: "local Docker bridge temporary Environment Station",
		supportsAnonymousTemporaryDeploy: true,
	}),
	cloudflare: packFromNative({
		label: "Cloudflare",
		resourceClass: "anonymous-remote",
		// @hobo/provider-cloudflare equivalence: compute, kv, objectStore
		native: ["http", "compute", "kv", "objectStore"],
		environment: "Temporary Accounts Workers (no permanent token)",
		supportsAnonymousTemporaryDeploy: true,
	}),
	netlify: packFromNative({
		label: "Netlify",
		resourceClass: "anonymous-remote",
		native: ["http", "compute"],
		environment:
			"Netlify anonymous deploy (netlify deploy --allow-anonymous / Drop); claim within ~1h — never NETLIFY_AUTH_TOKEN",
		supportsAnonymousTemporaryDeploy: true,
	}),
	vercel: packFromNative({
		label: "Vercel",
		resourceClass: "anonymous-remote",
		// draft/promoted vercel: compute, objectStore, database; kv via edge-config/upstash
		native: ["http", "compute", "objectStore", "database", "kv"],
		environment:
			"Vercel requires a verified account-backed deployment; browser Drop is not an anonymous SDK API",
		supportsAnonymousTemporaryDeploy: vercelSupportsAnonymousTemporaryDeploy,
		canHostNow: false,
		unavailableReason:
			"Vercel has no documented anonymous temporary deployment API in this adapter. Choose a provider with an available anonymous API.",
	}),
	lakebed: packFromNative({
		label: "Lakebed (local)",
		resourceClass: "local",
		// @hobo/provider-lakebed equivalence
		native: ["http", "compute", "kv", "objectStore", "database"],
		environment:
			"Lakebed anonymous deploy (zero account) → claim later; no LAKEBED_TOKEN",
		supportsAnonymousTemporaryDeploy: true,
	}),
} as const satisfies Readonly<Record<string, TargetCapabilityPack>>;

/** @deprecated Use preferDegrades — kept for call sites still naming lowers. */
export function lowersAlias(
	pack: TargetCapabilityPack,
): Readonly<Record<string, string>> {
	return pack.preferDegrades;
}
