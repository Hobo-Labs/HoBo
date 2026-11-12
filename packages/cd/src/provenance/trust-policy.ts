// The provenance trust policy arrives as an opaque JsonObject (frozen
// `createProvenanceVerifier` signature) and is parsed once, at construction,
// into this typed form. A malformed policy throws there — composition fails
// loudly — while an empty policy is valid and simply trusts nothing.
import type { SignatureVerifier } from "@hobo/registry";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../artifacts/json.js";

// public-contract: the literal that selects the Sigstore public-good trusted
// root shipped with sigstore@5.0.1 (@sigstore/tuf seeds) instead of an inline one.
export const SIGSTORE_PUBLIC_GOOD_SEED = "public-good-seed";

export type SigstorePolicy = Readonly<{
	trustedRoot: JsonObject | typeof SIGSTORE_PUBLIC_GOOD_SEED;
	issuers: readonly string[];
	ctlogThreshold: number;
	tlogThreshold: number;
}>;

export type HoboJwtPolicy = Omit<SignatureVerifier, "now">;

export type TrustPolicy = Readonly<{
	builderIds: readonly string[];
	signerIdentities: readonly string[];
	sigstore?: SigstorePolicy;
	hoboJwt?: HoboJwtPolicy;
}>;

export class ProvenanceTrustPolicyError extends Error {
	readonly code = "provenance-trust-policy-invalid";
	readonly remediation =
		'Fix the CD trust policy: builderIds/signerIdentities are string arrays; sigstore needs trustedRoot (object or "public-good-seed") and issuers; hoboJwt needs jwks.keys, issuer and audience.';
	constructor(path: string, expected: string) {
		super(`provenance-trust-policy-invalid: ${path} must be ${expected}`);
		this.name = "ProvenanceTrustPolicyError";
	}
}

function strings(
	value: JsonValue | undefined,
	path: string,
): readonly string[] {
	if (value === undefined) return [];
	if (
		!isJsonArray(value) ||
		!value.every((item) => isJsonString(item) && item.trim() !== "")
	)
		throw new ProvenanceTrustPolicyError(path, "an array of non-empty strings");
	return value.filter(isJsonString);
}

function threshold(value: JsonValue | undefined, path: string): number {
	if (value === undefined) return 1;
	// Thresholds can be raised, never lowered below one: a zero threshold would
	// accept a bundle with no transparency evidence.
	if (
		!isJsonNumber(value) ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > 16
	)
		throw new ProvenanceTrustPolicyError(path, "an integer from 1 to 16");
	return value;
}

function nonEmpty(value: JsonValue | undefined, path: string): string {
	if (!isJsonString(value) || value.trim() === "")
		throw new ProvenanceTrustPolicyError(path, "a non-empty string");
	return value;
}

export function parseTrustPolicy(raw: JsonObject): TrustPolicy {
	const known = new Set([
		"builderIds",
		"signerIdentities",
		"sigstore",
		"hoboJwt",
	]);
	for (const key of Object.keys(raw))
		if (!known.has(key))
			throw new ProvenanceTrustPolicyError(
				key,
				"one of builderIds, signerIdentities, sigstore, hoboJwt",
			);
	const policy: {
		builderIds: readonly string[];
		signerIdentities: readonly string[];
		sigstore?: SigstorePolicy;
		hoboJwt?: HoboJwtPolicy;
	} = {
		builderIds: strings(raw.builderIds, "builderIds"),
		signerIdentities: strings(raw.signerIdentities, "signerIdentities"),
	};
	const sigstore = raw.sigstore;
	if (sigstore !== undefined) {
		if (!isJsonObject(sigstore))
			throw new ProvenanceTrustPolicyError("sigstore", "an object");
		const root = sigstore.trustedRoot;
		if (!(isJsonObject(root) || root === SIGSTORE_PUBLIC_GOOD_SEED))
			throw new ProvenanceTrustPolicyError(
				"sigstore.trustedRoot",
				`a Sigstore TrustedRoot object or "${SIGSTORE_PUBLIC_GOOD_SEED}"`,
			);
		const issuers = strings(sigstore.issuers, "sigstore.issuers");
		if (issuers.length === 0)
			throw new ProvenanceTrustPolicyError(
				"sigstore.issuers",
				"a non-empty array of OIDC issuer URLs",
			);
		policy.sigstore = {
			trustedRoot: root,
			issuers,
			ctlogThreshold: threshold(
				sigstore.ctlogThreshold,
				"sigstore.ctlogThreshold",
			),
			tlogThreshold: threshold(
				sigstore.tlogThreshold,
				"sigstore.tlogThreshold",
			),
		};
	}
	const jwt = raw.hoboJwt;
	if (jwt !== undefined) {
		if (!isJsonObject(jwt))
			throw new ProvenanceTrustPolicyError("hoboJwt", "an object");
		const jwks = jwt.jwks;
		const keys = isJsonObject(jwks) ? jwks.keys : undefined;
		if (!isJsonArray(keys) || keys.length === 0 || !keys.every(isJsonObject))
			throw new ProvenanceTrustPolicyError(
				"hoboJwt.jwks.keys",
				"a non-empty array of JWKs",
			);
		policy.hoboJwt = {
			jwks: { keys: keys.filter(isJsonObject) },
			issuer: nonEmpty(jwt.issuer, "hoboJwt.issuer"),
			audience: nonEmpty(jwt.audience, "hoboJwt.audience"),
		};
	}
	return policy;
}
