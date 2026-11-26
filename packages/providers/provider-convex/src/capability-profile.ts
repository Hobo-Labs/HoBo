/**
 * `data.convex/v1` — the capability implementation profile for Convex, as
 * DATA. This is deliberately not a second registry: it is a frozen descriptor
 * that whoever owns the profile graph (Matching, PortabilityReport, the
 * capability-profiles package) reads. This package only publishes the fact.
 *
 * The honesty rule this file encodes: Convex is a reactive *document* store
 * with a transactional function runtime. It refines `data.document/v1` and it
 * refines nothing else. Self-hosted Convex can be *backed by* Postgres or
 * MySQL (`POSTGRES_URL` / `MYSQL_URL`), and the default single-container
 * backend stores state in SQLite — neither fact makes Convex a relational
 * port. Storage engine is not capability surface.
 */

// public-contract: the profile record schema id consumers pin.
export const CAPABILITY_PROFILE_SCHEMA = "hobo.capability-profile/v1";

/**
 * A third-party fact with the URL it came from and the date a human/agent
 * actually read it (legal-hygiene rule: sourced-and-dated, never attested).
 */
export interface VerifiedSourceRef {
	readonly url: string;
	/** UTC `YYYY-MM-DD` the URL was read. */
	readonly checkedOn: string;
	readonly note: string;
}

export type ProfileMaturity = "experimental" | "preview" | "stable";

export interface CapabilityProfile {
	readonly schema: typeof CAPABILITY_PROFILE_SCHEMA;
	readonly id: string;
	/** The Bindle primitive this profile implements. */
	readonly primitive: string;
	/** Profiles this one is a strict specialization of (acyclic, no self). */
	readonly refines: readonly string[];
	/** Profiles a deployment of this one also surfaces. */
	readonly composes: readonly string[];
	readonly maturity: ProfileMaturity;
	readonly conformanceSuiteRef: string;
	readonly sourceRefs: readonly VerifiedSourceRef[];
}

/** A profile this one is explicitly NOT — recorded so nobody re-derives it. */
export interface ProfileNonRefinement {
	readonly profileId: string;
	readonly reason: string;
}

// public-contract: the Convex data profile id.
export const DATA_CONVEX_PROFILE_ID = "data.convex/v1";

// public-contract: the conformance suite a data.convex claim must clear.
// Defined here (not in conformance.ts) so the profile stays a leaf module.
// public-contract: stable conformance evidence reference for selection.
export const CONVEX_CONFORMANCE_SUITE_REF =
	"hobo.conformance.convex-hosting/v1";

export const DATA_CONVEX_CAPABILITY_PROFILE: CapabilityProfile = Object.freeze({
	schema: CAPABILITY_PROFILE_SCHEMA,
	id: DATA_CONVEX_PROFILE_ID,
	primitive: "data",
	refines: Object.freeze(["data.document/v1"]),
	composes: Object.freeze([
		"api.http/v1",
		"realtime.websocket/v1",
		"service.scheduled/v1",
		"bucket.file-storage/v1",
	]),
	maturity: "preview",
	conformanceSuiteRef: CONVEX_CONFORMANCE_SUITE_REF,
	sourceRefs: Object.freeze([
		Object.freeze({
			url: "https://docs.convex.dev/self-hosting",
			checkedOn: "2026-08-08",
			note: "self-hosted backend is the same code as the cloud service; FSL Apache 2.0",
		}),
		Object.freeze({
			url: "https://github.com/get-convex/convex-backend/tree/main/self-hosted",
			checkedOn: "2026-08-08",
			note: "backend on 127.0.0.1:3210, HTTP actions on 127.0.0.1:3211, SQLite state by default",
		}),
		Object.freeze({
			url: "https://docs.convex.dev/database/backup-restore",
			checkedOn: "2026-08-08",
			note: "backup carries table documents + optional file storage; not code, config, env vars, or pending scheduled functions",
		}),
	]),
} satisfies CapabilityProfile);

/**
 * Profiles `data.convex/v1` deliberately does NOT refine. Each entry exists
 * because the mistake is tempting, not because the profile is exotic.
 */
export const DATA_CONVEX_NON_REFINEMENTS: readonly ProfileNonRefinement[] =
	Object.freeze([
		Object.freeze({
			profileId: "data.postgres/v1",
			reason:
				"self-hosted Convex can persist to Postgres (POSTGRES_URL), but the app-facing surface is Convex documents and functions — no SQL dialect, no wire protocol, no user-visible relations",
		}),
		Object.freeze({
			profileId: "data.mysql/v1",
			reason:
				"same as Postgres: MYSQL_URL is an internal storage engine choice, not an exposed capability",
		}),
		Object.freeze({
			profileId: "data.sqlite/v1",
			reason:
				"the default single-container backend keeps state in SQLite, but consumers get no SQLite file, no SQL, and no @hobo/storage-sqlite EventStore semantics (ADR-0135)",
		}),
		Object.freeze({
			profileId: "data.relational/v1",
			reason:
				"Convex is a document store; requesting a relational paradigm is a recorded mismatch (see CONVEX_PARADIGM_MISMATCHES)",
		}),
		Object.freeze({
			profileId: "data.kv/v1",
			reason:
				"documents are schema-validated and index-queried, not opaque byte values under a key",
		}),
	]);

/** True when `profile` declares a refinement of `profileId`. */
export function profileRefines(
	profile: CapabilityProfile,
	profileId: string,
): boolean {
	return profile.refines.includes(profileId);
}

/** True when `profile` declares that it also surfaces `profileId`. */
export function profileComposes(
	profile: CapabilityProfile,
	profileId: string,
): boolean {
	return profile.composes.includes(profileId);
}

/**
 * Why `data.convex/v1` is not `profileId`, when that has been written down.
 * `undefined` means "not a recorded confusion", not "yes it refines it".
 */
export function explainNonRefinement(profileId: string): string | undefined {
	return DATA_CONVEX_NON_REFINEMENTS.find(
		(entry) => entry.profileId === profileId,
	)?.reason;
}
