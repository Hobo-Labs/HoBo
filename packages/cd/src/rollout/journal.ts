// The rollout ledger: stream `cd-rollout-<rolloutId>`, its event bodies and the
// pure fold that rebuilds a rollout from it. The stream is the whole truth; the
// orchestrator's memory is a cache, so replay reads exactly what the live
// orchestrator decided from (I8) and a crash anywhere resumes by observation.
//
//   rollout.Lowered               plan, Freight, windows, obligations (D7)
//   cd.rollout.Started            run() accepted the plan; the ramp engine started
//   cd.rollout.CapacityReserved   canary capacity reserved for one Camp
//   cd.rollout.ShiftRequested     intent recorded BEFORE the Station cutover
//   cd.rollout.Shifted            the cutover's acknowledgement (never convergence)
//   cd.rollout.TrafficObserved    observed routing is the requested split
//   cd.rollout.VerificationStarted / StageVerified
//   cd.rollout.ApprovalRequested  a stage-boundary approval request
//   cd.rollout.Held / Released    a boundary hold (window, experiment, approval)
//   cd.rollout.Advanced           the ramp engine accepted a stage outcome
//   cd.rollout.RollbackStarted / RollbackDeltaOpened (D12)
//   cd.rollout.Finished           promoted | rolled-back | failed
//
// The stream id and private event names are local to this module (the
// frozen CD_STREAMS has no rollout entry; see the WP10 report).
import {
	create,
	fromJson,
	type JsonObject,
	type JsonValue,
	toJson,
} from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import {
	type ObligationRef,
	ObligationRefSchema,
	type ReasonRecord,
	ReasonRecordSchema,
	type RolloutPlanRecord,
	RolloutPlanRecordSchema,
	VerificationVerdict,
} from "../_generated/cd_pb.js";
import { CD_EVENTS } from "../events.js";
import type { CampId, FreightId, RolloutId, VerificationId } from "../ports.js";
import {
	isJsonArray,
	isJsonObject,
	jsonOf,
	num,
	objectOf,
	strings,
	text,
} from "./json.js";

// public-contract: the rollout ledger stream and its private event names.
export const ROLLOUT_LEDGER = Object.freeze({
	stream: (rolloutId: string) => `cd-rollout-${rolloutId}`,
	started: "cd.rollout.Started",
	capacityReserved: "cd.rollout.CapacityReserved",
	shiftRequested: "cd.rollout.ShiftRequested",
	shifted: "cd.rollout.Shifted",
	trafficObserved: "cd.rollout.TrafficObserved",
	verificationStarted: "cd.rollout.VerificationStarted",
	stageVerified: "cd.rollout.StageVerified",
	approvalRequested: "cd.rollout.ApprovalRequested",
	held: "cd.rollout.Held",
	released: "cd.rollout.Released",
	advanced: "cd.rollout.Advanced",
	rollbackStarted: "cd.rollout.RollbackStarted",
	rollbackDeltaOpened: "cd.rollout.RollbackDeltaOpened",
	finished: "cd.rollout.Finished",
} as const);

export type ShiftPhase = "stage" | "rollback";
export type VerificationPhase = "idle" | "stage";
export type FinishedStatus = "promoted" | "rolled-back" | "failed";

export type ShiftRecord = Readonly<{
	planId: string;
	percent: number;
	requestedAtMs: number;
	acknowledged?: Readonly<{ planId: string; realized: string; notes: readonly string[] }>;
	observed: boolean;
}>;

export type CampStageState = Readonly<{
	shift?: ShiftRecord;
	idleVerificationId?: string;
	idleVerdict?: VerificationVerdict;
	verificationId?: string;
	verdict?: VerificationVerdict;
	approvalRequestId?: string;
	advanced: boolean;
}>;

export type RollbackState = Readonly<{
	reason: ReasonRecord;
	startedAtMs: number;
	zero: ReadonlyMap<string, ShiftRecord>;
	deltas: ReadonlyMap<string, string>;
	/** Camps that need no rollback Delta, with why (no-predecessor | not-applied). */
	settled: ReadonlyMap<string, string>;
}>;

export type RolloutLedgerState = Readonly<{
	rolloutId: RolloutId;
	plan: RolloutPlanRecord;
	freightId: FreightId;
	windows: readonly string[];
	obligations: readonly ObligationRef[];
	plannedAtMs: number;
	refused: boolean;
	startedAtMs?: number;
	capacity: ReadonlyMap<string, string>;
	stages: ReadonlyMap<string, CampStageState>;
	/** Possible exposure per Camp: the last requested stage percent unless the shift had no effect. */
	exposure: ReadonlyMap<string, number>;
	/** Last stage percent per Camp that observation confirmed. */
	observedExposure: ReadonlyMap<string, number>;
	hold?: ReasonRecord;
	rollback?: RollbackState;
	finished?: Readonly<{ status: FinishedStatus; reasons: readonly ReasonRecord[] }>;
	/** Time of the last recorded step; observation deadlines run from here. */
	lastProgressAtMs: number;
	/** Stream revision, for the expected-seq CAS on the next append. */
	seq: number;
}>;

export function stageKey(campId: string, stageIndex: number): string {
	return `${campId}#${stageIndex}`;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function msOf(value: JsonValue | undefined): number | undefined {
	const ms = Date.parse(text(value));
	return Number.isFinite(ms) ? ms : undefined;
}

function reasonJson(record: ReasonRecord): JsonValue {
	return toJson(ReasonRecordSchema, record);
}

function decode<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

function reasonOf(value: JsonValue | undefined): ReasonRecord | undefined {
	return isJsonObject(value)
		? decode(() => fromJson(ReasonRecordSchema, value))
		: undefined;
}

function reasonsOf(value: JsonValue | undefined): readonly ReasonRecord[] {
	if (!isJsonArray(value)) return [];
	const out: ReasonRecord[] = [];
	for (const item of value) {
		const parsed = reasonOf(item);
		if (parsed) out.push(parsed);
	}
	return out;
}

function verdictOf(value: JsonValue | undefined): VerificationVerdict {
	const name = text(value);
	if (name === "VERIFICATION_VERDICT_PASS") return VerificationVerdict.PASS;
	if (name === "VERIFICATION_VERDICT_FAIL") return VerificationVerdict.FAIL;
	if (name === "VERIFICATION_VERDICT_INCONCLUSIVE")
		return VerificationVerdict.INCONCLUSIVE;
	return VerificationVerdict.UNSPECIFIED;
}

export function verdictName(verdict: VerificationVerdict): string {
	return `VERIFICATION_VERDICT_${VerificationVerdict[verdict]}`;
}

// ── Bodies ─────────────────────────────────────────────────────────────────

export function loweredBody(
	input: Readonly<{
		plan: RolloutPlanRecord;
		freightId: FreightId;
		windows: readonly string[];
		obligations: readonly ObligationRef[];
		atMs: number;
		refused: boolean;
	}>,
): JsonObject {
	return {
		plan: toJson(RolloutPlanRecordSchema, input.plan),
		freightId: input.freightId,
		windows: [...input.windows],
		obligations: input.obligations.map((o) => toJson(ObligationRefSchema, o)),
		refused: input.refused,
		at: iso(input.atMs),
	};
}

export const bodies = Object.freeze({
	started: (atMs: number): JsonObject => ({ at: iso(atMs) }),
	capacityReserved: (campId: string, reservationId: string, atMs: number): JsonObject => ({
		campId,
		reservationId,
		at: iso(atMs),
	}),
	shiftRequested: (
		input: Readonly<{ campId: string; stageIndex: number; phase: ShiftPhase; percent: number; planId: string; atMs: number }>,
	): JsonObject => ({
		campId: input.campId,
		stageIndex: input.stageIndex,
		phase: input.phase,
		percent: input.percent,
		planId: input.planId,
		at: iso(input.atMs),
	}),
	shifted: (
		input: Readonly<{ campId: string; stageIndex: number; phase: ShiftPhase; planId: string; realized: string; notes: readonly string[]; atMs: number }>,
	): JsonObject => ({
		campId: input.campId,
		stageIndex: input.stageIndex,
		phase: input.phase,
		planId: input.planId,
		realized: input.realized,
		notes: [...input.notes],
		at: iso(input.atMs),
	}),
	trafficObserved: (
		input: Readonly<{ campId: string; stageIndex: number; phase: ShiftPhase; planId: string; atMs: number }>,
	): JsonObject => ({
		campId: input.campId,
		stageIndex: input.stageIndex,
		phase: input.phase,
		planId: input.planId,
		at: iso(input.atMs),
	}),
	verificationStarted: (
		input: Readonly<{ campId: string; stageIndex: number; phase: VerificationPhase; verificationId: string; atMs: number }>,
	): JsonObject => ({
		campId: input.campId,
		stageIndex: input.stageIndex,
		phase: input.phase,
		verificationId: input.verificationId,
		at: iso(input.atMs),
	}),
	stageVerified: (
		input: Readonly<{ campId: string; stageIndex: number; phase: VerificationPhase; verificationId: string; verdict: VerificationVerdict; atMs: number }>,
	): JsonObject => ({
		campId: input.campId,
		stageIndex: input.stageIndex,
		phase: input.phase,
		verificationId: input.verificationId,
		verdict: verdictName(input.verdict),
		at: iso(input.atMs),
	}),
	approvalRequested: (campId: string, stageIndex: number, requestId: string, atMs: number): JsonObject => ({
		campId,
		stageIndex,
		requestId,
		at: iso(atMs),
	}),
	held: (hold: ReasonRecord, atMs: number): JsonObject => ({
		reason: reasonJson(hold),
		at: iso(atMs),
	}),
	released: (atMs: number): JsonObject => ({ at: iso(atMs) }),
	advanced: (campId: string, stageIndex: number, atMs: number): JsonObject => ({
		campId,
		stageIndex,
		at: iso(atMs),
	}),
	rollbackStarted: (why: ReasonRecord, atMs: number): JsonObject => ({
		reason: reasonJson(why),
		at: iso(atMs),
	}),
	rollbackDeltaOpened: (campId: string, deltaId: string, why: string, atMs: number): JsonObject => ({
		campId,
		deltaId,
		why,
		at: iso(atMs),
	}),
	finished: (status: FinishedStatus, reasons: readonly ReasonRecord[], atMs: number): JsonObject => ({
		status,
		reasons: reasons.map(reasonJson),
		at: iso(atMs),
	}),
});

// ── Fold ───────────────────────────────────────────────────────────────────

function decodeLowered(
	data: JsonObject,
	rolloutId: RolloutId,
	seq: number,
): RolloutLedgerState | undefined {
	const plannedAtMs = msOf(data.at);
	const planJson = objectOf(data.plan);
	const plan = planJson ? decode(() => fromJson(RolloutPlanRecordSchema, planJson)) : undefined;
	if (plannedAtMs === undefined || !plan || plan.rolloutId !== rolloutId)
		return undefined;
	const obligations: ObligationRef[] = [];
	if (isJsonArray(data.obligations))
		for (const item of data.obligations) {
			const parsed = isJsonObject(item)
				? decode(() => fromJson(ObligationRefSchema, item))
				: undefined;
			if (parsed) obligations.push(parsed);
		}
	return {
		rolloutId,
		plan,
		// SAFETY: read back from a Lowered body this orchestrator wrote.
		freightId: text(data.freightId) as FreightId,
		windows: strings(data.windows),
		obligations,
		plannedAtMs,
		refused: data.refused === true,
		capacity: new Map(),
		stages: new Map(),
		exposure: new Map(),
		observedExposure: new Map(),
		lastProgressAtMs: plannedAtMs,
		seq,
	};
}

function withStage(
	state: RolloutLedgerState,
	campId: string,
	stageIndex: number,
	update: (prev: CampStageState) => CampStageState,
): RolloutLedgerState {
	const key = stageKey(campId, stageIndex);
	const stages = new Map(state.stages);
	stages.set(key, update(stages.get(key) ?? { advanced: false }));
	return { ...state, stages };
}

function withRollback(
	state: RolloutLedgerState,
	update: (prev: RollbackState) => RollbackState,
): RolloutLedgerState {
	return state.rollback ? { ...state, rollback: update(state.rollback) } : state;
}

function applyShift(
	state: RolloutLedgerState,
	data: JsonObject,
	update: (prev: ShiftRecord | undefined) => ShiftRecord | undefined,
): RolloutLedgerState {
	const campId = text(data.campId);
	const stageIndex = num(data.stageIndex) ?? 0;
	if (text(data.phase) === "rollback")
		return withRollback(state, (rollback) => {
			const zero = new Map(rollback.zero);
			const next = update(zero.get(campId));
			if (next) zero.set(campId, next);
			return { ...rollback, zero };
		});
	return withStage(state, campId, stageIndex, (prev) => {
		const shift = update(prev.shift);
		return shift ? { ...prev, shift } : prev;
	});
}

function step(
	state: RolloutLedgerState,
	event: EventEnvelope,
): RolloutLedgerState {
	const data = objectOf(jsonOf(event.data));
	if (!data) return { ...state, seq: event.seq };
	const atMs = msOf(data.at) ?? state.lastProgressAtMs;
	const campId = text(data.campId);
	const stageIndex = num(data.stageIndex) ?? 0;
	const next = ((): RolloutLedgerState => {
		switch (event.type) {
			case ROLLOUT_LEDGER.started:
				return { ...state, startedAtMs: atMs };
			case ROLLOUT_LEDGER.capacityReserved: {
				const capacity = new Map(state.capacity);
				capacity.set(campId, text(data.reservationId));
				return { ...state, capacity };
			}
			case ROLLOUT_LEDGER.shiftRequested: {
				const percent = num(data.percent) ?? 0;
				const shifted = applyShift(state, data, () => ({
					planId: text(data.planId),
					percent,
					requestedAtMs: atMs,
					observed: false,
				}));
				if (text(data.phase) === "rollback") return shifted;
				const exposure = new Map(shifted.exposure);
				exposure.set(campId, percent);
				return { ...shifted, exposure };
			}
			case ROLLOUT_LEDGER.shifted: {
				const acked = applyShift(state, data, (prev) =>
					prev
						? {
								...prev,
								acknowledged: {
									planId: text(data.planId),
									realized: text(data.realized),
									notes: strings(data.notes),
								},
							}
						: undefined,
				);
				// A shift realized "none" changed nothing: exposure stays at the last observed split.
				if (text(data.phase) === "rollback" || text(data.realized) !== "none") return acked;
				const exposure = new Map(acked.exposure);
				exposure.set(campId, acked.observedExposure.get(campId) ?? 0);
				return { ...acked, exposure };
			}
			case ROLLOUT_LEDGER.trafficObserved: {
				const observed = applyShift(state, data, (prev) =>
					prev ? { ...prev, observed: true } : undefined,
				);
				if (text(data.phase) === "rollback") return observed;
				const percent = observed.stages.get(stageKey(campId, stageIndex))?.shift?.percent ?? 0;
				const observedExposure = new Map(observed.observedExposure);
				observedExposure.set(campId, percent);
				return { ...observed, observedExposure };
			}
			case ROLLOUT_LEDGER.verificationStarted:
				return withStage(state, campId, stageIndex, (prev) =>
					text(data.phase) === "idle"
						? { ...prev, idleVerificationId: text(data.verificationId) }
						: { ...prev, verificationId: text(data.verificationId) },
				);
			case ROLLOUT_LEDGER.stageVerified:
				return withStage(state, campId, stageIndex, (prev) =>
					text(data.phase) === "idle"
						? { ...prev, idleVerdict: verdictOf(data.verdict) }
						: { ...prev, verdict: verdictOf(data.verdict) },
				);
			case ROLLOUT_LEDGER.approvalRequested:
				return withStage(state, campId, stageIndex, (prev) => ({
					...prev,
					approvalRequestId: text(data.requestId),
				}));
			case ROLLOUT_LEDGER.held: {
				const hold = reasonOf(data.reason);
				return hold ? { ...state, hold } : state;
			}
			case ROLLOUT_LEDGER.released: {
				const { hold: _released, ...rest } = state;
				return rest;
			}
			case ROLLOUT_LEDGER.advanced:
				return withStage(state, campId, stageIndex, (prev) => ({
					...prev,
					advanced: true,
				}));
			case ROLLOUT_LEDGER.rollbackStarted: {
				if (state.rollback) return state;
				const why =
					reasonOf(data.reason) ?? create(ReasonRecordSchema, { code: "rollback-requested" });
				const { hold: _cleared, ...rest } = state;
				return {
					...rest,
					rollback: {
						reason: why,
						startedAtMs: atMs,
						zero: new Map(),
						deltas: new Map(),
						settled: new Map(),
					},
				};
			}
			case ROLLOUT_LEDGER.rollbackDeltaOpened:
				return withRollback(state, (rollback) => {
					const deltaId = text(data.deltaId);
					if (deltaId === "") {
						const settled = new Map(rollback.settled);
						settled.set(campId, text(data.why) || "not-applied");
						return { ...rollback, settled };
					}
					const deltas = new Map(rollback.deltas);
					deltas.set(campId, deltaId);
					return { ...rollback, deltas };
				});
			case ROLLOUT_LEDGER.finished: {
				const status = text(data.status);
				if (status !== "promoted" && status !== "rolled-back" && status !== "failed")
					return state;
				return { ...state, finished: { status, reasons: reasonsOf(data.reasons) } };
			}
			default:
				return state;
		}
	})();
	return { ...next, lastProgressAtMs: atMs, seq: event.seq };
}

/** Fold a cd-rollout stream; undefined when it has no rollout.Lowered event. */
export function foldRollout(
	rolloutId: RolloutId,
	events: Iterable<EventEnvelope>,
): RolloutLedgerState | undefined {
	let state: RolloutLedgerState | undefined;
	for (const event of events) {
		if (event.type === CD_EVENTS.RolloutLowered) {
			const data = objectOf(jsonOf(event.data));
			if (!state && data) state = decodeLowered(data, rolloutId, event.seq);
			continue;
		}
		if (state) state = step(state, event);
	}
	return state;
}

/** A Camp id read back from a plan record or ledger body this orchestrator wrote. */
export function asCamp(value: string): CampId {
	// SAFETY: Camp ids in rollout records come from the promotion's target_camp_ids.
	return value as CampId;
}

/** A verification id read back from a ledger body this orchestrator wrote. */
export function asVerification(value: string): VerificationId {
	// SAFETY: the id was returned by VerificationEngine.start and recorded verbatim.
	return value as VerificationId;
}
