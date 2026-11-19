/**
 * The versioned claims to principal mapping.
 *
 * ADR-0073 decision 2 makes this an explicit, versioned, conformance-tested part
 * of every IdP adapter, and the reason is a swap: when a Yard's issuer changes
 * from Better Auth to WorkOS or Entra, group and role claim shapes differ, and
 * an implicit mapping would silently drop or remap the claims that populate a
 * principal's roles. So this module states its accepted claim vocabulary as
 * data, maps it totally, refuses everything else, and stamps the result with the
 * mapping version so an audit can tell which rules produced a principal.
 *
 * The mapping is a pure function of its input: no clock, no randomness, no I/O.
 * Roles are deduped and sorted, so two callers passing the same claims in a
 * different order get byte-identical principals.
 *
 * Verification is emphatically *not* here. Signature checking, issuer trust, and
 * expiry live on the existing JWKS/OIDC path (ADR-0038); this function maps
 * claims that have *already* been verified. It parses `exp`/`nbf`/`iat` only far
 * enough to prove they are well-formed, and never compares them to a clock.
 */

import {
	BetterAuthClaimsError,
	type BetterAuthClaimsErrorCode,
} from "./errors.js";
import { BETTER_AUTH_CLAIMS_MAPPING_VERSION } from "./ids.js";
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "./json.js";

/**
 * A principal derived from Better Auth claims.
 *
 * The first five fields are the platform-wide mapped-principal shape. The
 * trailing `claimsMappingVersion` is this adapter's version stamp: it makes the
 * ADR-0073 obligation visible on the record itself rather than only in the
 * adapter descriptor, so a stored or audited principal names the rules that
 * produced it.
 */
export interface MappedPrincipal {
	readonly subject: string;
	readonly issuer: string;
	readonly email?: string;
	readonly organizationId?: string;
	readonly roles: readonly string[];
	readonly claimsMappingVersion: typeof BETTER_AUTH_CLAIMS_MAPPING_VERSION;
}

/**
 * The complete accepted claim vocabulary. A claim outside this set is refused,
 * never ignored — an ignored claim is indistinguishable from an unsupported one
 * and that ambiguity is how role claims go missing across an issuer swap.
 */
export const BETTER_AUTH_ACCEPTED_CLAIM_KEYS = Object.freeze([
	"activeOrganizationId",
	"aud",
	"email",
	"emailVerified",
	"exp",
	"iat",
	"iss",
	"jti",
	"name",
	"nbf",
	"role",
	"roles",
	"sub",
] as const);

export type BetterAuthClaimKey =
	(typeof BETTER_AUTH_ACCEPTED_CLAIM_KEYS)[number];

/** Claims accepted for well-formedness but not projected onto the principal. */
export const BETTER_AUTH_UNMAPPED_CLAIM_KEYS = Object.freeze([
	"aud",
	"emailVerified",
	"exp",
	"iat",
	"jti",
	"name",
	"nbf",
] as const);

const SUBJECT = /^[\w.:@~-]{1,256}$/u;
const ISSUER = /^https?:\/\/[^\s@/]+(?:\/[^\s]*)?$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const ORGANIZATION_ID = /^[\w.:-]{1,128}$/u;
const ROLE = /^[a-z][a-z0-9._:-]{0,63}$/u;
const JTI = /^[\w.:-]{1,256}$/u;

function refuse(
	code: BetterAuthClaimsErrorCode,
	message: string,
	remediation: string,
): never {
	throw new BetterAuthClaimsError(code, message, remediation);
}

function parseRoleList<TRole, TRoles>(
	role: TRole,
	roles: TRoles,
): readonly string[] {
	const collected = new Set<string>();

	if (role !== undefined) {
		if (!isJsonString(role) || !ROLE.test(role)) {
			refuse(
				"BETTER_AUTH_CLAIMS_ROLE_INVALID",
				"role must be a single lowercase role slug",
				'issue role as one slug (e.g. "admin"); a delimited list is not split — use the roles array claim instead',
			);
		}
		collected.add(role);
	}

	if (roles !== undefined) {
		if (!Array.isArray(roles)) {
			refuse(
				"BETTER_AUTH_CLAIMS_ROLE_INVALID",
				"roles must be an array of role slugs",
				'issue roles as a JSON array (e.g. ["admin", "member"]); a comma-delimited string is refused rather than split, because splitting guesses the delimiter',
			);
		}
		for (const entry of roles) {
			if (!isJsonString(entry) || !ROLE.test(entry)) {
				refuse(
					"BETTER_AUTH_CLAIMS_ROLE_INVALID",
					"each roles entry must be a lowercase role slug",
					'issue every roles entry as a lowercase slug, e.g. ["admin", "member"]',
				);
			}
			collected.add(entry);
		}
	}

	return Object.freeze([...collected].sort());
}

function assertRegisteredClaimContracts(claims: JsonObject): void {
	for (const key of ["exp", "iat", "nbf"] as const) {
		const value = claims[key];
		if (value === undefined) continue;
		if (!isJsonNumber(value) || !Number.isFinite(value)) {
			refuse(
				"BETTER_AUTH_CLAIMS_REGISTERED_CLAIM_INVALID",
				`${key} must be a numeric seconds-since-epoch claim`,
				`issue ${key} as a JSON number; this mapping checks its shape only and never compares it to a clock`,
			);
		}
	}

	const jti = claims.jti;
	if (jti !== undefined && (!isJsonString(jti) || !JTI.test(jti))) {
		refuse(
			"BETTER_AUTH_CLAIMS_REGISTERED_CLAIM_INVALID",
			"jti must be a token identifier string",
			"issue jti as a short opaque identifier string",
		);
	}

	const aud = claims.aud;
	if (aud !== undefined) {
		const entries = Array.isArray(aud) ? aud : [aud];
		for (const entry of entries) {
			if (!isJsonString(entry) || entry.length === 0) {
				refuse(
					"BETTER_AUTH_CLAIMS_REGISTERED_CLAIM_INVALID",
					"aud must be a non-empty string or an array of non-empty strings",
					"issue aud as the audience string, or an array of them",
				);
			}
		}
	}

	const emailVerified = claims.emailVerified;
	if (emailVerified !== undefined && !isJsonBoolean(emailVerified)) {
		refuse(
			"BETTER_AUTH_CLAIMS_REGISTERED_CLAIM_INVALID",
			"emailVerified must be a boolean",
			"issue emailVerified as true or false; this mapping records no verification state on the principal",
		);
	}

	const name = claims.name;
	if (name !== undefined && (!isJsonString(name) || name.length === 0)) {
		refuse(
			"BETTER_AUTH_CLAIMS_REGISTERED_CLAIM_INVALID",
			"name must be a non-empty string",
			"omit name rather than issuing it empty; display names are not part of the principal",
		);
	}
}

/**
 * Map verified Better Auth claims onto a {@link MappedPrincipal}.
 *
 * Total over the accepted vocabulary in {@link BETTER_AUTH_ACCEPTED_CLAIM_KEYS}
 * and refusing everything else with a typed `code`.
 *
 * @throws {BetterAuthClaimsError}
 */
export function mapClaimsToPrincipal<T>(claims: T): MappedPrincipal {
	if (!isJsonObject(claims) || claims === null || Array.isArray(claims)) {
		refuse(
			"BETTER_AUTH_CLAIMS_SHAPE_INVALID",
			"claims must be a plain object",
			"pass the decoded claim set object, not a raw token string",
		);
	}
	// SAFETY: assertion to `ms as JsonObject; ` is required at this boundary.
	const raw = claims as JsonObject;

	const accepted = new Set<string>(BETTER_AUTH_ACCEPTED_CLAIM_KEYS);
	for (const key of Object.keys(raw).sort()) {
		if (accepted.has(key)) continue;
		refuse(
			"BETTER_AUTH_CLAIMS_UNKNOWN_FIELD",
			`claim ${JSON.stringify(key)} is outside this adapter's accepted claim vocabulary`,
			`map ${key} explicitly in a new claims-mapping version rather than relying on it being coerced; accepted claims are ${BETTER_AUTH_ACCEPTED_CLAIM_KEYS.join(", ")}`,
		);
	}

	const sub = raw.sub;
	if (!isJsonString(sub) || !SUBJECT.test(sub)) {
		refuse(
			"BETTER_AUTH_CLAIMS_SUBJECT_INVALID",
			"sub must be a non-empty subject identifier",
			"issue sub as the stable user identifier; a principal without a subject cannot be authorized",
		);
	}

	const iss = raw.iss;
	if (!isJsonString(iss) || !ISSUER.test(iss)) {
		refuse(
			"BETTER_AUTH_CLAIMS_ISSUER_INVALID",
			"iss must be an absolute http(s) issuer URL without userinfo",
			'issue iss as the Better Auth deployment base URL, e.g. "https://app.example.com"',
		);
	}

	const email = raw.email;
	if (email !== undefined && (!isJsonString(email) || !EMAIL.test(email))) {
		refuse(
			"BETTER_AUTH_CLAIMS_EMAIL_INVALID",
			"email must be an address-shaped string when present",
			"omit the email claim rather than issuing an unparsable value",
		);
	}

	const organizationId = raw.activeOrganizationId;
	if (
		organizationId !== undefined &&
		(!isJsonString(organizationId) || !ORGANIZATION_ID.test(organizationId))
	) {
		refuse(
			"BETTER_AUTH_CLAIMS_ORGANIZATION_INVALID",
			"activeOrganizationId must be an identifier string when present",
			"omit activeOrganizationId for a single-tenant deployment; tenancy is never inferred from another claim",
		);
	}

	assertRegisteredClaimContracts(raw);

	const roles = parseRoleList(raw.role, raw.roles);

	// exactOptionalPropertyTypes: optional fields are added, never set undefined.
	return Object.freeze({
		subject: sub,
		issuer: iss,
		...(email !== undefined ? { email } : undefined),
		...(organizationId !== undefined ? { organizationId } : undefined),
		roles,
		claimsMappingVersion: BETTER_AUTH_CLAIMS_MAPPING_VERSION,
	});
}
