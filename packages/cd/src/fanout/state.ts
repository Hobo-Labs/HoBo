// The fan-out projection: one fold over `cd-fanout-<id>` rebuilds the whole
// run (I8: replay equals live). The controller applies each fact it appends
// through the same reducer, so the live view and a replayed view never differ.
import { create } from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import {
	type DepartureAction,
	type FanoutRecord,
	FanoutState,
	type FanoutStatusRecord,
	FanoutStatusRecordSchema,
	type PlacementDecisionRecord,
	type ReasonRecord,
} from "../_generated/cd_pb.js";
import { CD_EVENTS } from "../events.js";
import {
	parseDeparted,
	parseHalted,
	parseProgressed,
	parseResumed,
	parseStarted,
	parseStatusFact,
} from "./facts.js";
import { iso } from "./journal.js";
import { type FanoutPlan, parseFanoutPlan } from "./policy.js";
import { type SlotState, schedule } from "./schedule.js";

export type Slot = {
	readonly campId: string;
	state: SlotState;
	promotionId: string;
	requestedAtMs: number;
	catchUp: boolean;
	rolledBack: boolean;
	reasons: readonly ReasonRecord[];
};

export type FanoutView = {
	readonly fanoutId: string;
	readonly pipeline: string;
	readonly node: string;
	readonly freightId: string;
	readonly decision: PlacementDecisionRecord;
	readonly fanout: FanoutRecord;
	readonly plan: FanoutPlan;
	readonly departure: DepartureAction;
	readonly windows: readonly string[];
	readonly departing: readonly string[];
	readonly startedAtMs: number;
	/** The Started event; the saga's trigger. */
	readonly trigger: EventEnvelope;
	state: FanoutState;
	slots: Map<string, Slot>;
	/** Failures already counted when the last resume was granted. */
	baseline: number;
	supersedeRequested: boolean;
	departed: Set<string>;
	reasons: ReasonRecord[];
	updatedAtMs: number;
	/** Stream revision (seq of the last event folded). */
	seq: number;
};

const TERMINAL: ReadonlySet<FanoutState> = new Set([
	FanoutState.ROLLED_BACK,
	FanoutState.SUPERSEDED,
]);

export function isTerminal(view: FanoutView): boolean {
	return TERMINAL.has(view.state);
}

/** RUNNING or HALTED: holds the node and blocks a newer fan-out from starting. */
export function isActive(view: FanoutView): boolean {
	return (
		view.state === FanoutState.RUNNING || view.state === FanoutState.HALTED
	);
}

function begin(event: EventEnvelope): FanoutView | undefined {
	const started = parseStarted(event.data);
	if (started === undefined) return undefined;
	const plan = parseFanoutPlan({
		pipeline: started.pipeline,
		node: started.node,
		decision: started.decision,
		fanout: started.fanout,
	});
	if (!plan.ok) return undefined;
	const slots = new Map<string, Slot>();
	for (const campId of plan.value.campIds)
		slots.set(campId, {
			campId,
			state: "pending",
			promotionId: "",
			requestedAtMs: 0,
			catchUp: false,
			rolledBack: false,
			reasons: [],
		});
	return {
		fanoutId: started.fanoutId,
		pipeline: started.pipeline,
		node: started.node,
		freightId: started.freightId,
		decision: started.decision,
		fanout: started.fanout,
		plan: plan.value,
		departure: started.departure,
		windows: started.windows,
		departing: started.departing,
		startedAtMs: started.atMs,
		trigger: event,
		state: FanoutState.RUNNING,
		slots,
		baseline: 0,
		supersedeRequested: false,
		departed: new Set(),
		reasons: [],
		updatedAtMs: started.atMs,
		seq: event.seq,
	};
}

/** Apply one fact. Unknown or unparseable bodies change nothing but the revision. */
export function apply(
	view: FanoutView,
	type: string,
	data: unknown,
	seq: number,
): void {
	view.seq = seq;
	switch (type) {
		case CD_EVENTS.FanoutProgressed: {
			const fact = parseProgressed(data);
			if (fact === undefined) return;
			view.updatedAtMs = Math.max(view.updatedAtMs, fact.atMs);
			if (fact.outcome === "supersede-requested") {
				view.supersedeRequested = true;
				return;
			}
			const slot = view.slots.get(fact.campId);
			if (slot === undefined) return;
			switch (fact.outcome) {
				case "requested":
					slot.state = "in-flight";
					slot.requestedAtMs = fact.atMs;
					slot.promotionId = fact.promotionId;
					slot.catchUp = fact.catchUp;
					slot.rolledBack = false;
					break;
				case "bound":
					slot.promotionId = fact.promotionId;
					break;
				case "rolled-back":
					slot.rolledBack = true;
					break;
				default:
					slot.state = fact.outcome;
			}
			slot.reasons = fact.reasons;
			return;
		}
		case CD_EVENTS.FanoutHalted: {
			const fact = parseHalted(data);
			if (fact === undefined) return;
			view.state = FanoutState.HALTED;
			view.reasons = [fact.reason];
			view.updatedAtMs = Math.max(view.updatedAtMs, fact.atMs);
			return;
		}
		case CD_EVENTS.FanoutResumed: {
			const fact = parseResumed(data);
			if (fact === undefined) return;
			view.state = FanoutState.RUNNING;
			view.baseline = fact.baseline;
			view.reasons = [];
			view.updatedAtMs = Math.max(view.updatedAtMs, fact.atMs);
			return;
		}
		case CD_EVENTS.FanoutCompleted: {
			const fact = parseStatusFact(data);
			view.state = fact.status?.state ?? FanoutState.COMPLETED;
			view.reasons = [...fact.reasons];
			view.updatedAtMs = Math.max(view.updatedAtMs, fact.atMs);
			return;
		}
		case CD_EVENTS.FanoutRolledBack: {
			const fact = parseStatusFact(data);
			view.state = FanoutState.ROLLED_BACK;
			for (const campId of fact.campIds) {
				const slot = view.slots.get(campId);
				if (slot !== undefined) slot.rolledBack = true;
			}
			view.reasons = [...fact.reasons];
			view.updatedAtMs = Math.max(view.updatedAtMs, fact.atMs);
			return;
		}
		case CD_EVENTS.CampDeparted: {
			const fact = parseDeparted(data);
			if (fact !== undefined) view.departed.add(fact.campId);
			return;
		}
		default:
			return;
	}
}

export function fold(events: readonly EventEnvelope[]): FanoutView | undefined {
	const first = events[0];
	if (first === undefined || first.type !== CD_EVENTS.FanoutStarted)
		return undefined;
	const view = begin(first);
	if (view === undefined) return undefined;
	for (const event of events.slice(1))
		apply(view, event.type, event.data, event.seq);
	return view;
}

/** Slots in run order with one state each. */
export function campsIn(view: FanoutView, state: Slot["state"]): string[] {
	return view.plan.campIds.filter(
		(campId) => view.slots.get(campId)?.state === state,
	);
}

export function statusOf(view: FanoutView): FanoutStatusRecord {
	const plan = schedule(view.plan, view.slots, {
		halted: view.state !== FanoutState.RUNNING,
		catchUp: false,
	});
	return create(FanoutStatusRecordSchema, {
		fanoutId: view.fanoutId,
		pipeline: view.pipeline,
		node: view.node,
		freightId: view.freightId,
		decisionId: view.decision.decisionId,
		state: view.state,
		groupIndex: plan.groupIndex,
		pending: campsIn(view, "pending"),
		inFlight: campsIn(view, "in-flight"),
		succeeded: campsIn(view, "succeeded"),
		failed: campsIn(view, "failed"),
		deferred: campsIn(view, "deferred"),
		reasons: view.reasons,
		updatedAt: iso(view.updatedAtMs),
	});
}
