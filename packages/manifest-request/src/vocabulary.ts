/**
 * The closed vocabularies a selection candidate is written in.
 *
 * These are closed on purpose. A profile id is open — a provider registers a
 * new one without editing a central switch — but "how much authority the
 * creator keeps after a claim" is a decision the selector gates on, and an
 * unrecognized answer to that question must fail closed rather than rank
 * somewhere plausible.
 *
 * `BINDLE_RUNTIMES` and `REALIZATION_KINDS` are restated here rather than
 * imported. `@hobo/capability-profiles` owns the originals
 * (`packages/capability-profiles/src/ids.ts`), and a manifest package may not
 * depend on another package's implementation; `@hobo/core` does not carry
 * them. `test/schema-parity.test.ts` reads that file and fails if either list
 * drifts, so the duplication is checked rather than trusted.
 */

/** Runtime realization models a product can be reached from. */
export const BINDLE_RUNTIMES = [
	"wasm",
	"oci",
	"vm_iaas",
	"paas",
	"serverless_faas",
] as const;

export type BindleRuntime = (typeof BINDLE_RUNTIMES)[number];

/** How a product satisfies a profile. Not a claimability axis. */
export const REALIZATION_KINDS = ["native", "pack", "bridge"] as const;

export type RealizationKind = (typeof REALIZATION_KINDS)[number];

/** Conformance outcome for one implementation claim. `unknown` fails closed. */
export const CONFORMANCE_RESULTS = ["pass", "fail", "unknown"] as const;

export type ConformanceResult = (typeof CONFORMANCE_RESULTS)[number];

/** Provider maturity, ordered most to least established. */
export const PROVIDER_CLASSES = [
	"established",
	"verified-emerging",
	"experimental",
] as const;

export type ProviderClass = (typeof PROVIDER_CLASSES)[number];

/** What the creating party still holds once the resource has been claimed. */
export const CREATOR_AUTHORITIES_AFTER_CLAIM = [
	"absent",
	"reauthorization-required",
	"rotatable",
	"retained",
	"unknown",
] as const;

export type CreatorAuthorityAfterClaim =
	(typeof CREATOR_AUTHORITIES_AFTER_CLAIM)[number];

/** What survives a claim, per continuity axis. */
export const CONTINUITY_GRADES = [
	"preserved",
	"rebound",
	"migrated",
	"changed",
	"discarded",
	"not-applicable",
] as const;

export type ContinuityGrade = (typeof CONTINUITY_GRADES)[number];

/**
 * Credential continuity has its own vocabulary.
 *
 * "rotated" and "revoked" are better outcomes than "retained" here, which is
 * the reverse of how the other axes read, so the two vocabularies are not
 * interchangeable even though they overlap.
 */
export const CREDENTIAL_CONTINUITY_GRADES = [
	"revoked",
	"rotated",
	"reauthorized",
	"retained",
	"unknown",
	"not-applicable",
] as const;

export type CredentialContinuity =
	(typeof CREDENTIAL_CONTINUITY_GRADES)[number];

/** How many resources one claim action actually transfers. */
export const CLAIM_ATOMICITIES = [
	"single-resource",
	"provider-bundled",
	"best-effort-saga",
] as const;

export type ClaimAtomicity = (typeof CLAIM_ATOMICITIES)[number];
