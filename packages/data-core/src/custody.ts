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
import { instantMicros } from "./canonical.js";
import { DataCoreError } from "./errors.js";
import type { MigrationRealization } from "./facts.js";
import {
	digestOf,
	isJsonArray,
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import { getPattern, type MigrationPatternId } from "./patterns.js";

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
	/** RFC 3339 instant, with an explicit offset, by which a bounded copy is reaped. */
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

/**
 * What a custody path is the path *of*. A pattern creates copies beyond its
 * two ends — the runner that relays rows, a retained change log, a snapshot to
 * roll back to, the old source through the soak window — and a path that
 * leaves one out has not been judged at that place.
 *
 * Absent members take the more demanding reading: with no `realization` the
 * roles of both are required, and with no `reverseTail` one is assumed
 * wherever the pattern can have one.
 */
export interface CustodyMigration {
	readonly pattern: MigrationPatternId;
	readonly realization?: MigrationRealization;
	readonly reverseTail?: boolean;
}

/** Why a pattern necessarily creates each role, for a finding's detail. */
const ROLE_ORIGIN: Readonly<Record<CustodyRole, string>> = Object.freeze({
	source: "it reads a source store",
	target: "it writes a target store",
	"event-log": "it reads the event log, or moves authority into it",
	"staging-artifact": "it stages an artifact",
	relay: "the hub carries every record through the runner",
	"capture-log": "a change log is retained for the tail",
	"rollback-snapshot": "the store is snapshotted before it is changed",
	"retiring-source":
		"the old source is kept through the soak window until it is retired",
});

/**
 * The custody roles a migration necessarily creates, in `CUSTODY_ROLES`
 * order. Derived from the pattern catalog — the ports a pattern drives are
 * the places it puts data:
 *
 * | Role | Created when |
 * |---|---|
 * | `source` | the pattern drives source ports |
 * | `target` | the pattern drives target ports |
 * | `event-log` | it drives no source port (the log is what it reads), or authority moves into the log |
 * | `relay` | the hub realization, unless one store is changed where it stands |
 * | `capture-log` | the source's `capture` port; a reverse tail (the target's); a native transfer, which retains the log itself |
 * | `rollback-snapshot` | the source's `schema` port, which snapshots before any change |
 * | `retiring-source` | the source's `retire` port |
 *
 * A `staging-artifact` is never implied: no pattern has to write one. When a
 * plan does, the path names it like any other point.
 */
export function requiredCustodyRoles(
	migration: CustodyMigration,
): readonly CustodyRole[] {
	const pattern = getPattern(migration.pattern);
	const hub = migration.realization !== "native";
	const native = migration.realization !== "hub";
	// No source port: what the pattern reads is the event log.
	const readsLog = pattern.sourcePorts.length === 0;
	// One store, changed where it stands: nothing travels.
	const inPlace = !readsLog && pattern.targetPorts.length === 0;
	// A native transfer has no reverse tail: it is torn down at the cutover.
	const reverseTail =
		hub &&
		pattern.reverseTailPorts.target.includes("capture") &&
		(migration.reverseTail ?? true);
	const created = {
		source: !readsLog,
		target: pattern.targetPorts.length > 0,
		"event-log": readsLog || pattern.authorityAfter === "log",
		"staging-artifact": false,
		relay: hub && !inPlace,
		"capture-log":
			pattern.sourcePorts.includes("capture") ||
			reverseTail ||
			(native && !readsLog && !inPlace),
		"rollback-snapshot": pattern.sourcePorts.includes("schema"),
		"retiring-source": pattern.sourcePorts.includes("retire"),
	} satisfies Record<CustodyRole, boolean>;
	return Object.freeze(CUSTODY_ROLES.filter((role) => created[role]));
}

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
	/**
	 * The roles the path named, in `CUSTODY_ROLES` order. A verdict judges only
	 * the places it was shown: a gate that picks a pattern reads this to refuse
	 * one that creates a role the path left out (`uncoveredCustodyRoles`).
	 */
	readonly roles: readonly CustodyRole[];
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

/**
 * Microseconds since the epoch, read strictly. `Date.parse` is not used: it
 * reads an instant with no offset as local time, so a retention deadline
 * would expire nine hours sooner on a host in Tokyo than on one in UTC.
 */
function parseInstant(value: string, field: string): bigint {
	const instant = instantMicros(value);
	if (instant === undefined) {
		invalid(
			`${field} must be an RFC 3339 instant with an explicit offset`,
			field,
		);
	}
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
	/** Injected instant, RFC 3339 with an explicit offset. */
	readonly now: string;
	/**
	 * The migration the path is for. Given, every role it necessarily creates
	 * must be on the path or the verdict is negative. Absent, the verdict is
	 * for the path as declared and no more — `roles` says what that was, and
	 * the selector refuses a pattern the path does not cover.
	 */
	readonly migration?: CustodyMigration;
}

/**
 * The roles a migration creates that the path behind a verdict did not name.
 * Empty means the verdict covers the migration; anything else means some copy
 * of the data was never judged, so the verdict says nothing about it.
 */
export function uncoveredCustodyRoles(
	verdict: PolicyVerdict,
	migration: CustodyMigration,
): readonly CustodyRole[] {
	// A verdict that arrived as evidence may predate `roles`. It names none.
	const named: readonly CustodyRole[] = verdict.roles ?? [];
	return requiredCustodyRoles(migration).filter(
		(role) => !named.includes(role),
	);
}

function incomplete(detail: string, remediation: string): CustodyFinding {
	return {
		code: "CUSTODY_PATH_INCOMPLETE",
		point: "path",
		role: "path",
		detail,
		remediation,
	};
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
 * conflict, a bounded copy with no deadline is a finding, a path with no
 * source or no destination is not a path, and a path that omits a copy its
 * migration creates is incomplete.
 */
export function evaluateCustodyPath(
	input: EvaluateCustodyPathInput,
): PolicyVerdict {
	const { path, policy } = input;
	const now = parseInstant(input.now, "now");
	const findings: CustodyFinding[] = [];
	const named = new Set(path.points.map((point) => point.role));
	const roles = CUSTODY_ROLES.filter((role) => named.has(role));
	const { migration } = input;
	if (migration === undefined) {
		if (!named.has("source") && !named.has("event-log")) {
			findings.push(
				incomplete(
					"the path names no source or event-log custody point",
					"declare where the data is read from",
				),
			);
		}
		if (!named.has("target") && !named.has("event-log")) {
			findings.push(
				incomplete(
					"the path names no target custody point",
					"declare where the data lands",
				),
			);
		}
	} else {
		for (const role of requiredCustodyRoles(migration)) {
			if (named.has(role)) continue;
			findings.push(
				incomplete(
					`${migration.pattern} creates a ${role} (${ROLE_ORIGIN[role]}) and the path names none`,
					`declare the ${role} custody point, with its region, its protections and, for a bounded copy, its retention deadline`,
				),
			);
		}
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
		roles: Object.freeze(roles),
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
		roles: [...verdict.roles],
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
