/**
 * The stable identifiers this adapter is known by.
 *
 * They live in their own module because the descriptor, the config parser, and
 * the claims mapping all stamp themselves with one of them, and a shared
 * constant is the only way those three stay in agreement across a version bump.
 *
 * `BETTER_AUTH_CLAIMS_MAPPING_VERSION` is load-bearing: ADR-0073 requires the
 * claims to roles/tenancy mapping to be explicit, versioned, and conformance
 * tested, so that swapping an issuer on a live Yard cannot silently drop or
 * remap the claims that populate a principal's roles. Any change to the mapping
 * rules is a change to this string.
 */

export const AUTH_ADAPTER_CONTRACT = "hobo.auth-adapter/v1"; // public-contract: contract id an auth adapter declares to be recognised
export const BETTER_AUTH_ADAPTER_ID = "better-auth"; // public-contract: adapter id persisted in manifests and plan records
export const BETTER_AUTH_CLAIMS_MAPPING_VERSION = "better-auth-claims/v1"; // public-contract: consumers pin on this claims-mapping version
