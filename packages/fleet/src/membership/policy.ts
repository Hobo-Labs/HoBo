/**
 * Fleet-policy checks of enrollment and declaration (§6.13, L02 private).
 * Each failure is `fleet-policy` with `detail.rule` naming the rule, except
 * the three that have their own code (§7.6): `attestation-insufficient`,
 * `agent-outdated`, `residency-denied`.
 *
 * An empty list in the policy (`allowed_kinds`, `allowed_roles`,
 * `allowed_classes`) places no restriction: the protobuf default of a fresh
 * policy must not make every fleet unusable.
 */
import {
	evaluateResidency,
	parseDataClassification,
	parseJurisdictionId,
} from "@hobo/core";
import {
	type AttestationTier,
	type DeviceClass,
	type FleetPolicy,
	type MemberKind,
	type OidcTrustRule,
	Role,
} from "../_generated/fleet_pb.js";
import type { Outcome } from "../ports.js";
import { refuse } from "./context.js";

const DEFAULT_BUNDLE_HOURS = 24;
const MAX_BUNDLE_HOURS = 720;
const HOUR_MS = 60 * 60 * 1_000;
/** A bundle may be issued a little before it reaches the authority. */
const BUNDLE_SLACK_MS = 5 * 60 * 1_000;

function rule<T>(name: string, message: string): Outcome<T> {
	return refuse("fleet-policy", message, { rule: name });
}

export function checkKind(
	policy: FleetPolicy,
	kind: MemberKind,
): Outcome<true> {
	if (policy.allowedKinds.length > 0 && !policy.allowedKinds.includes(kind))
		return rule("allowed-kinds", "the fleet does not take this member kind");
	return { ok: true, value: true };
}

export function checkRoles(
	policy: FleetPolicy,
	roles: readonly Role[],
): Outcome<true> {
	for (const role of roles) {
		if (role === Role.UNSPECIFIED)
			return rule("allowed-roles", "a role is unspecified");
		if (policy.allowedRoles.length > 0 && !policy.allowedRoles.includes(role))
			return rule("allowed-roles", "the fleet does not allow this role");
	}
	return { ok: true, value: true };
}

export function checkClass(
	policy: FleetPolicy,
	deviceClass: DeviceClass,
): Outcome<true> {
	if (
		policy.allowedClasses.length > 0 &&
		!policy.allowedClasses.includes(deviceClass)
	)
		return rule("allowed-classes", "the fleet does not take this device class");
	return { ok: true, value: true };
}

export function checkTier(
	policy: FleetPolicy,
	tier: AttestationTier,
): Outcome<true> {
	if (tier < policy.minAttestationTier)
		return refuse(
			"attestation-insufficient",
			"the device is below the fleet's minimum attestation tier",
		);
	return { ok: true, value: true };
}

/** Dotted numeric versions; a missing part counts as 0, a non-numeric one fails closed. */
export function checkAgentVersion(
	policy: FleetPolicy,
	minimum: string,
	version: string,
): Outcome<true> {
	const floors = [policy.minAgentVersion, minimum].filter(
		(value) => value.length > 0,
	);
	for (const floor of floors)
		if (!atLeast(version, floor))
			return refuse(
				"agent-outdated",
				`agent ${version || "(none)"} is below ${floor}`,
				{ minimum: floor },
			);
	return { ok: true, value: true };
}

function parts(version: string): number[] | undefined {
	const core = version.trim().replace(/^v/u, "").split(/[-+]/u)[0] ?? "";
	const numbers = core.split(".").map((part) => Number(part));
	return numbers.every((part) => Number.isSafeInteger(part) && part >= 0)
		? numbers
		: undefined;
}

function atLeast(version: string, floor: string): boolean {
	const have = parts(version);
	const need = parts(floor);
	if (need === undefined) return true;
	if (have === undefined) return false;
	for (let i = 0; i < Math.max(have.length, need.length); i += 1) {
		const a = have[i] ?? 0;
		const b = need[i] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
}

/** When the fleet carries a residency rule, the member's region must satisfy it (ADR-0146, fail closed). */
export function checkResidency(
	policy: FleetPolicy,
	region: string,
): Outcome<true> {
	const residency = policy.residency;
	if (
		residency === undefined ||
		(residency.allowedJurisdictions.length === 0 &&
			residency.deniedJurisdictions.length === 0)
	)
		return { ok: true, value: true };
	try {
		const result = evaluateResidency({
			constraint: {
				classifications: residency.classifications.map((value) =>
					parseDataClassification(value),
				),
				allowedJurisdictions: residency.allowedJurisdictions.map((value) =>
					parseJurisdictionId(value),
				),
				deniedJurisdictions: residency.deniedJurisdictions.map((value) =>
					parseJurisdictionId(value),
				),
			},
			region,
		});
		if (result.ok) return { ok: true, value: true };
		return refuse("residency-denied", result.remediation, {
			code: result.code,
		});
	} catch {
		return refuse("residency-denied", "the fleet's residency rule is unusable");
	}
}

/** A key bundle may live at most `key_bundle_hours` (24 when zero, at most 720). */
export function checkBundleLifetime(
	policy: FleetPolicy,
	issuedAt: string,
	notAfter: string,
	nowMs: number,
): Outcome<true> {
	const hours = Math.min(
		policy.keyBundleHours === 0 ? DEFAULT_BUNDLE_HOURS : policy.keyBundleHours,
		MAX_BUNDLE_HOURS,
	);
	const from = Date.parse(issuedAt);
	const until = Date.parse(notAfter);
	if (Number.isNaN(from) || Number.isNaN(until) || until <= nowMs)
		return refuse("invalid-request", "the key bundle has expired or no times");
	if (from > nowMs + BUNDLE_SLACK_MS)
		return refuse("invalid-request", "the key bundle is issued in the future");
	if (until - from > hours * HOUR_MS)
		return rule("key-bundle-hours", "the key bundle outlives fleet policy");
	return { ok: true, value: true };
}

/** The first `oidc_trust` rule an assertion matches, if any. */
export function matchOidcRule(
	policy: FleetPolicy,
	assertion: Readonly<{
		issuer: string;
		subject: string;
		claims: Readonly<Record<string, string>>;
	}>,
	sponsor: boolean,
): OidcTrustRule | undefined {
	return policy.oidcTrust.find((candidate) => {
		if (sponsor && !candidate.sponsor) return false;
		if (candidate.issuer !== assertion.issuer) return false;
		let pattern: RegExp;
		try {
			pattern = new RegExp(`^(?:${candidate.subjectPattern})$`, "u");
		} catch {
			return false;
		}
		if (!pattern.test(assertion.subject)) return false;
		return Object.entries(candidate.requiredClaims).every(
			([claim, value]) => assertion.claims[claim] === value,
		);
	});
}
