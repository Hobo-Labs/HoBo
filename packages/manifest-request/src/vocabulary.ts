
export const BINDLE_RUNTIMES = [
	"wasm",
	"oci",
	"vm_iaas",
	"paas",
	"serverless_faas",
] as const;

export type BindleRuntime = (typeof BINDLE_RUNTIMES)[number];

export const REALIZATION_KINDS = ["native", "pack", "bridge"] as const;

export type RealizationKind = (typeof REALIZATION_KINDS)[number];

export const CONFORMANCE_RESULTS = ["pass", "fail", "unknown"] as const;

export type ConformanceResult = (typeof CONFORMANCE_RESULTS)[number];

export const PROVIDER_CLASSES = [
	"established",
	"verified-emerging",
	"experimental",
] as const;

export type ProviderClass = (typeof PROVIDER_CLASSES)[number];

export const CREATOR_AUTHORITIES_AFTER_CLAIM = [
	"absent",
	"reauthorization-required",
	"rotatable",
	"retained",
	"unknown",
] as const;

export type CreatorAuthorityAfterClaim =
	(typeof CREATOR_AUTHORITIES_AFTER_CLAIM)[number];

export const CONTINUITY_GRADES = [
	"preserved",
	"rebound",
	"migrated",
	"changed",
	"discarded",
	"not-applicable",
] as const;

export type ContinuityGrade = (typeof CONTINUITY_GRADES)[number];

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

export const CLAIM_ATOMICITIES = [
	"single-resource",
	"provider-bundled",
	"best-effort-saga",
] as const;

export type ClaimAtomicity = (typeof CLAIM_ATOMICITIES)[number];
