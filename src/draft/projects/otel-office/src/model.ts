
export type PrimitiveKind = "bindle" | "crew" | "actor";

export type AgentState = "idle" | "working" | "reading" | "stuck";

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

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
	rect: TileRect;
}

export interface Junction {
	id: string;
	name: string;
	fromCampId: string;
	toCampId: string;
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
	stateSince: number;
	health: number;
	bubble: string | undefined;
	bubbleSince: number;
	path: TilePoint[];
	activeSpans: Record<string, SpanKind>;
}

export interface Packet {
	id: string;
	traceId: string;
	spanId: string;
	junctionId: string;
	fromCampId: string;
	toCampId: string;
	path: TilePoint[];
	position: TilePoint;
	startedAt: number;
	durationMs: number;
}

export interface OfficeState {
	tick: number;
	stations: Record<string, Station>;
	layouts: Record<string, import("./layout.js").OfficeLayout>;
	yards: Record<string, Yard>;
	camps: Record<string, Camp>;
	junctions: Record<string, Junction>;
	characters: Record<string, Character>;
	packets: Record<string, Packet>;
}

export type SpanStatus = "ok" | "error";

export type AgentEvent =
	| {
			type: "span-started";
			at: number;
			traceId: string;
			spanId: string;
			name: string;
			spanKind: SpanKind;
			attributes: Record<string, string>;
			stationId: string;
			yardId: string | undefined;
			campId: string;
			characterId: string;
			parentSpanId?: string;
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
			metric: string;
			value: number;
	  }
	| {
			type: "log-record";
			at: number;
			characterId: string;
			severity: "INFO" | "WARN" | "ERROR";
			message: string;
			traceId?: string;
	  }
	| { type: "layout-changed"; at: number; stationId: string }
	| { type: "tick"; at: number };

export const BUBBLE_TTL_MS = 8_000;
export const LONG_BLOCK_MS = 5_000;

export function emptyOffice(): OfficeState {
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

function clone(state: OfficeState): OfficeState {
	return structuredClone(state);
}

export function stateForSpan(kind: SpanKind, attrs: Record<string, string>): AgentState {
	if (attrs["db.system"] !== undefined || attrs["messaging.system"] !== undefined) {
		return "reading";
	}
	if (kind === "producer" || kind === "consumer") return "reading";
	if (kind === "server" || kind === "client" || kind === "internal") return "working";
	return "idle";
}

export function junctionForCamps(
	state: OfficeState,
	fromCampId: string,
	toCampId: string,
): Junction | undefined {
	return Object.values(state.junctions).find(
		(j) =>
			(j.fromCampId === fromCampId && j.toCampId === toCampId) ||
			(j.fromCampId === toCampId && j.toCampId === fromCampId),
	);
}

export function applyEvent(state: OfficeState, event: AgentEvent): OfficeState {
	const next = clone(state);
	switch (event.type) {
		case "tick": {
			next.tick += 1;
			for (const ch of Object.values(next.characters)) {
				if (ch.bubble !== undefined && event.at - ch.bubbleSince > BUBBLE_TTL_MS) {
					ch.bubble = undefined;
				}
				const step = ch.path.shift();
				if (step !== undefined) ch.position = step;
			}
			for (const packet of Object.values(next.packets)) {
				const step = packet.path.shift();
				if (step !== undefined) packet.position = step;
				if (packet.path.length === 0 || event.at - packet.startedAt >= packet.durationMs) {
					delete next.packets[packet.id];
				}
			}
			return next;
		}
		case "layout-changed": {
			return next;
		}
		case "packet-started": {
			const junction = next.junctions[event.junctionId];
			if (junction === undefined) return next;
			const forward = junction.fromCampId === event.fromCampId;
			const path = forward ? [...junction.corridor] : [...junction.corridor].reverse();
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
			if (event.junctionId !== undefined) {
				const junction = next.junctions[event.junctionId];
				if (junction !== undefined) {
					const peerCampId =
						junction.fromCampId === event.campId ? junction.toCampId : junction.fromCampId;
					const forward = junction.fromCampId === event.campId;
					ch.path = forward ? [...junction.corridor] : [...junction.corridor].reverse();
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
			if (event.severity === "ERROR") {
				ch.state = "stuck";
				ch.stateSince = event.at;
			}
			return next;
		}
	}
}

export function visibleCharacters(state: OfficeState, stationId: string): Character[] {
	return Object.values(state.characters).filter((ch) => ch.stationId === stationId);
}

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

export const ACTIVITY_LIMIT = 50;

function pushBounded<T>(list: T[], item: T): void {
	list.push(item);
	if (list.length > ACTIVITY_LIMIT) list.splice(0, list.length - ACTIVITY_LIMIT);
}

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
