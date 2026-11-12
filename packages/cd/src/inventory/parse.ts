// Parse boundaries for inventory commands (parse, don't validate): each
// returns a branded record or typed refusals with remediation. The CUE
// constraints in data-models/inventory.cue mirror these rules.
import { create } from "@bufbuild/protobuf";
import {
	type CampClaimRecord,
	CampClaimRecordSchema,
	type CampConditionRecord,
	CampConditionType,
	CampManagement,
	type CampSetRecord,
	CampSetRecordSchema,
	ConditionStatus,
	type ReasonRecord,
	SignalSource,
	TaintEffect,
	type TaintRecord,
	TaintRecordSchema,
} from "../_generated/cd_pb.js";
import type { Outcome } from "../ports.js";
import { RESERVED_TAINT_PREFIX } from "./derive.js";
import { isEmptySelector, parseSelector } from "./selector.js";
import { reason } from "./support.js";

export type ParsedCampSet = CampSetRecord & { readonly __brand: "cd.ParsedCampSet" };
export type ParsedTaint = TaintRecord & { readonly __brand: "cd.ParsedTaint" };
export type ParsedClaim = CampClaimRecord & { readonly __brand: "cd.ParsedClaim" };

export const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u;
export const TAINT_KEY = /^[A-Za-z0-9]([A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
export const CLAIM_NAME = /^(label:)?[A-Za-z0-9]([A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
const MAX_VALUE = 256;
const MAX_REASON = 1024;
const MAX_CLAIMS = 64;

export function parseCampSet(set: CampSetRecord): Outcome<ParsedCampSet> {
	const reasons: ReasonRecord[] = [];
	if (!SLUG.test(set.name)) {
		reasons.push(
			reason("campset-invalid", `Camp set name "${set.name}" is not a slug`, "use 1-63 lowercase letters, digits and '-'", "name"),
		);
	}
	const selector = parseSelector(set.selector, "selector");
	if (!selector.ok) reasons.push(...selector.reasons);
	if (set.campIds.some((id) => id === "" || id.length > MAX_VALUE)) {
		reasons.push(reason("campset-invalid", "campIds has an empty or oversized entry", "list declared Camp ids only", "campIds"));
	}
	if (new Set(set.campIds).size !== set.campIds.length) {
		reasons.push(reason("campset-invalid", "campIds lists a Camp twice", "list each Camp id once", "campIds"));
	}
	if (set.campIds.length === 0 && isEmptySelector(set.selector)) {
		reasons.push(
			reason(
				"campset-empty",
				`Camp set "${set.name}" has neither a selector nor Camp ids`,
				"add a selector or at least one Camp id; an empty definition would silently match nothing",
				"selector",
			),
		);
	}
	if (reasons.length > 0) return { ok: false, reasons };
	const parsed = create(CampSetRecordSchema, {
		name: set.name,
		selector: set.selector,
		campIds: [...set.campIds].sort(),
		definedBy: set.definedBy,
	});
	// SAFETY: checked above; the brand records that.
	return { ok: true, value: parsed as ParsedCampSet };
}

export function parseTaint(taint: TaintRecord): Outcome<ParsedTaint> {
	const reasons: ReasonRecord[] = [];
	if (!TAINT_KEY.test(taint.key)) {
		reasons.push(reason("taint-invalid", `taint key "${taint.key}" is invalid`, "use 1-128 letters, digits, '.', '_', '/', '-'", "key"));
	} else if (taint.key.startsWith(RESERVED_TAINT_PREFIX)) {
		reasons.push(
			reason(
				"taint-reserved",
				`taint key "${taint.key}" is reserved for automatic taints`,
				`choose a key outside "${RESERVED_TAINT_PREFIX}"; automatic taints clear when their condition recovers`,
				"key",
			),
		);
	}
	if (taint.effect !== TaintEffect.NO_PLACE && taint.effect !== TaintEffect.NO_RUN) {
		reasons.push(reason("taint-invalid", "taint effect must be NO_PLACE or NO_RUN", "set effect", "effect"));
	}
	if (taint.value.length > MAX_VALUE) {
		reasons.push(reason("taint-invalid", "taint value exceeds 256 characters", "shorten the value", "value"));
	}
	if (taint.reason.length > MAX_REASON) {
		reasons.push(reason("taint-invalid", "taint reason exceeds 1024 characters", "shorten the reason", "reason"));
	}
	if (reasons.length > 0) return { ok: false, reasons };
	const parsed = create(TaintRecordSchema, {
		key: taint.key,
		value: taint.value,
		effect: taint.effect,
		source: taint.source === SignalSource.UNSPECIFIED ? SignalSource.OPERATOR : taint.source,
		reason: taint.reason,
	});
	// SAFETY: checked above; the brand records that.
	return { ok: true, value: parsed as ParsedTaint };
}

export function parseClaims(claims: readonly CampClaimRecord[]): Outcome<readonly ParsedClaim[]> {
	const reasons: ReasonRecord[] = [];
	if (claims.length > MAX_CLAIMS) {
		reasons.push(reason("claim-invalid", `more than ${MAX_CLAIMS} claims in one report`, "report at most 64 claims", "claims"));
	}
	const names = new Set<string>();
	for (const claim of claims) {
		if (!CLAIM_NAME.test(claim.name) || claim.value.length > MAX_VALUE) {
			reasons.push(
				reason("claim-invalid", `claim "${claim.name}" is invalid`, "use a claim name of 1-128 safe characters and a value of at most 256", claim.name),
			);
		}
		if (names.has(claim.name)) {
			reasons.push(reason("claim-invalid", `claim "${claim.name}" is reported twice`, "report each claim once", claim.name));
		}
		names.add(claim.name);
	}
	if (reasons.length > 0) return { ok: false, reasons };
	return {
		ok: true,
		// SAFETY: checked above; the brand records that.
		value: claims.map((claim) => create(CampClaimRecordSchema, claim) as ParsedClaim),
	};
}

export function parseConditions(
	conditions: readonly CampConditionRecord[],
): Outcome<readonly CampConditionRecord[]> {
	const reasons: ReasonRecord[] = [];
	for (const condition of conditions) {
		if (condition.type === CampConditionType.UNSPECIFIED || CampConditionType[condition.type] === undefined) {
			reasons.push(reason("condition-invalid", "condition type is unspecified", "set a CampConditionType", "conditions.type"));
		}
		if (condition.status === ConditionStatus.UNSPECIFIED || ConditionStatus[condition.status] === undefined) {
			reasons.push(reason("condition-invalid", "condition status is unspecified", "set TRUE, FALSE or UNKNOWN", "conditions.status"));
		}
		if (condition.reason.length > MAX_REASON) {
			reasons.push(reason("condition-invalid", "condition reason exceeds 1024 characters", "shorten the reason", "conditions.reason"));
		}
	}
	const keys = new Set(conditions.map((condition) => condition.type));
	if (keys.size !== conditions.length) {
		reasons.push(reason("condition-invalid", "a condition type is reported twice", "report each condition type once per observation", "conditions"));
	}
	if (reasons.length > 0) return { ok: false, reasons };
	return { ok: true, value: conditions };
}

export function isManagement(value: CampManagement): boolean {
	return value === CampManagement.MANAGED || value === CampManagement.OBSERVE_ONLY;
}
