/**
 * Typed event model for the yard world.
 *
 * HoBo primitive → world mapping:
 *   Station → building (hard isolation boundary, ADR-0131): entities never mix.
 *   Yard    → floor/zone containing camp rooms.
 *   Camp    → named area/room; its bindles sit at desks inside.
 *   Junction → corridor/door between two camp rooms.
 *   Bindle  → character at a desk; animation state derives from span activity.
 *   Crew    → operator-triggered character (manual spans/logs).
 *   Actor   → internal worker character (internal span kind).
 *
 * Plain TS types for now — protobuf codegen from data-models/ is a tracked gap
 * (see the package README).
 */

export type PrimitiveKind = "bindle" | "crew" | "actor";

export type AgentState = "idle" | "working" | "reading" | "stuck";

/** OTel span kinds, aligned with OTLP Span.Kind numbering. */
export type SpanKind =
	| "internal"
	| "server"
	| "client"
	| "producer"
	| "consumer";

export interface TilePoint {
	x: number;
	y: number;
}

export interface TileRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Station {
	id: string;
	name: string;
}

export interface Yard {
	id: string;
	stationId: string;
	name: string;
}

export interface Camp {
	id: string;
	yardId: string;
	name: string;
	/** Camp-room footprint on the tile grid. */
	rect: TileRect;
}

export interface Junction {
	id: string;
	name: string;
	fromCampId: string;
	toCampId: string;
	/** Corridor tiles connecting the two camp rooms. */
	corridor: TilePoint[];
}

export interface Character {
	id: string;
	name: string;
	kind: PrimitiveKind;
	stationId: string;
	campId: string;
	desk: TilePoint;
	position: TilePoint;
	state: AgentState;
	/** ms timestamp of the last state transition. */
	stateSince: number;
	/** 0..1 health bar over the desk, driven by metric samples. */
	health: number;
	/** Speech bubble text (WARN+ logs), cleared on tick after a TTL. */
	bubble: string | undefined;
	bubbleSince: number;
	/** Remaining walk path (corridor tiles) for cross-camp journeys. */
	path: TilePoint[];
	/** Span IDs currently open for this character, with their kind. */
	activeSpans: Record<string, SpanKind>;
}

/** A trace packet walking a junction corridor for the span's duration. */
export interface Packet {
	id: string;
	traceId: string;
	spanId: string;
	junctionId: string;
	fromCampId: string;
	toCampId: string;
	/** Remaining corridor tiles to walk. */
	path: TilePoint[];
	position: TilePoint;
	startedAt: number;
	durationMs: number;
}

export interface WorldState {
	tick: number;
	stations: Record<string, Station>;
	/** stationId → serializable world layout (see layout-model.ts). */
	layouts: Record<string, import("./layout-model.js").WorldLayout>;
	yards: Record<string, Yard>;
	camps: Record<string, Camp>;
	junctions: Record<string, Junction>;
	characters: Record<string, Character>;
	packets: Record<string, Packet>;
}

export type SpanStatus = "ok" | "error";

/** Normalized agent events — the single input the world reducer consumes. */
export type AgentEvent =
	| {
			type: "span-started";
			at: number;
			traceId: string;
			spanId: string;
			name: string;
			spanKind: SpanKind;
			/** Span attributes (db.system / messaging.system flip state to reading). */
			attributes: Record<string, string>;
			stationId: string;
			yardId: string | undefined;
			campId: string;
			characterId: string;
			/** OTLP parent span id, when the trace carries one. */
			parentSpanId?: string;
			/** Set when the span crosses a junction (cross-camp call). */
			junctionId: string | undefined;
	  }
	| {
			type: "packet-started";
			at: number;
			traceId: string;
			spanId: string;
			junctionId: string;
			fromCampId: string;
			toCampId: string;
			durationMs: number;
	  }
	| {
			type: "span-ended";
			at: number;
			spanId: string;
			characterId: string;
			status: SpanStatus;
			durationMs: number;
	  }
	| {
			type: "metric-sample";
			at: number;
			characterId: string;
			/** "health" drives the health bar; any other name lands in the activity log only. */
			metric: string;
			value: number;
	  }
	| {
			type: "log-record";
			at: number;
			characterId: string;
			severity: "INFO" | "WARN" | "ERROR";
			message: string;
			/** OTLP trace id the record belongs to, when the log carries one. */
			traceId?: string;
	  }
	/**
	 * A station's layout was replaced (editor PUT). Reducer no-op; consumers
	 * re-pull the snapshot for the new geometry.
	 */
	| { type: "layout-changed"; at: number; stationId: string }
	| { type: "tick"; at: number };

export const BUBBLE_TTL_MS = 8_000;
/** Spans blocking longer than this mark the character stuck when they end. */
export const LONG_BLOCK_MS = 5_000;

export function emptyWorld(): WorldState {
	return {
		tick: 0,
		stations: {},
		layouts: {},
		yards: {},
		camps: {},
		junctions: {},
		characters: {},
		packets: {},
	};
}

function clone(state: WorldState): WorldState {
	return structuredClone(state);
}

/** Span kind + attributes → character state while the span is open. */
export function stateForSpan(
	kind: SpanKind,
	attrs: Record<string, string>,
): AgentState {
	if (
		attrs["db.system"] !== undefined ||
		attrs["messaging.system"] !== undefined
	) {
		return "reading";
	}
	if (kind === "producer" || kind === "consumer") return "reading";
	if (kind === "server" || kind === "client" || kind === "internal")
		return "working";
	return "idle";
}

export function junctionForCamps(
	state: WorldState,
	fromCampId: string,
	toCampId: string,
): Junction | undefined {
	return Object.values(state.junctions).find(
		(j) =>
			(j.fromCampId === fromCampId && j.toCampId === toCampId) ||
			(j.fromCampId === toCampId && j.toCampId === fromCampId),
	);
}

/**
 * Pure reducer: one event in, next world state out. Characters keep their own
 * active-span set so overlapping spans resolve to the right state on end.
 */
export function applyEvent(state: WorldState, event: AgentEvent): WorldState {
	const next = clone(state);
	switch (event.type) {
		case "tick": {
			next.tick += 1;
			for (const ch of Object.values(next.characters)) {
				if (
					ch.bubble !== undefined &&
					event.at - ch.bubbleSince > BUBBLE_TTL_MS
				) {
					ch.bubble = undefined;
				}
				// Walk one corridor tile per tick while a journey is in progress.
				const step = ch.path.shift();
				if (step !== undefined) ch.position = step;
			}
			// Packets walk one corridor tile per tick until the path is done or
			// the span's duration has elapsed.
			for (const packet of Object.values(next.packets)) {
				const step = packet.path.shift();
				if (step !== undefined) packet.position = step;
				if (
					packet.path.length === 0 ||
					event.at - packet.startedAt >= packet.durationMs
				) {
					delete next.packets[packet.id];
				}
			}
			return next;
		}
		case "layout-changed": {
			// applyLayout already mutated state; nothing for the reducer to do.
			return next;
		}
		case "packet-started": {
			const junction = next.junctions[event.junctionId];
			if (junction === undefined) return next;
			const forward = junction.fromCampId === event.fromCampId;
			const path = forward
				? [...junction.corridor]
				: [...junction.corridor].reverse();
			const first = path.shift();
			if (first === undefined) return next;
			next.packets[event.spanId] = {
				id: event.spanId,
				traceId: event.traceId,
				spanId: event.spanId,
				junctionId: event.junctionId,
				fromCampId: event.fromCampId,
				toCampId: event.toCampId,
				path,
				position: first,
				startedAt: event.at,
				durationMs: event.durationMs,
			};
			return next;
		}
		case "span-started": {
			const ch = next.characters[event.characterId];
			if (ch === undefined) return next;
			ch.activeSpans[event.spanId] = event.spanKind;
			ch.state = stateForSpan(event.spanKind, event.attributes);
			ch.stateSince = event.at;
			ch.bubble = undefined;
			// Cross-camp call: walk the junction corridor toward the peer room.
			if (event.junctionId !== undefined) {
				const junction = next.junctions[event.junctionId];
				if (junction !== undefined) {
					const peerCampId =
						junction.fromCampId === event.campId
							? junction.toCampId
							: junction.fromCampId;
					const forward = junction.fromCampId === event.campId;
					ch.path = forward
						? [...junction.corridor]
						: [...junction.corridor].reverse();
					const peer = next.camps[peerCampId];
					if (peer !== undefined) {
						ch.path.push({ x: peer.rect.x + 1, y: peer.rect.y + 1 });
					}
				}
			}
			return next;
		}
		case "span-ended": {
			const ch = next.characters[event.characterId];
			// A packet belongs to the server-side span; when it ends the journey is over.
			delete next.packets[event.spanId];
			if (ch === undefined) return next;
			delete ch.activeSpans[event.spanId];
			if (event.status === "error" || event.durationMs > LONG_BLOCK_MS) {
				ch.state = "stuck";
				ch.stateSince = event.at;
				if (event.status === "error") {
					ch.bubble = `error in span ${event.spanId.slice(0, 8)}`;
					ch.bubbleSince = event.at;
				}
				return next;
			}
			const remaining = Object.values(ch.activeSpans);
			const nextState =
				remaining.length === 0
					? "idle"
					: stateForSpan(remaining[remaining.length - 1] ?? "internal", {});
			ch.state = nextState;
			ch.stateSince = event.at;
			if (nextState === "idle") {
				// Journey over: return to the desk.
				ch.path = [];
				ch.position = { ...ch.desk };
			}
			return next;
		}
		case "metric-sample": {
			const ch = next.characters[event.characterId];
			if (ch === undefined) return next;
			if (event.metric === "health") {
				ch.health = Math.max(0, Math.min(1, event.value));
			}
			return next;
		}
		case "log-record": {
			const ch = next.characters[event.characterId];
			if (ch === undefined) return next;
			if (event.severity !== "INFO") {
				ch.bubble = event.message;
				ch.bubbleSince = event.at;
			}
			// ERROR logs demand attention the same way an errored span does.
			if (event.severity === "ERROR") {
				ch.state = "stuck";
				ch.stateSince = event.at;
			}
			return next;
		}
	}
}

/** Station isolation: a view never mixes entities from another station. */
export function visibleCharacters(
	state: WorldState,
	stationId: string,
): Character[] {
	return Object.values(state.characters).filter(
		(ch) => ch.stationId === stationId,
	);
}

/** Per-character activity retained for the inspect panel. */
export interface SpanActivity {
	traceId: string;
	spanId: string;
	name: string;
	kind: SpanKind;
	startedAt: number;
	durationMs: number | undefined;
	status: SpanStatus | "open";
}

export interface LogActivity {
	at: number;
	severity: "INFO" | "WARN" | "ERROR";
	message: string;
	traceId: string | undefined;
}

export interface MetricActivity {
	at: number;
	metric: string;
	value: number;
}

export interface CharacterActivity {
	spans: SpanActivity[];
	logs: LogActivity[];
	metrics: MetricActivity[];
}

/** Ring-buffer size per activity list. */
export const ACTIVITY_LIMIT = 50;

function pushBounded<T>(list: T[], item: T): void {
	list.push(item);
	if (list.length > ACTIVITY_LIMIT)
		list.splice(0, list.length - ACTIVITY_LIMIT);
}

/**
 * Bounded per-character ring buffer of recent spans, logs, and metric samples.
 * Fed from the same event stream as the reducer; powers per-character
 * activity/inspect views.
 */
export class ActivityLog {
	private readonly byCharacter = new Map<string, CharacterActivity>();

	record(event: AgentEvent): void {
		switch (event.type) {
			case "span-started": {
				pushBounded(this.activityFor(event.characterId).spans, {
					traceId: event.traceId,
					spanId: event.spanId,
					name: event.name,
					kind: event.spanKind,
					startedAt: event.at,
					durationMs: undefined,
					status: "open",
				});
				return;
			}
			case "span-ended": {
				const activity = this.byCharacter.get(event.characterId);
				const span = activity?.spans.find((s) => s.spanId === event.spanId);
				if (span !== undefined) {
					span.status = event.status;
					span.durationMs = event.durationMs;
				}
				return;
			}
			case "log-record": {
				pushBounded(this.activityFor(event.characterId).logs, {
					at: event.at,
					severity: event.severity,
					message: event.message,
					traceId: event.traceId,
				});
				return;
			}
			case "metric-sample": {
				pushBounded(this.activityFor(event.characterId).metrics, {
					at: event.at,
					metric: event.metric,
					value: event.value,
				});
				return;
			}
			default:
				return;
		}
	}

	for(characterId: string): CharacterActivity {
		const found = this.byCharacter.get(characterId);
		if (found === undefined) return { spans: [], logs: [], metrics: [] };
		// Newest first for the inspect panel.
		return {
			spans: [...found.spans].reverse(),
			logs: [...found.logs].reverse(),
			metrics: [...found.metrics].reverse(),
		};
	}

	private activityFor(characterId: string): CharacterActivity {
		let activity = this.byCharacter.get(characterId);
		if (activity === undefined) {
			activity = { spans: [], logs: [], metrics: [] };
			this.byCharacter.set(characterId, activity);
		}
		return activity;
	}
}
