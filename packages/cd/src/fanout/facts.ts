// Event bodies on `cd-fanout-<id>` (D21). Each body is a JSON object whose
// record fields are protobuf JSON of the frozen cd.proto messages; this module
// is the only place they are written and parsed. A body that does not parse
// is skipped by the fold (never guessed at).
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import {
	DepartureAction,
	type FailoverRecord,
	FailoverRecordSchema,
	type FanoutRecord,
	FanoutRecordSchema,
	type FanoutStatusRecord,
	FanoutStatusRecordSchema,
	type PlacementDecisionRecord,
	PlacementDecisionRecordSchema,
	type ReasonRecord,
	ReasonRecordSchema,
} from "../_generated/cd_pb.js";
import {
	decode,
	encode,
	isJsonObject,
	jsonNumber,
	jsonObject,
	jsonString,
	jsonStrings,
} from "./journal.js";

/** What happened to one Camp of a fan-out. */
export type SlotOutcome =
	| "requested"
	| "bound"
	| "succeeded"
	| "failed"
	| "deferred"
	| "rolled-back"
	| "supersede-requested";

const OUTCOMES: ReadonlySet<string> = new Set<SlotOutcome>([
	"requested",
	"bound",
	"succeeded",
	"failed",
	"deferred",
	"rolled-back",
	"supersede-requested",
]);

export type StartedFact = Readonly<{
	fanoutId: string;
	pipeline: string;
	node: string;
	freightId: string;
	decision: PlacementDecisionRecord;
	fanout: FanoutRecord;
	departure: DepartureAction;
	windows: readonly string[];
	idempotencyKey: string;
	/** Camps of the node's previous decision that this one drops (D21 departure). */
	departing: readonly string[];
	atMs: number;
}>;

export type ProgressedFact = Readonly<{
	campId: string;
	outcome: SlotOutcome;
	promotionId: string;
	catchUp: boolean;
	reasons: readonly ReasonRecord[];
	atMs: number;
	status?: FanoutStatusRecord | undefined;
}>;

export type HaltedFact = Readonly<{
	reason: ReasonRecord;
	atMs: number;
	status?: FanoutStatusRecord | undefined;
}>;

export type ResumedFact = Readonly<{
	baseline: number;
	atMs: number;
	status?: FanoutStatusRecord | undefined;
}>;

export type StatusFact = Readonly<{
	atMs: number;
	status?: FanoutStatusRecord | undefined;
	campIds: readonly string[];
	reasons: readonly ReasonRecord[];
}>;

export type DepartedFact = Readonly<{
	fanoutId: string;
	campId: string;
	action: DepartureAction;
	promotionId: string;
	/** Data resources left in place and recorded (ORPHAN_DATA), or every resource (ORPHAN). */
	kept: readonly string[];
	reasons: readonly ReasonRecord[];
	atMs: number;
}>;

function reasonsJson(reasons: readonly ReasonRecord[]): JsonValue[] {
	return reasons.map((item) => encode(ReasonRecordSchema, item));
}

function reasonsOf(value: JsonValue | undefined): ReasonRecord[] {
	if (!Array.isArray(value)) return [];
	const out: ReasonRecord[] = [];
	for (const item of value) {
		const parsed = decode(ReasonRecordSchema, item);
		if (parsed !== undefined) out.push(parsed);
	}
	return out;
}

function statusJson(status: FanoutStatusRecord | undefined): JsonObject {
	return status === undefined
		? {}
		: { status: encode(FanoutStatusRecordSchema, status) };
}

function departureName(action: DepartureAction): string {
	return DepartureAction[action] ?? "UNSPECIFIED";
}

function departureOf(value: JsonValue | undefined): DepartureAction {
	const name = jsonString(value);
	const found = Object.entries(DepartureAction).find(
		([key, entry]) => key === name && typeof entry === "number",
	);
	const action = found?.[1];
	return typeof action === "number" ? action : DepartureAction.UNSPECIFIED;
}

// ── Started ────────────────────────────────────────────────────────────────
export function startedBody(fact: StartedFact): JsonObject {
	return {
		fanoutId: fact.fanoutId,
		pipeline: fact.pipeline,
		node: fact.node,
		freightId: fact.freightId,
		decision: encode(PlacementDecisionRecordSchema, fact.decision),
		fanout: encode(FanoutRecordSchema, fact.fanout),
		departure: departureName(fact.departure),
		windows: [...fact.windows],
		idempotencyKey: fact.idempotencyKey,
		departing: [...fact.departing],
		atMs: fact.atMs,
	};
}

export function parseStarted(value: unknown): StartedFact | undefined {
	if (!isJsonObject(value)) return undefined;
	const decision = decode(PlacementDecisionRecordSchema, value.decision);
	const fanout = decode(FanoutRecordSchema, value.fanout);
	const fanoutId = jsonString(value.fanoutId);
	if (decision === undefined || fanout === undefined || fanoutId === "")
		return undefined;
	return {
		fanoutId,
		pipeline: jsonString(value.pipeline),
		node: jsonString(value.node),
		freightId: jsonString(value.freightId),
		decision,
		fanout,
		departure: departureOf(value.departure),
		windows: jsonStrings(value.windows),
		idempotencyKey: jsonString(value.idempotencyKey),
		departing: jsonStrings(value.departing),
		atMs: jsonNumber(value.atMs),
	};
}

// ── Progressed ─────────────────────────────────────────────────────────────
export function progressedBody(fact: ProgressedFact): JsonObject {
	return {
		campId: fact.campId,
		outcome: fact.outcome,
		promotionId: fact.promotionId,
		catchUp: fact.catchUp,
		reasons: reasonsJson(fact.reasons),
		atMs: fact.atMs,
		...statusJson(fact.status),
	};
}

export function parseProgressed(
	value: unknown,
): ProgressedFact | undefined {
	if (!isJsonObject(value)) return undefined;
	const outcome = jsonString(value.outcome);
	if (!OUTCOMES.has(outcome)) return undefined;
	return {
		campId: jsonString(value.campId),
		// SAFETY: membership in OUTCOMES was checked above.
		outcome: outcome as SlotOutcome,
		promotionId: jsonString(value.promotionId),
		catchUp: value.catchUp === true,
		reasons: reasonsOf(value.reasons),
		atMs: jsonNumber(value.atMs),
		status: decode(FanoutStatusRecordSchema, value.status),
	};
}

// ── Halted / Resumed / Completed / RolledBack ─────────────────────────────
export function haltedBody(fact: HaltedFact): JsonObject {
	return {
		reason: encode(ReasonRecordSchema, fact.reason),
		atMs: fact.atMs,
		...statusJson(fact.status),
	};
}

export function parseHalted(value: unknown): HaltedFact | undefined {
	if (!isJsonObject(value)) return undefined;
	const parsed = decode(ReasonRecordSchema, value.reason);
	if (parsed === undefined) return undefined;
	return {
		reason: parsed,
		atMs: jsonNumber(value.atMs),
		status: decode(FanoutStatusRecordSchema, value.status),
	};
}

export function resumedBody(fact: ResumedFact): JsonObject {
	return { baseline: fact.baseline, atMs: fact.atMs, ...statusJson(fact.status) };
}

export function parseResumed(value: unknown): ResumedFact | undefined {
	if (!isJsonObject(value)) return undefined;
	return {
		baseline: jsonNumber(value.baseline),
		atMs: jsonNumber(value.atMs),
		status: decode(FanoutStatusRecordSchema, value.status),
	};
}

export function statusBody(fact: StatusFact): JsonObject {
	return {
		atMs: fact.atMs,
		campIds: [...fact.campIds],
		reasons: reasonsJson(fact.reasons),
		...statusJson(fact.status),
	};
}

export function parseStatusFact(value: unknown): StatusFact {
	const body = jsonObject(value);
	return {
		atMs: jsonNumber(body.atMs),
		campIds: jsonStrings(body.campIds),
		reasons: reasonsOf(body.reasons),
		status: decode(FanoutStatusRecordSchema, body.status),
	};
}

// ── camp.Departed ──────────────────────────────────────────────────────────
export function departedBody(fact: DepartedFact): JsonObject {
	return {
		fanoutId: fact.fanoutId,
		campId: fact.campId,
		action: departureName(fact.action),
		promotionId: fact.promotionId,
		kept: [...fact.kept],
		reasons: reasonsJson(fact.reasons),
		atMs: fact.atMs,
	};
}

export function parseDeparted(value: unknown): DepartedFact | undefined {
	if (!isJsonObject(value)) return undefined;
	const campId = jsonString(value.campId);
	if (campId === "") return undefined;
	return {
		fanoutId: jsonString(value.fanoutId),
		campId,
		action: departureOf(value.action),
		promotionId: jsonString(value.promotionId),
		kept: jsonStrings(value.kept),
		reasons: reasonsOf(value.reasons),
		atMs: jsonNumber(value.atMs),
	};
}

// ── failover bodies (read by the fan-out's effective-decision view) ───────
export type FailoverFact = Readonly<{
	failover: FailoverRecord;
	stationId: string;
	rebalanceId: string;
	approved: boolean;
	approvedBy: string;
	decisionId: string;
	atMs: number;
}>;

export function failoverBody(fact: FailoverFact): JsonObject {
	return {
		failover: encode(FailoverRecordSchema, fact.failover),
		stationId: fact.stationId,
		rebalanceId: fact.rebalanceId,
		approved: fact.approved,
		approvedBy: fact.approvedBy,
		decisionId: fact.decisionId,
		atMs: fact.atMs,
	};
}

export function parseFailoverFact(
	value: unknown,
): FailoverFact | undefined {
	if (!isJsonObject(value)) return undefined;
	const failover = decode(FailoverRecordSchema, value.failover);
	if (failover === undefined || failover.failoverId === "") return undefined;
	return {
		failover,
		stationId: jsonString(value.stationId),
		rebalanceId: jsonString(value.rebalanceId),
		approved: value.approved === true,
		approvedBy: jsonString(value.approvedBy),
		decisionId: jsonString(value.decisionId),
		atMs: jsonNumber(value.atMs),
	};
}
