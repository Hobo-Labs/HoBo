// Pure folds (materialized views) over the per-Camp streams. Desired state is
// the fold of `cd-camp-<id>` (spec); observations fold from
// `cd-camp-status-<id>` (status). Replay of the same journal always yields the
// same projection (I8).
import type { EventEnvelope } from "@hobo/core";
import type {
	CampManagement,
	DeltaDecisionRecord,
	PolicyBindingRecord,
	ReconcileObservationRecord,
} from "../_generated/cd_pb.js";
import { CD_EVENTS } from "../events.js";
import {
	managementOf,
	type ParsedDelta,
	type ParsedSet,
	parseDecision,
	parseDelta,
	parseObservation,
	parsePolicyBinding,
	parseSet,
} from "./codec.js";
import { DesiredStateError } from "./errors.js";

export type DeltaStatus = "open" | "applied" | "rejected";

export type DeltaEntry = Readonly<{
	record: ParsedDelta;
	status: DeltaStatus;
	decision?: DeltaDecisionRecord;
}>;

export type CampSpecState = Readonly<{
	campId: string;
	/** Seq of the last folded event; the expected version for the next append. */
	seq: number;
	current?: ParsedSet;
	/** Oldest first. */
	sets: readonly ParsedSet[];
	deltas: ReadonlyMap<string, DeltaEntry>;
	openDeltaId?: string;
	policy?: PolicyBindingRecord;
	management?: CampManagement;
}>;

export function emptyCampSpec(campId: string): CampSpecState {
	return Object.freeze({
		campId,
		seq: 0,
		sets: Object.freeze([]),
		deltas: new Map(),
	});
}

function corrupt(
	state: CampSpecState,
	event: EventEnvelope,
	message: string,
): never {
	throw new DesiredStateError(
		"journal-invalid",
		`${event.streamId}@${event.seq} ${event.type}: ${message}`,
		state.campId,
	);
}

function sameCamp(
	state: CampSpecState,
	event: EventEnvelope,
	campId: string,
): void {
	if (campId !== state.campId)
		corrupt(
			state,
			event,
			`recorded for camp ${campId}, expected camp ${state.campId}`,
		);
}

/** Reducer for one spec-stream event. Unknown event types are carried over unchanged. */
export function applyCampSpecEvent(
	state: CampSpecState,
	event: EventEnvelope,
): CampSpecState {
	const next = { ...state, seq: event.seq };
	switch (event.type) {
		case CD_EVENTS.SetCreated: {
			const set = parseSet(event.data);
			sameCamp(state, event, set.campId);
			const expected = state.current?.setId ?? "";
			if (set.predecessorSetId !== expected) {
				corrupt(
					state,
					event,
					`predecessor ${set.predecessorSetId || "<none>"} is not the current Set ${expected || "<none>"}`,
				);
			}
			return Object.freeze({
				...next,
				current: set,
				sets: Object.freeze([...state.sets, set]),
			});
		}
		case CD_EVENTS.DeltaOpened: {
			const delta = parseDelta(event.data);
			sameCamp(state, event, delta.campId);
			if (
				state.openDeltaId !== undefined &&
				state.openDeltaId !== delta.deltaId
			) {
				corrupt(state, event, `overlapping open delta ${state.openDeltaId}`);
			}
			if (delta.baseSetId !== (state.current?.setId ?? "")) {
				corrupt(
					state,
					event,
					`base ${delta.baseSetId || "<none>"} is not the current Set`,
				);
			}
			const deltas = new Map(state.deltas);
			deltas.set(
				delta.deltaId,
				Object.freeze({ record: delta, status: "open" }),
			);
			return Object.freeze({ ...next, deltas, openDeltaId: delta.deltaId });
		}
		case CD_EVENTS.DeltaUpdated: {
			const delta = parseDelta(event.data);
			sameCamp(state, event, delta.campId);
			const entry = state.deltas.get(delta.deltaId);
			if (!entry)
				corrupt(
					state,
					event,
					`delta.Updated for ${delta.deltaId} before delta.Opened`,
				);
			if (entry.status !== "open")
				corrupt(state, event, `delta ${delta.deltaId} is ${entry.status}`);
			const deltas = new Map(state.deltas);
			deltas.set(
				delta.deltaId,
				Object.freeze({ record: delta, status: "open" }),
			);
			return Object.freeze({ ...next, deltas });
		}
		case CD_EVENTS.DeltaApplied:
		case CD_EVENTS.DeltaRejected: {
			const decision = parseDecision(event.data);
			const entry = state.deltas.get(decision.deltaId);
			if (!entry)
				corrupt(
					state,
					event,
					`${event.type} for ${decision.deltaId} before delta.Opened`,
				);
			if (entry.status !== "open")
				corrupt(
					state,
					event,
					`delta ${decision.deltaId} is already ${entry.status}`,
				);
			const status: DeltaStatus =
				event.type === CD_EVENTS.DeltaApplied ? "applied" : "rejected";
			const deltas = new Map(state.deltas);
			deltas.set(
				decision.deltaId,
				Object.freeze({ record: entry.record, status, decision }),
			);
			const { openDeltaId: _closed, ...rest } = next;
			return Object.freeze({ ...rest, deltas });
		}
		case CD_EVENTS.PolicyBindingChanged: {
			const policy = parsePolicyBinding(event.data);
			if (policy.campId !== "") sameCamp(state, event, policy.campId);
			return Object.freeze({ ...next, policy });
		}
		case CD_EVENTS.CampManagementChanged: {
			const management = managementOf(event.data);
			return Object.freeze(
				management === undefined ? next : { ...next, management },
			);
		}
		default:
			return Object.freeze(next);
	}
}

export function foldCampSpec(
	campId: string,
	events: Iterable<EventEnvelope>,
): CampSpecState {
	let state = emptyCampSpec(campId);
	for (const event of events) state = applyCampSpecEvent(state, event);
	return state;
}

const STATUS_TYPES: ReadonlySet<string> = new Set([
	CD_EVENTS.ReconcileStarted,
	CD_EVENTS.StatusObserved,
	CD_EVENTS.Converged,
	CD_EVENTS.ReconcileBlocked,
]);

/** The decimal FenceToken (cd.proto), or undefined when it is malformed. */
function fenceOf(observation: ReconcileObservationRecord): bigint | undefined {
	return /^(0|[1-9]\d*)$/.test(observation.fenceToken)
		? BigInt(observation.fenceToken)
		: undefined;
}

/**
 * Latest observation on a status stream. An observation carrying a fence lower
 * than one already seen came from a superseded lease holder and is ignored (I4).
 * An observation whose fence is not a decimal FenceToken is ignored too
 * (fail-closed): it cannot prove it holds the lease.
 */
export function foldCampStatus(
	events: Iterable<EventEnvelope>,
): ReconcileObservationRecord | undefined {
	let latest: ReconcileObservationRecord | undefined;
	let fence = 0n;
	for (const event of events) {
		if (!STATUS_TYPES.has(event.type)) continue;
		const observation = parseObservation(event.data);
		const token = fenceOf(observation);
		if (token === undefined || token < fence) continue;
		fence = token;
		latest = observation;
	}
	return latest;
}

/** Management carried on the inventory stream (WP22 writes it); last one wins. */
export function foldManagement(
	events: Iterable<EventEnvelope>,
): CampManagement | undefined {
	let management: CampManagement | undefined;
	for (const event of events) {
		const value = managementOf(event.data);
		if (value !== undefined) management = value;
	}
	return management;
}
