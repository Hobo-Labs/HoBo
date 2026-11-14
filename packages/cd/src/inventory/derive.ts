// Pure derivation of a Camp's Station-owned conditions and automatic taints
// (D19). Inputs are recorded facts and an injected `atMs`; no clock, network
// or randomness (I8). Agent-reported facts can narrow (a NO_PLACE taint via
// inconsistent claims) but never add NO_RUN (I19, §10).
import { create, toJson } from "@bufbuild/protobuf";
import {
	type CampClaimRecord,
	type CampConditionRecord,
	CampConditionRecordSchema,
	CampConditionType,
	type CampStatusRecord,
	CampStatusRecordSchema,
	ConditionStatus,
	type RailFailoverRecord,
	SignalSource,
	TaintEffect,
	type TaintRecord,
	TaintRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../events.js";
import type { CampTopology } from "../ports.js";
import { campJurisdictions } from "./selector.js";
import { canonicalJson, iso } from "./support.js";

/** Keys of the taints the inventory adds and clears by itself. */
export const AUTO_TAINTS = Object.freeze({
	unreachable: "hobo.cd/unreachable",
	leaseLost: "hobo.cd/lease-lost",
	credentialInvalid: "hobo.cd/credential-invalid",
	claimsInconsistent: "hobo.cd/claims-inconsistent",
	/** NO_RUN added by a Rail-permitted rule; cleared only by an operator. */
	failed: "hobo.cd/failed",
});

/** Prefix reserved for automatic taints; operators may not add these keys. */
// public-contract: reserved taint-key namespace operators may not write (persisted taint keys).
export const RESERVED_TAINT_PREFIX = "hobo.cd/";

// public-contract: actor recorded as `addedBy` on automatic taints in journaled events.
export const SYSTEM_ACTOR = "system:cd-inventory";

const AUTO_NO_PLACE = new Set<string>([
	AUTO_TAINTS.unreachable,
	AUTO_TAINTS.leaseLost,
	AUTO_TAINTS.credentialInvalid,
	AUTO_TAINTS.claimsInconsistent,
]);

export function isAutomaticNoPlace(key: string): boolean {
	return AUTO_NO_PLACE.has(key);
}

/** Condition types the Station derives itself; reports from other sources never set them. */
export const DERIVED_TYPES: ReadonlySet<CampConditionType> = new Set([
	CampConditionType.REACHABLE,
	CampConditionType.LEASED,
	CampConditionType.CREDENTIAL_VALID,
	CampConditionType.CLAIMS_CONSISTENT,
]);

/**
 * Station-observed activity for one Camp, as epoch ms. Every field is set
 * only by Station-side evidence: reconcile events the Station appended,
 * Station-sourced reports, or SVID issuance and refresh outcomes.
 */
export type ContactState = Readonly<{
	lastContactMs?: number | undefined;
	unreachableReportedMs?: number | undefined;
	lastLeaseMs?: number | undefined;
	leaseLostMs?: number | undefined;
	/** Expiry of the last successfully issued or refreshed SVID. */
	credentialExpiresMs?: number | undefined;
	/** Set by a failed refresh; cleared by the next success. */
	credentialFailedMs?: number | undefined;
	/** Last credential report of either kind; absent when the Camp holds no SVID (conductor mode). */
	credentialReportedMs?: number | undefined;
}>;

type Derived = Readonly<{
	type: CampConditionType;
	status: ConditionStatus;
	reason: string;
}>;

function reachable(contact: ContactState, atMs: number): Derived {
	const type = CampConditionType.REACHABLE;
	const last = contact.lastContactMs;
	if (last === undefined)
		return { type, status: ConditionStatus.UNKNOWN, reason: "never-contacted" };
	if (
		contact.unreachableReportedMs !== undefined &&
		contact.unreachableReportedMs > last
	) {
		return {
			type,
			status: ConditionStatus.FALSE,
			reason: "station-reported-unreachable",
		};
	}
	if (atMs - last > CD_DEFAULTS.unreachableAfterMs) {
		return {
			type,
			status: ConditionStatus.FALSE,
			reason: `no-contact-since:${iso(last)}`,
		};
	}
	return { type, status: ConditionStatus.TRUE, reason: "contact" };
}

function leased(contact: ContactState, atMs: number): Derived {
	const type = CampConditionType.LEASED;
	const last = contact.lastLeaseMs;
	if (
		contact.leaseLostMs !== undefined &&
		(last === undefined || contact.leaseLostMs >= last)
	) {
		return { type, status: ConditionStatus.FALSE, reason: "lease-lost" };
	}
	if (last === undefined)
		return { type, status: ConditionStatus.UNKNOWN, reason: "never-leased" };
	if (atMs - last > CD_DEFAULTS.leaseTtlMs) {
		return {
			type,
			status: ConditionStatus.FALSE,
			reason: `lease-expired-since:${iso(last + CD_DEFAULTS.leaseTtlMs)}`,
		};
	}
	return { type, status: ConditionStatus.TRUE, reason: "lease-active" };
}

function credential(contact: ContactState, atMs: number): Derived | undefined {
	const type = CampConditionType.CREDENTIAL_VALID;
	if (contact.credentialReportedMs === undefined) return undefined;
	if (contact.credentialFailedMs !== undefined) {
		return {
			type,
			status: ConditionStatus.FALSE,
			reason: "svid-refresh-failed",
		};
	}
	const expires = contact.credentialExpiresMs;
	if (expires === undefined)
		return {
			type,
			status: ConditionStatus.UNKNOWN,
			reason: "svid-expiry-unknown",
		};
	if (expires - atMs <= CD_DEFAULTS.credentialWarningMs) {
		return {
			type,
			status: ConditionStatus.FALSE,
			reason:
				expires <= atMs
					? `svid-expired:${iso(expires)}`
					: `svid-expiring-unrefreshed:${iso(expires)}`,
		};
	}
	return {
		type,
		status: ConditionStatus.TRUE,
		reason: `svid-valid-until:${iso(expires)}`,
	};
}

const normalize = (value: string): string => value.trim().toLowerCase();

/**
 * Claims that contradict declared topology, as `name=value`, sorted. Claims
 * without a declared counterpart (platform, version, capacity hints) never
 * conflict.
 */
export function claimConflicts(
	claims: readonly CampClaimRecord[],
	topology: CampTopology,
): readonly string[] {
	const conflicts: string[] = [];
	for (const claim of claims) {
		const name = claim.name;
		const value = normalize(claim.value);
		let ok = true;
		if (name === "region")
			ok = topology.regions.some((region) => normalize(region) === value);
		else if (name === "provider") ok = normalize(topology.provider) === value;
		else if (name === "yard") ok = topology.yardId === claim.value;
		else if (name === "station") ok = topology.stationId === claim.value;
		else if (name === "env" || name === "env-type")
			ok = topology.envType === claim.value;
		else if (name === "jurisdiction")
			ok = campJurisdictions(topology).some((entry) => entry === value);
		else if (name.startsWith("label:"))
			ok = topology.labels[name.slice("label:".length)] === claim.value;
		if (!ok) conflicts.push(`${name}=${claim.value}`);
	}
	return conflicts.sort();
}

function claimsConsistent(
	claims: readonly CampClaimRecord[],
	topology: CampTopology | undefined,
): Derived {
	const type = CampConditionType.CLAIMS_CONSISTENT;
	if (topology === undefined)
		return {
			type,
			status: ConditionStatus.UNKNOWN,
			reason: "camp-not-declared",
		};
	const conflicts = claimConflicts(claims, topology);
	if (conflicts.length > 0)
		return {
			type,
			status: ConditionStatus.FALSE,
			reason: `contradicts-topology:${conflicts.join(",")}`,
		};
	return { type, status: ConditionStatus.TRUE, reason: "consistent" };
}

const conditionKey = (condition: CampConditionRecord): string =>
	`${condition.type}/${condition.source}`;

export function sortConditions(
	conditions: readonly CampConditionRecord[],
): CampConditionRecord[] {
	return [...conditions].sort((a, b) => a.type - b.type || a.source - b.source);
}

export function sortClaims(
	claims: readonly CampClaimRecord[],
): CampClaimRecord[] {
	return [...claims].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	);
}

export function sortTaints(taints: readonly TaintRecord[]): TaintRecord[] {
	return [...taints].sort(
		(a, b) =>
			a.effect - b.effect || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
	);
}

/**
 * Independent negative signals: distinct sources currently reporting a FALSE
 * condition. Agent self-reports (RECONCILER) never count.
 */
export function negativeSignals(
	conditions: readonly CampConditionRecord[],
): ReadonlySet<SignalSource> {
	const sources = new Set<SignalSource>();
	for (const condition of conditions) {
		if (condition.status !== ConditionStatus.FALSE) continue;
		if (
			condition.source === SignalSource.RECONCILER ||
			condition.source === SignalSource.UNSPECIFIED
		)
			continue;
		sources.add(condition.source);
	}
	return sources;
}

/** True when a Rail rule permits an automatic NO_RUN for these conditions. */
export function noRunPermitted(
	conditions: readonly CampConditionRecord[],
	failover: RailFailoverRecord | undefined,
): boolean {
	if (failover === undefined || !failover.automatic) return false;
	const required = Math.max(
		1,
		failover.requiredSignals || CD_DEFAULTS.taintRequiredSignals,
	);
	const signals = negativeSignals(conditions);
	return signals.has(SignalSource.STATION) && signals.size >= required;
}

export function defaultStatus(topology: CampTopology): CampStatusRecord {
	return create(CampStatusRecordSchema, {
		campId: topology.campId,
		management: topology.management,
	});
}

/** Status equality ignoring `updated_at`. */
export function sameStatus(a: CampStatusRecord, b: CampStatusRecord): boolean {
	const strip = (status: CampStatusRecord) =>
		canonicalJson(toJson(CampStatusRecordSchema, { ...status, updatedAt: "" }));
	return strip(a) === strip(b);
}

/**
 * Recompute Station-derived conditions and automatic taints over a status.
 * Reported conditions from other sources, claims, management and manual
 * taints are kept as they are.
 */
export function deriveStatus(
	input: Readonly<{
		previous: CampStatusRecord;
		topology: CampTopology | undefined;
		contact: ContactState;
		failover: RailFailoverRecord | undefined;
		atMs: number;
	}>,
): CampStatusRecord {
	const { previous, topology, contact, atMs } = input;
	const prior = new Map(
		previous.conditions.map((condition) => [
			conditionKey(condition),
			condition,
		]),
	);
	const kept = previous.conditions.filter(
		(condition) =>
			!(
				condition.source === SignalSource.STATION &&
				DERIVED_TYPES.has(condition.type)
			),
	);
	const derived = [
		reachable(contact, atMs),
		leased(contact, atMs),
		credential(contact, atMs),
		claimsConsistent(previous.claims, topology),
	];
	const conditions = [...kept];
	for (const entry of derived) {
		if (entry === undefined) continue;
		const before = prior.get(`${entry.type}/${SignalSource.STATION}`);
		conditions.push(
			create(CampConditionRecordSchema, {
				type: entry.type,
				status: entry.status,
				source: SignalSource.STATION,
				reason: entry.reason,
				since:
					before !== undefined &&
					before.status === entry.status &&
					before.since !== ""
						? before.since
						: iso(atMs),
			}),
		);
	}
	const status = (type: CampConditionType) =>
		derived.find((entry) => entry?.type === type)?.status ??
		ConditionStatus.UNKNOWN;
	const reasonOf = (type: CampConditionType) =>
		derived.find((entry) => entry?.type === type)?.reason ?? "";

	const wanted = new Map<string, string>();
	if (status(CampConditionType.REACHABLE) !== ConditionStatus.TRUE) {
		wanted.set(AUTO_TAINTS.unreachable, reasonOf(CampConditionType.REACHABLE));
	}
	if (status(CampConditionType.LEASED) === ConditionStatus.FALSE) {
		wanted.set(AUTO_TAINTS.leaseLost, reasonOf(CampConditionType.LEASED));
	}
	if (status(CampConditionType.CREDENTIAL_VALID) === ConditionStatus.FALSE) {
		wanted.set(
			AUTO_TAINTS.credentialInvalid,
			reasonOf(CampConditionType.CREDENTIAL_VALID),
		);
	}
	if (status(CampConditionType.CLAIMS_CONSISTENT) === ConditionStatus.FALSE) {
		wanted.set(
			AUTO_TAINTS.claimsInconsistent,
			reasonOf(CampConditionType.CLAIMS_CONSISTENT),
		);
	}

	const taints: TaintRecord[] = [];
	for (const taint of previous.taints) {
		const automatic =
			taint.effect === TaintEffect.NO_PLACE && isAutomaticNoPlace(taint.key);
		if (!automatic) taints.push(taint);
	}
	for (const [key, why] of wanted) {
		const before = previous.taints.find(
			(taint) => taint.key === key && taint.effect === TaintEffect.NO_PLACE,
		);
		taints.push(
			create(TaintRecordSchema, {
				key,
				value: "true",
				effect: TaintEffect.NO_PLACE,
				source: SignalSource.STATION,
				reason: why,
				addedBy: SYSTEM_ACTOR,
				addedAt: before?.addedAt || iso(atMs),
			}),
		);
	}
	const sortedConditions = sortConditions(conditions);
	const hasNoRun = taints.some(
		(taint) =>
			taint.effect === TaintEffect.NO_RUN && taint.key === AUTO_TAINTS.failed,
	);
	if (!hasNoRun && noRunPermitted(sortedConditions, input.failover)) {
		const sources = [...negativeSignals(sortedConditions)]
			.sort((a, b) => a - b)
			.map((source) => SignalSource[source]);
		taints.push(
			create(TaintRecordSchema, {
				key: AUTO_TAINTS.failed,
				value: "true",
				effect: TaintEffect.NO_RUN,
				source: SignalSource.STATION,
				reason: `rail-rule:signals=${sources.join("+")}`,
				addedBy: SYSTEM_ACTOR,
				addedAt: iso(atMs),
			}),
		);
	}
	return create(CampStatusRecordSchema, {
		campId: previous.campId,
		management: previous.management,
		conditions: sortedConditions,
		claims: sortClaims(previous.claims),
		taints: sortTaints(taints),
		updatedAt: previous.updatedAt,
	});
}
