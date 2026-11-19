/**
 * The executable claims-mapping conformance case list.
 *
 * ADR-0073 requires each IdP adapter's claims to roles/tenancy mapping to be
 * conformance tested, and the reason is swap safety: the suite is the artifact
 * that proves a replacement issuer produces the same principals for the same
 * claims. Prose cannot prove that, so the cases live here as data — importable,
 * runnable by a host, and re-usable as the baseline when this adapter's mapping
 * version changes.
 *
 * The list is deliberately small and deliberately two-sided. Mapped cases cover
 * every accepted claim key at least once, which is what "total over the shapes
 * it accepts" means concretely; refused cases cover every claims error code,
 * which is what "refuses the rest" means concretely. Two tests assert exactly
 * those two coverage properties, so adding a claim key or an error code without
 * adding a case fails the build.
 */

import {
	BETTER_AUTH_ACCEPTED_CLAIM_KEYS,
	type MappedPrincipal,
	mapClaimsToPrincipal,
} from "./claims.js";
import {
	BetterAuthClaimsError,
	type BetterAuthClaimsErrorCode,
} from "./errors.js";
import { BETTER_AUTH_CLAIMS_MAPPING_VERSION } from "./ids.js";
import { isJsonObject, type JsonObject } from "./json.js";

export type ClaimsMappingExpectation =
	| { readonly outcome: "mapped"; readonly principal: MappedPrincipal }
	| { readonly outcome: "refused"; readonly code: BetterAuthClaimsErrorCode };

export interface ClaimsMappingCase {
	readonly name: string;
	readonly claims: unknown;
	readonly expected: ClaimsMappingExpectation;
}

export interface ClaimsMappingConformanceResult {
	readonly mappingVersion: string;
	readonly total: number;
	readonly passed: number;
	readonly failed: readonly {
		readonly name: string;
		readonly reason: string;
	}[];
}

const VERSION = BETTER_AUTH_CLAIMS_MAPPING_VERSION;

function mapped<T>(
	name: string,
	claims: T,
	principal: MappedPrincipal,
): ClaimsMappingCase {
	return Object.freeze({
		name,
		claims,
		expected: Object.freeze({ outcome: "mapped", principal }),
	});
}

function refused<T>(
	name: string,
	claims: T,
	code: BetterAuthClaimsErrorCode,
): ClaimsMappingCase {
	return Object.freeze({
		name,
		claims,
		expected: Object.freeze({ outcome: "refused", code }),
	});
}

export const BETTER_AUTH_CLAIMS_CONFORMANCE_CASES: readonly ClaimsMappingCase[] =
	Object.freeze([
		mapped(
			"minimal claim set maps to a role-less principal",
			{ sub: "user_01", iss: "https://app.example.com" },
			{
				subject: "user_01",
				issuer: "https://app.example.com",
				roles: [],
				claimsMappingVersion: VERSION,
			},
		),
		mapped(
			"email claim populates the principal email",
			{
				sub: "user_02",
				iss: "https://app.example.com",
				email: "ada@example.com",
			},
			{
				subject: "user_02",
				issuer: "https://app.example.com",
				email: "ada@example.com",
				roles: [],
				claimsMappingVersion: VERSION,
			},
		),
		mapped(
			"activeOrganizationId is the only source of tenancy",
			{
				sub: "user_03",
				iss: "https://app.example.com",
				activeOrganizationId: "org_hobo",
			},
			{
				subject: "user_03",
				issuer: "https://app.example.com",
				organizationId: "org_hobo",
				roles: [],
				claimsMappingVersion: VERSION,
			},
		),
		mapped(
			"singular role claim becomes a one-entry role list",
			{ sub: "user_04", iss: "https://app.example.com", role: "admin" },
			{
				subject: "user_04",
				issuer: "https://app.example.com",
				roles: ["admin"],
				claimsMappingVersion: VERSION,
			},
		),
		mapped(
			"roles array is deduped and sorted, not preserved in issue order",
			{
				sub: "user_05",
				iss: "https://app.example.com",
				roles: ["member", "admin", "member"],
			},
			{
				subject: "user_05",
				issuer: "https://app.example.com",
				roles: ["admin", "member"],
				claimsMappingVersion: VERSION,
			},
		),
		mapped(
			"role and roles are unioned rather than one shadowing the other",
			{
				sub: "user_06",
				iss: "https://app.example.com",
				role: "owner",
				roles: ["member"],
			},
			{
				subject: "user_06",
				issuer: "https://app.example.com",
				roles: ["member", "owner"],
				claimsMappingVersion: VERSION,
			},
		),
		mapped(
			"registered JWT claims are accepted for shape and not projected",
			{
				sub: "user_07",
				iss: "https://app.example.com",
				email: "grace@example.com",
				emailVerified: true,
				name: "Grace",
				activeOrganizationId: "org_hobo",
				role: "admin",
				roles: ["member"],
				aud: ["hobo"],
				exp: 4102444800,
				iat: 1700000000,
				nbf: 1700000000,
				jti: "tok_01",
			},
			{
				subject: "user_07",
				issuer: "https://app.example.com",
				email: "grace@example.com",
				organizationId: "org_hobo",
				roles: ["admin", "member"],
				claimsMappingVersion: VERSION,
			},
		),
		refused(
			"a token string is not a claim set",
			"eyJhbGciOiJIUzI1NiJ9.x.y",
			"BETTER_AUTH_CLAIMS_SHAPE_INVALID",
		),
		refused(
			"missing sub cannot be substituted from email",
			{ iss: "https://app.example.com", email: "ada@example.com" },
			"BETTER_AUTH_CLAIMS_SUBJECT_INVALID",
		),
		refused(
			"a bare issuer name is not an issuer URL",
			{ sub: "user_08", iss: "better-auth" },
			"BETTER_AUTH_CLAIMS_ISSUER_INVALID",
		),
		refused(
			"an unparsable email is refused rather than dropped",
			{ sub: "user_09", iss: "https://app.example.com", email: "not-an-email" },
			"BETTER_AUTH_CLAIMS_EMAIL_INVALID",
		),
		refused(
			"a structured organization claim is refused rather than flattened",
			{
				sub: "user_10",
				iss: "https://app.example.com",
				activeOrganizationId: { id: "org_hobo" },
			},
			"BETTER_AUTH_CLAIMS_ORGANIZATION_INVALID",
		),
		refused(
			"a comma-delimited roles string is refused rather than split",
			{ sub: "user_11", iss: "https://app.example.com", roles: "admin,member" },
			"BETTER_AUTH_CLAIMS_ROLE_INVALID",
		),
		refused(
			"a non-numeric exp is refused even though expiry is not evaluated here",
			{ sub: "user_12", iss: "https://app.example.com", exp: "4102444800" },
			"BETTER_AUTH_CLAIMS_REGISTERED_CLAIM_INVALID",
		),
		refused(
			"an unrecognized group claim is refused, not silently ignored",
			{
				sub: "user_13",
				iss: "https://app.example.com",
				groups: ["engineering"],
			},
			"BETTER_AUTH_CLAIMS_UNKNOWN_FIELD",
		),
	]);

function describe<T>(value: T): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return "<unserializable>";
	}
}

/** Key-order-independent structural equality over JSON-shaped values. */
function deepEqual<T, U>(left: T, right: U): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right)) return false;
		if (left.length !== right.length) return false;
		return left.every((entry, index) => deepEqual(entry, right[index]));
	}
	if (
		!isJsonObject(left) ||
		!isJsonObject(right) ||
		left === null ||
		right === null
	) {
		return false;
	}
	// SAFETY: assertion to `ft as JsonObject; ` is required at this boundary.
	const leftRecord = left as JsonObject;
	// SAFETY: assertion to `ght as JsonObject; ` is required at this boundary.
	const rightRecord = right as JsonObject;
	const leftKeys = Object.keys(leftRecord).sort();
	const rightKeys = Object.keys(rightRecord).sort();
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every(
		(key, index) =>
			key === rightKeys[index] && deepEqual(leftRecord[key], rightRecord[key]),
	);
}

/**
 * Run the claims-mapping conformance cases against a mapping implementation.
 *
 * Pure and synchronous. Pass `map` to check a candidate replacement issuer's
 * mapping against this adapter's baseline before swapping it onto a live Yard.
 */
export function runClaimsMappingConformance(options?: {
	readonly cases?: readonly ClaimsMappingCase[];
	readonly map?: <T>(claims: T) => MappedPrincipal;
}): ClaimsMappingConformanceResult {
	const cases = options?.cases ?? BETTER_AUTH_CLAIMS_CONFORMANCE_CASES;
	const map = options?.map ?? mapClaimsToPrincipal;
	const failed: { readonly name: string; readonly reason: string }[] = [];

	for (const testCase of cases) {
		const { name, claims, expected } = testCase;
		let actual: MappedPrincipal | undefined;
		let thrown: unknown;
		try {
			actual = map(claims);
		} catch (error) {
			thrown = error;
		}

		if (expected.outcome === "mapped") {
			if (thrown !== undefined) {
				failed.push({
					name,
					reason: `expected a mapped principal but the mapping refused with ${String(thrown)}`,
				});
				continue;
			}
			if (!deepEqual(actual, expected.principal)) {
				failed.push({
					name,
					reason: `expected ${describe(expected.principal)} but got ${describe(actual)}`,
				});
			}
			continue;
		}

		if (thrown === undefined) {
			failed.push({
				name,
				reason: `expected refusal ${expected.code} but the mapping produced ${describe(actual)}`,
			});
			continue;
		}
		if (
			!(thrown instanceof BetterAuthClaimsError) ||
			thrown.code !== expected.code
		) {
			failed.push({
				name,
				reason: `expected refusal ${expected.code} but got ${String(thrown)}`,
			});
		}
	}

	return Object.freeze({
		mappingVersion: VERSION,
		total: cases.length,
		passed: cases.length - failed.length,
		failed: Object.freeze(failed),
	});
}

/**
 * Accepted claim keys not exercised by any mapped case.
 *
 * A non-empty result means the case list no longer proves the mapping total
 * over its accepted vocabulary — a test asserts it stays empty.
 */
export function unexercisedAcceptedClaimKeys(
	cases: readonly ClaimsMappingCase[] = BETTER_AUTH_CLAIMS_CONFORMANCE_CASES,
): readonly string[] {
	const seen = new Set<string>();
	for (const testCase of cases) {
		if (testCase.expected.outcome !== "mapped") continue;
		const claims = testCase.claims;
		if (!isJsonObject(claims) || claims === null) continue;
		for (const key of Object.keys(claims)) {
			seen.add(key);
		}
	}
	return Object.freeze(
		BETTER_AUTH_ACCEPTED_CLAIM_KEYS.filter((key) => !seen.has(key)).sort(),
	);
}
