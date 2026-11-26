/**
 * Backend ranking for hobo:feature-flag evaluation engines (ADR-0027 ladder pattern).
 * Application code never selects or imports external providers.
 */
// public-contract: ranked feature-flag backends (local first).
export const FEATURE_FLAG_BACKEND_RANKS = Object.freeze([
	"local-builtin",
	"camp-managed",
	"ofrep-internal",
	"external",
] as const);

export type FeatureFlagBackendRank =
	(typeof FEATURE_FLAG_BACKEND_RANKS)[number];

export type RankedBackend = Readonly<{
	id: FeatureFlagBackendRank;
	available: boolean;
	/** Mediated residual only — never exposed as app SDK. */
	mediated: boolean;
}>;

/**
 * Select the highest-ranked available backend. Default: local-builtin always wins offline.
 */
export function selectFeatureFlagBackend(
	candidates: readonly RankedBackend[] = [
		Object.freeze({
			id: "local-builtin" as const,
			available: true,
			mediated: false,
		}),
	],
): FeatureFlagBackendRank {
	for (const rank of FEATURE_FLAG_BACKEND_RANKS) {
		const hit = candidates.find((c) => c.id === rank && c.available);
		if (hit) return hit.id;
	}
	return "local-builtin";
}
