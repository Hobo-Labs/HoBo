/**
 * No-silent-widening.
 *
 * Every axis here is a place where a recipe can hand back something weaker
 * than what was asked for while still "working". A widening is never an error
 * by itself — it is a fact that must be *permitted by policy* and *disclosed
 * in the offer*. Silence is the failure mode this module exists to prevent.
 */
import type {
	CapabilityProfileRegistry,
	CapabilityRequirement,
	ProfileImplementation,
	RejectionCode,
} from "@hobo/capability-profiles";

import type { RecipeSemantics } from "./recipe.js";

export const WIDENING_KINDS = [
	"bootstrap.public-anonymous-to-sponsored",
	"claim.provider-native-to-sponsor-migration",
	"claim.single-to-multiple",
	"credential.secret-ref-to-plaintext",
	"persistence.persistent-to-ephemeral",
	"profile.postgres-to-generic-relational",
	"profile.weakened",
	"realization.native-to-pack",
	"realization.pack-to-bridge",
	"realtime.websocket-to-polling",
] as const;

export type WideningKind = (typeof WIDENING_KINDS)[number];

export type WideningNotice = {
	readonly kind: WideningKind;
	readonly detail: string;
	readonly placementId?: string;
	/** The rejection this widening becomes when policy does not permit it. */
	readonly rejectionCode: RejectionCode;
};

export function isWideningKind(value: string): value is WideningKind {
	// SAFETY: assertion to `DENING_KINDS as readonly string[]).` is required at this boundary.
	return (WIDENING_KINDS as readonly string[]).includes(value);
}

/** Canonical order so two equal sets of notices serialize identically. */
export function sortWidenings(
	notices: readonly WideningNotice[],
): readonly WideningNotice[] {
	return [...notices].sort(
		(a, b) =>
			a.kind.localeCompare(b.kind) ||
			(a.placementId ?? "").localeCompare(b.placementId ?? "") ||
			a.detail.localeCompare(b.detail),
	);
}

const REALIZATION_LEVEL = {
	native: 0,
	pack: 1,
	bridge: 2,
} as const;

/**
 * Compare the semantics a caller asked for against the semantics a recipe
 * delivers. Each axis is independent; a downgrade on any of them is a notice.
 */
export function detectSemanticWidenings(
	requested: RecipeSemantics,
	delivered: RecipeSemantics,
): readonly WideningNotice[] {
	const notices: WideningNotice[] = [];

	if (delivered.claimCount > requested.claimCount) {
		notices.push({
			kind: "claim.single-to-multiple",
			detail: `requested ${requested.claimCount} claim(s) but the recipe requires ${delivered.claimCount}`,
			rejectionCode: "CLAIM_MODE_INSUFFICIENT",
		});
	}
	if (
		requested.claimKind === "provider-native" &&
		delivered.claimKind === "sponsor-migration"
	) {
		notices.push({
			kind: "claim.provider-native-to-sponsor-migration",
			detail:
				"a provider-native claim was requested but ownership transfers through a sponsor-owned account first",
			rejectionCode: "BOOTSTRAP_POLICY_DENIED",
		});
	}
	if (
		requested.persistence === "persistent" &&
		delivered.persistence === "ephemeral"
	) {
		notices.push({
			kind: "persistence.persistent-to-ephemeral",
			detail:
				"persistent storage was requested but the recipe delivers ephemeral state",
			rejectionCode: "PERSISTENCE_REQUIRED",
		});
	}
	if (
		requested.realtime === "websocket" &&
		delivered.realtime !== "websocket"
	) {
		notices.push({
			kind: "realtime.websocket-to-polling",
			detail: `WebSocket realtime was requested but the recipe delivers ${delivered.realtime}`,
			rejectionCode: "WEBSOCKET_REQUIRED",
		});
	}
	if (
		requested.credentialCustody === "secret-ref" &&
		delivered.credentialCustody === "plaintext"
	) {
		notices.push({
			kind: "credential.secret-ref-to-plaintext",
			detail:
				"secret-ref custody was requested but the recipe hands credentials to the workload in plaintext",
			rejectionCode: "SECRET_CUSTODY_UNAVAILABLE",
		});
	}
	if (
		requested.bootstrap === "public-anonymous" &&
		delivered.bootstrap === "sponsored"
	) {
		notices.push({
			kind: "bootstrap.public-anonymous-to-sponsored",
			detail:
				"a public-anonymous bootstrap was requested but the recipe spends sponsor budget",
			rejectionCode: "BOOTSTRAP_POLICY_DENIED",
		});
	}

	return sortWidenings(notices);
}

/**
 * A placement that promises an ancestor of the required profile satisfies the
 * *shape* but not the *semantics* — `data.relational/v1` where
 * `data.postgres/v1` was asked for is the canonical example.
 */
export function detectProfileWidening(args: {
	readonly requirement: CapabilityRequirement;
	readonly satisfiesProfileId: string;
	readonly registry: CapabilityProfileRegistry;
	readonly placementId: string;
}): readonly WideningNotice[] {
	const notices: WideningNotice[] = [];
	for (const constraint of args.requirement.requiredProfiles) {
		if (constraint.profileId === args.satisfiesProfileId) continue;
		// The promise still covers the ask when the promised profile refines it.
		if (args.registry.satisfies(args.satisfiesProfileId, constraint.profileId))
			continue;
		// The ask refines the promise: the recipe is offering the weaker parent.
		if (!args.registry.satisfies(constraint.profileId, args.satisfiesProfileId))
			continue;
		const postgresToRelational =
			constraint.profileId === "data.postgres/v1" &&
			args.satisfiesProfileId === "data.relational/v1";
		notices.push({
			kind: postgresToRelational
				? "profile.postgres-to-generic-relational"
				: "profile.weakened",
			detail: `${constraint.profileId} was required but the placement only promises ${args.satisfiesProfileId}`,
			placementId: args.placementId,
			rejectionCode: "PROFILE_INCOMPATIBLE",
		});
	}
	return sortWidenings(notices);
}

/**
 * The realization the product actually uses versus the strictest one the
 * requirement allows. `native` → `pack` → `bridge` each add a layer between
 * the workload and the thing it thinks it is talking to.
 */
export function detectRealizationWidening(args: {
	readonly requirement: CapabilityRequirement;
	readonly implementation: ProfileImplementation;
	readonly placementId: string;
}): readonly WideningNotice[] {
	const allowed = args.requirement.realization;
	const askedLevel = allowed.native
		? REALIZATION_LEVEL.native
		: allowed.pack
			? REALIZATION_LEVEL.pack
			: REALIZATION_LEVEL.bridge;
	const actualLevel = REALIZATION_LEVEL[args.implementation.realization];
	const notices: WideningNotice[] = [];
	if (
		actualLevel > REALIZATION_LEVEL.native &&
		askedLevel <= REALIZATION_LEVEL.native
	) {
		notices.push({
			kind: "realization.native-to-pack",
			detail: `${args.implementation.profileId} is satisfied by a ${args.implementation.realization} realization where a native one was allowed`,
			placementId: args.placementId,
			rejectionCode: "REALIZATION_DENIED",
		});
	}
	if (
		actualLevel > REALIZATION_LEVEL.pack &&
		askedLevel <= REALIZATION_LEVEL.pack
	) {
		notices.push({
			kind: "realization.pack-to-bridge",
			detail: `${args.implementation.profileId} is satisfied through a bridge rather than a pack`,
			placementId: args.placementId,
			rejectionCode: "REALIZATION_DENIED",
		});
	}
	return sortWidenings(notices);
}
