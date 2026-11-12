// Event bodies of the desired-state module are the protobuf JSON form of the
// generated records (cd.proto). Parse, don't validate: these parsers are the
// only way to obtain the branded `Parsed*` derived types, and they apply the
// constraints in data-models/sets.cue.
import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import {
	CampManagement,
	ChangeKind,
	type DeltaDecisionRecord,
	DeltaDecisionRecordSchema,
	type DeltaRecord,
	DeltaRecordSchema,
	type PolicyBindingRecord,
	PolicyBindingRecordSchema,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	SetOrigin,
	type SetRecord,
	SetRecordSchema,
} from "../_generated/cd_pb.js";
import { DELTA_SCHEMA, SET_SCHEMA } from "../events.js";
import type { DeltaIntent } from "../ports.js";
import { DesiredStateError, type SetsFailureCode } from "./errors.js";

declare const parsedSet: unique symbol;
declare const parsedDelta: unique symbol;

/** A SetRecord that satisfies #SetRecord in sets.cue. */
export type ParsedSet = SetRecord & { readonly [parsedSet]: "cd.ParsedSet" };
/** A DeltaRecord that satisfies #DeltaRecord in sets.cue. */
export type ParsedDelta = DeltaRecord & { readonly [parsedDelta]: "cd.ParsedDelta" };

// public-contract: Delta intents (DeltaRecord.intent), mirrors DeltaIntent in ports.ts.
export const DELTA_INTENTS: readonly DeltaIntent[] = Object.freeze([
	"promote",
	"rollback",
	"drift-remediate",
	"up",
	"down",
	"preview",
	"config",
	"topology",
	"failover",
	"depart",
	"posture-remediate",
]);

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const OPTIONS = { ignoreUnknownFields: true } as const;

function fail(code: SetsFailureCode, message: string, subject: string): never {
	throw new DesiredStateError(code, message, subject);
}

function decode<T>(parse: () => T, code: SetsFailureCode, subject: string): T {
	try {
		return parse();
	} catch (error) {
		if (error instanceof DesiredStateError) throw error;
		return fail(code, error instanceof Error ? error.message : "undecodable record", subject);
	}
}

// SAFETY: event data was written by this module (or a peer) as protobuf JSON.
const asJson = (data: unknown): JsonValue => data as JsonValue;

export function encodeSet(set: SetRecord): JsonValue {
	return toJson(SetRecordSchema, set);
}

export function encodeDelta(delta: DeltaRecord): JsonValue {
	return toJson(DeltaRecordSchema, delta);
}

export function encodeDecision(decision: DeltaDecisionRecord): JsonValue {
	return toJson(DeltaDecisionRecordSchema, decision);
}

export function checkSet(set: SetRecord, code: SetsFailureCode = "journal-invalid"): ParsedSet {
	const subject = set.setId || set.campId;
	if (set.schemaVersion !== SET_SCHEMA) fail(code, `set schema_version must be ${SET_SCHEMA}`, subject);
	if (!/^set_[0-9a-z]{8,64}$/.test(set.setId)) fail(code, "set_id must match set_<id>", subject);
	if (set.campId === "" || set.tenant === "") fail(code, "set camp_id and tenant are required", subject);
	for (const [field, value] of [
		["plan_hash", set.planHash],
		["content_hash", set.contentHash],
		["resolved_set_digest", set.resolvedSetDigest],
	] as const) {
		if (!DIGEST.test(value)) fail(code, `${field} must be sha256:<64 hex>`, subject);
	}
	if (set.origin === SetOrigin.UNSPECIFIED || SetOrigin[set.origin] === undefined) fail(code, "origin is required", subject);
	if (set.gateDecisionId === "") fail(code, "gate_decision_id is required (I10)", subject);
	if (set.resolvedSetBytes <= 0n) fail(code, "resolved_set_bytes must be positive", subject);
	if (Number.isNaN(Date.parse(set.createdAt))) fail(code, "created_at must be an RFC 3339 timestamp", subject);
	// SAFETY: every #SetRecord constraint was checked above.
	return Object.freeze(set) as ParsedSet;
}

export function parseSet(data: unknown, code: SetsFailureCode = "journal-invalid"): ParsedSet {
	return checkSet(decode(() => fromJson(SetRecordSchema, asJson(data), OPTIONS), code, "set"), code);
}

export function checkDelta(delta: DeltaRecord, code: SetsFailureCode = "journal-invalid"): ParsedDelta {
	const subject = delta.deltaId || delta.campId;
	if (delta.schemaVersion !== DELTA_SCHEMA) fail(code, `delta schema_version must be ${DELTA_SCHEMA}`, subject);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(delta.deltaId)) fail(code, "delta_id is required ([A-Za-z0-9._:-], <=128)", subject);
	if (delta.deltaId.startsWith("set_")) fail(code, "delta_id may not start with set_ (reserved for Set ids)", subject);
	if (delta.campId === "") fail(code, "camp_id is required", subject);
	if (!DELTA_INTENTS.some((intent) => intent === delta.intent)) {
		fail(code, `intent must be one of ${DELTA_INTENTS.join(", ")}`, subject);
	}
	if (delta.freightId !== "" && !DIGEST.test(delta.freightId)) fail(code, "freight_id must be sha256:<64 hex> when set", subject);
	const seen = new Set<string>();
	for (const change of delta.changes) {
		if (change.resource === "") fail(code, "every change names a resource", subject);
		if (change.kind === ChangeKind.UNSPECIFIED || ChangeKind[change.kind] === undefined) {
			fail(code, `change ${change.resource} needs a kind`, subject);
		}
		if (seen.has(change.resource)) fail(code, `resource ${change.resource} changes twice`, subject);
		seen.add(change.resource);
	}
	// SAFETY: every #DeltaRecord constraint was checked above.
	return Object.freeze(delta) as ParsedDelta;
}

export function parseDelta(data: unknown, code: SetsFailureCode = "journal-invalid"): ParsedDelta {
	return checkDelta(decode(() => fromJson(DeltaRecordSchema, asJson(data), OPTIONS), code, "delta"), code);
}

export function parseDecision(data: unknown): DeltaDecisionRecord {
	const decision = decode(() => fromJson(DeltaDecisionRecordSchema, asJson(data), OPTIONS), "journal-invalid", "delta");
	if (decision.deltaId === "") fail("journal-invalid", "decision needs delta_id", "delta");
	return Object.freeze(decision);
}

export function parsePolicyBinding(data: unknown): PolicyBindingRecord {
	return Object.freeze(decode(() => fromJson(PolicyBindingRecordSchema, asJson(data), OPTIONS), "journal-invalid", "policy"));
}

export function parseObservation(data: unknown): ReconcileObservationRecord {
	return Object.freeze(
		decode(() => fromJson(ReconcileObservationRecordSchema, asJson(data), OPTIONS), "journal-invalid", "status"),
	);
}

/** Management from a camp.* body (`management` as enum name or number); undefined when absent. */
export function managementOf(data: unknown): CampManagement | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const raw = (data as { management?: unknown }).management;
	if (raw === "CAMP_MANAGEMENT_MANAGED" || raw === CampManagement.MANAGED) return CampManagement.MANAGED;
	if (raw === "CAMP_MANAGEMENT_OBSERVE_ONLY" || raw === CampManagement.OBSERVE_ONLY) return CampManagement.OBSERVE_ONLY;
	return undefined;
}

export function cloneDelta(delta: DeltaRecord): DeltaRecord {
	return fromJson(DeltaRecordSchema, encodeDelta(delta));
}
