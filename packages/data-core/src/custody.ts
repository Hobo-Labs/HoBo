/**
 * The custody path and the policy verdict computed over it (ADR-0177
 * decision 9).
 *
 * A move that is compliant at both ends can still be non-compliant in the
 * middle — a dump file in the wrong region, a relay that pipes rows through a
 * denied jurisdiction, a rollback snapshot nobody reaps. So a plan carries
 * every place the data rests or passes, and the verdict is *computed* from
 * that path. Nothing here accepts a boolean that says "policy allows it".
 *
 * Pure: the caller passes the instant. This module never reads a clock.
 */
import {
	type DataClassification,
	evaluateResidency,
	type ResidencyConstraint,
	type TransferMechanismMode,
} from "@hobo/core";
import { DataCoreError } from "./errors.js";
import {
	digestOf,
	isJsonArray,
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: the schema id a custody path is published under.
export const CUSTODY_PATH_CONTRACT = "hobo.custody-path/v1";
// public-contract: the schema id a policy verdict is published under.
export const POLICY_VERDICT_CONTRACT = "hobo.data-migration-policy-verdict/v1";

export const CUSTODY_ROLES = [
	"source",
	"target",
	"event-log",
	"staging-artifact",
	"relay",
	"capture-log",
	"rollback-snapshot",
	"retiring-source",
] as const;
export type CustodyRole = (typeof CUSTODY_ROLES)[number];

/** Roles that are permanent homes; every other role is a bounded copy. */
const PERMANENT_ROLES: readonly CustodyRole[] = Object.freeze([
	"source",
	"target",
	"event-log",
]);

export const CUSTODY_PROTECTIONS = [
	"encryptedAtRest",
	"encryptedInTransit",
	"accessScoped",
	"auditLogged",
	"fieldLevelKeys",
] as const;
export type CustodyProtection = (typeof CUSTODY_PROTECTIONS)[number];

// domain-view: parsed custody point; wire form is CustodyPoint in data-models/data_core.proto.
export interface CustodyPoint {
	readonly id: string;
	readonly role: CustodyRole;
	readonly region: string;
	readonly protections: readonly CustodyProtection[];
	/** RFC 3339 instant by which a bounded copy is reaped. */
	readonly retainUntil?: string;
}

// domain-view: parsed custody path, constructible only through parseCustodyPath; wire form is CustodyPath in data-models/data_core.proto.
export interface CustodyPath {
	readonly contract: typeof CUSTODY_PATH_CONTRACT;
	readonly points: readonly CustodyPoint[];
}

/** Protections each classification requires at every custody point. */
export type ProtectionRequirements = Readonly<
	Record<DataClassification, readonly CustodyProtection[]>
>;

const BASELINE: readonly CustodyProtection[] = Object.freeze([
	"encryptedAtRest",
	"encryptedInTransit",
	"accessScoped",
	"auditLogged",
]);

/**
 * The default requirement table. It is policy, not physics: a policy pack may
 * pass a stricter table, and the verdict records which one it used.
 */
export const DEFAULT_PROTECTION_REQUIREMENTS: ProtectionRequirements =
	Object.freeze({
		public: Object.freeze([]),
		internal: Object.freeze(["accessScoped"] as const),
		pii: BASELINE,
		phi: BASELINE,
		pci: BASELINE,
		secret: Object.freeze([...BASELINE, "fieldLevelKeys"] as const),
	});

export interface CustodyPolicy {
	readonly classification: DataClassification;
	/** Absent means no residency rule applies to this dataset. */
	readonly residency?: ResidencyConstraint;
	readonly transferMechanisms?: TransferMechanismMode;
	readonly requirements?: ProtectionRequirements;
}

export const CUSTODY_FINDING_CODES = [
	"CUSTODY_PATH_INCOMPLETE",
	"CUSTODY_REGION_UNMAPPED",
	"CUSTODY_RESIDENCY_CONFLICT",
	"CUSTODY_PROTECTION_DOWNGRADE",
	"CUSTODY_RETENTION_UNBOUNDED",
	"CUSTODY_RETENTION_EXPIRED",
] as const;
export type CustodyFindingCode = (typeof CUSTODY_FINDING_CODES)[number];

// domain-view: computed finding; wire form is CustodyFinding in data-models/data_core.proto.
export interface CustodyFinding {
	readonly code: CustodyFindingCode;
	readonly point: string;
	readonly role: CustodyRole | "path";
	readonly detail: string;
	readonly remediation: string;
}

// domain-view: computed verdict; wire form is PolicyVerdict in data-models/data_core.proto.
export interface PolicyVerdict {
	readonly contract: typeof POLICY_VERDICT_CONTRACT;
	readonly ok: boolean;
	readonly classification: DataClassification;
	readonly findings: readonly CustodyFinding[];
	/** Digest of the path the verdict was computed over. */
	readonly custodyDigest: `sha256:${string}`;
	readonly evaluatedAt: string;
}

function invalid(message: string, field: string): never {
	throw new DataCoreError("INVALID_CUSTODY_PATH", message, {
		detail: { field },
	});
}

function isRole(value: string): value is CustodyRole {
	// SAFETY: membership test against the closed tuple of custody roles.
	return (CUSTODY_ROLES as readonly string[]).includes(value);
}

function isProtection(value: string): value is CustodyProtection {
	// SAFETY: membership test against the closed tuple of protections.
	return (CUSTODY_PROTECTIONS as readonly string[]).includes(value);
}

function parseInstant(value: string, field: string): number {
	const instant = Date.parse(value);
	if (Number.isNaN(instant))
		invalid(`${field} must be an RFC 3339 instant`, field);
	return instant;
}

/** The one constructor for a `CustodyPath`. Invalid input throws. */
export function parseCustodyPath(value: JsonValue | undefined): CustodyPath {
	if (!isJsonObject(value) || !isJsonArray(value.points)) {
		return invalid("custody path must be { points: [...] }", "points");
	}
	const ids = new Set<string>();
	const points = value.points.map((entry, index) => {
		const path = `points[${index}]`;
		if (!isJsonObject(entry)) invalid("custody point must be an object", path);
		const { id, role, region, protections, retainUntil } = entry;
		if (!isJsonString(id) || id === "") {
			invalid("custody point id must be a non-empty string", `${path}.id`);
		}
		if (ids.has(id)) invalid(`duplicate custody point ${id}`, `${path}.id`);
		ids.add(id);
		if (!isJsonString(role) || !isRole(role)) {
			invalid(
				`role must be one of ${CUSTODY_ROLES.join(", ")}`,
				`${path}.role`,
			);
		}
		if (!isJsonString(region) || region === "") {
			invalid("region must be a non-empty string", `${path}.region`);
		}
		const rawProtections = protections ?? [];
		if (!isJsonArray(rawProtections)) {
			invalid("protections must be an array", `${path}.protections`);
		}
		const parsed = rawProtections.map((item) =>
			isJsonString(item) && isProtection(item)
				? item
				: invalid(
						`protections entries must be one of ${CUSTODY_PROTECTIONS.join(", ")}`,
						`${path}.protections`,
					),
		);
		if (retainUntil !== undefined) {
			if (!isJsonString(retainUntil)) {
				invalid("retainUntil must be a string", `${path}.retainUntil`);
			}
			parseInstant(retainUntil, `${path}.retainUntil`);
		}
		return Object.freeze({
			id,
			role,
			region,
			protections: Object.freeze([...new Set(parsed)].sort()),
			...(isJsonString(retainUntil) ? { retainUntil } : undefined),
		});
	});
	return Object.freeze({
		contract: CUSTODY_PATH_CONTRACT,
		points: Object.freeze(points),
	});
}

export function custodyPathToJson(path: CustodyPath): JsonObject {
	return {
		contract: path.contract,
		points: path.points.map((point) => ({
			id: point.id,
			role: point.role,
			region: point.region,
			protections: [...point.protections],
			...(point.retainUntil === undefined
				? undefined
				: { retainUntil: point.retainUntil }),
		})),
	};
}

export function custodyPathDigest(path: CustodyPath): `sha256:${string}` {
	return digestOf(custodyPathToJson(path));
}

export interface EvaluateCustodyPathInput {
	readonly path: CustodyPath;
	readonly policy: CustodyPolicy;
	/** Injected instant, RFC 3339. */
	readonly now: string;
}

function residencyApplies(
	policy: CustodyPolicy,
): ResidencyConstraint | undefined {
	const constraint = policy.residency;
	if (constraint === undefined) return undefined;
	if (
		constraint.classifications.length > 0 &&
		!constraint.classifications.includes(policy.classification)
	) {
		return undefined;
	}
	return constraint;
}

/**
 * Compute the verdict. Fail-closed throughout: an unmapped region is a
 * conflict, a bounded copy with no deadline is a finding, and a path with no
 * source or no destination is not a path.
 */
export function evaluateCustodyPath(
	input: EvaluateCustodyPathInput,
): PolicyVerdict {
	const { path, policy } = input;
	const now = parseInstant(input.now, "now");
	const findings: CustodyFinding[] = [];
	const roles = new Set(path.points.map((point) => point.role));
	if (!roles.has("source") && !roles.has("event-log")) {
		findings.push({
			code: "CUSTODY_PATH_INCOMPLETE",
			point: "path",
			role: "path",
			detail: "the path names no source or event-log custody point",
			remediation: "declare where the data is read from",
		});
	}
	if (!roles.has("target") && !roles.has("event-log")) {
		findings.push({
			code: "CUSTODY_PATH_INCOMPLETE",
			point: "path",
			role: "path",
			detail: "the path names no target custody point",
			remediation: "declare where the data lands",
		});
	}
	const constraint = residencyApplies(policy);
	const required = (policy.requirements ?? DEFAULT_PROTECTION_REQUIREMENTS)[
		policy.classification
	];
	for (const point of path.points) {
		if (constraint !== undefined) {
			const residency = evaluateResidency({
				constraint,
				region: point.region,
				...(policy.transferMechanisms === undefined
					? undefined
					: { transferMechanisms: policy.transferMechanisms }),
			});
			if (!residency.ok) {
				findings.push({
					code:
						residency.code === "region-unmapped"
							? "CUSTODY_REGION_UNMAPPED"
							: "CUSTODY_RESIDENCY_CONFLICT",
					point: point.id,
					role: point.role,
					detail: `${point.role} ${point.id} in ${point.region}: ${residency.code}`,
					remediation: residency.remediation,
				});
			}
		}
		const missing = required.filter(
			(protection) => !point.protections.includes(protection),
		);
		if (missing.length > 0) {
			findings.push({
				code: "CUSTODY_PROTECTION_DOWNGRADE",
				point: point.id,
				role: point.role,
				detail: `${point.role} ${point.id} lacks ${missing.join(", ")} required for ${policy.classification} data`,
				remediation: `choose a ${point.role} that provides ${missing.join(", ")}`,
			});
		}
		if (PERMANENT_ROLES.includes(point.role)) continue;
		if (point.retainUntil === undefined) {
			findings.push({
				code: "CUSTODY_RETENTION_UNBOUNDED",
				point: point.id,
				role: point.role,
				detail: `${point.role} ${point.id} has no retention deadline`,
				remediation:
					"give every bounded copy a retainUntil instant and a reap obligation",
			});
		} else if (parseInstant(point.retainUntil, "retainUntil") <= now) {
			findings.push({
				code: "CUSTODY_RETENTION_EXPIRED",
				point: point.id,
				role: point.role,
				detail: `${point.role} ${point.id} passed its retention deadline ${point.retainUntil}`,
				remediation: "reap the copy, then drop it from the path",
			});
		}
	}
	return Object.freeze({
		contract: POLICY_VERDICT_CONTRACT,
		ok: findings.length === 0,
		classification: policy.classification,
		findings: Object.freeze(findings.map((finding) => Object.freeze(finding))),
		custodyDigest: custodyPathDigest(path),
		evaluatedAt: input.now,
	});
}

export function policyVerdictToJson(verdict: PolicyVerdict): JsonObject {
	return {
		contract: verdict.contract,
		ok: verdict.ok,
		classification: verdict.classification,
		findings: verdict.findings.map((finding) => ({
			code: finding.code,
			point: finding.point,
			role: finding.role,
			detail: finding.detail,
			remediation: finding.remediation,
		})),
		custodyDigest: verdict.custodyDigest,
		evaluatedAt: verdict.evaluatedAt,
	};
}

/** Guard used by parsers of verdicts that arrived as JSON evidence. */
export function isPolicyVerdictJson(value: JsonValue | undefined): boolean {
	return (
		isJsonObject(value) &&
		value.contract === POLICY_VERDICT_CONTRACT &&
		isJsonBoolean(value.ok)
	);
}
