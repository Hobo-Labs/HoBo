
// public-contract: the profile record schema id consumers pin.
export const CAPABILITY_PROFILE_SCHEMA = "hobo.capability-profile/v1";

export interface VerifiedSourceRef {
	readonly url: string;
	readonly checkedOn: string;
	readonly note: string;
}

export type ProfileMaturity = "experimental" | "preview" | "stable";

export interface CapabilityProfile {
	readonly schema: typeof CAPABILITY_PROFILE_SCHEMA;
	readonly id: string;
	readonly primitive: string;
	readonly refines: readonly string[];
	readonly composes: readonly string[];
	readonly maturity: ProfileMaturity;
	readonly conformanceSuiteRef: string;
	readonly sourceRefs: readonly VerifiedSourceRef[];
}

export interface ProfileNonRefinement {
	readonly profileId: string;
	readonly reason: string;
}

// public-contract: the Convex data profile id.
export const DATA_CONVEX_PROFILE_ID = "data.convex/v1";

// public-contract: the conformance suite a data.convex claim must clear.
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

export function profileRefines(
	profile: CapabilityProfile,
	profileId: string,
): boolean {
	return profile.refines.includes(profileId);
}

export function profileComposes(
	profile: CapabilityProfile,
	profileId: string,
): boolean {
	return profile.composes.includes(profileId);
}

export function explainNonRefinement(profileId: string): string | undefined {
	return DATA_CONVEX_NON_REFINEMENTS.find(
		(entry) => entry.profileId === profileId,
	)?.reason;
}
