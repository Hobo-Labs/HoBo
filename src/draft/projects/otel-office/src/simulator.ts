/**
 * Deterministic simulator of a plausible HoBo platform so the office is alive
 * without a real OTel collector: 1 station, 2 yards, 4 camps, 10 bindles,
 * junctions between camps, plus a crew member and an internal actor.
 *
 * Phase 2 slice 2: the simulator emits OTLP/JSON payloads (traces, logs,
 * metrics) routed through the same mappers a real collector hits — including
 * the shared TraceIndex. Cross-camp parent spans and their server children are
 * emitted on DIFFERENT ticks, so junction packets exercise the cross-request
 * pairing path end to end.
 *
 * Same seed → identical event stream (mulberry32 RNG, tick-driven, no wall clock).
 */
import { type StringBag } from "./json.js";
import { deriveLayout } from "./layout.js";
import {
	type AgentEvent,
	type Camp,
	type Character,
	type Junction,
	type OfficeState,
	type SpanKind,
	emptyOffice,
} from "./model.js";
import { type OtlpTraceRequest, mapTracePayload } from "./otel.js";
import {
	type OtlpLogsRequest,
	type OtlpMetricsRequest,
	mapLogsPayload,
	mapMetricsPayload,
} from "./otel-signals.js";
import { TraceIndex } from "./trace-index.js";

export const SIM_TICK_MS = 500;

/** mulberry32 — small seedable PRNG. */
export function createRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface SimBindle {
	name: string;
	campId: string;
	kind: Character["kind"];
}

interface SimTopology {
	station: string;
	yards: { id: string; name: string }[];
	camps: { id: string; name: string; yardId: string; rect: Camp["rect"] }[];
	junctions: { id: string; name: string; from: string; to: string }[];
	bindles: SimBindle[];
}

const TOPOLOGY: SimTopology = {
	station: "station-local",
	yards: [
		{ id: "yard-platform", name: "platform" },
		{ id: "yard-edge", name: "edge" },
	],
	camps: [
		{ id: "camp-gateway", name: "gateway", yardId: "yard-edge", rect: { x: 2, y: 2, w: 12, h: 9 } },
		{ id: "camp-orders", name: "orders", yardId: "yard-platform", rect: { x: 20, y: 2, w: 12, h: 9 } },
		{ id: "camp-billing", name: "billing", yardId: "yard-platform", rect: { x: 38, y: 2, w: 12, h: 9 } },
		{ id: "camp-search", name: "search", yardId: "yard-edge", rect: { x: 20, y: 16, w: 12, h: 9 } },
	],
	junctions: [
		{ id: "jn-gw-orders", name: "gateway↔orders", from: "camp-gateway", to: "camp-orders" },
		{ id: "jn-orders-billing", name: "orders↔billing", from: "camp-orders", to: "camp-billing" },
		{ id: "jn-gw-search", name: "gateway↔search", from: "camp-gateway", to: "camp-search" },
	],
	bindles: [
		{ name: "api-gateway", campId: "camp-gateway", kind: "bindle" },
		{ name: "edge-auth", campId: "camp-gateway", kind: "bindle" },
		{ name: "orders-api", campId: "camp-orders", kind: "bindle" },
		{ name: "orders-worker", campId: "camp-orders", kind: "bindle" },
		{ name: "orders-db-proxy", campId: "camp-orders", kind: "bindle" },
		{ name: "billing-api", campId: "camp-billing", kind: "bindle" },
		{ name: "billing-ledger", campId: "camp-billing", kind: "bindle" },
		{ name: "search-api", campId: "camp-search", kind: "bindle" },
		{ name: "search-indexer", campId: "camp-search", kind: "bindle" },
		{ name: "notify-relay", campId: "camp-gateway", kind: "bindle" },
		{ name: "operator-sam", campId: "camp-platform-ops", kind: "crew" },
		{ name: "reconciler", campId: "camp-platform-ops", kind: "actor" },
	],
};

const OPS_CAMP = { id: "camp-platform-ops", name: "platform-ops", yardId: "yard-platform", rect: { x: 38, y: 16, w: 12, h: 9 } };

function corridorBetween(a: Camp["rect"], b: Camp["rect"]): Junction["corridor"] {
	// L-shaped corridor: horizontal from a's door to b's column, then vertical
	// to b's door. Tiles form a 4-connected walk from a's door to b's door —
	// the sorted-range version duplicated or skipped the corner tile whenever
	// the doors were not already aligned, so derived layouts failed their own
	// contiguity validation.
	const ax = a.x + a.w;
	const ay = a.y + Math.floor(a.h / 2);
	const bx = b.x - 1;
	const by = b.y + Math.floor(b.h / 2);
	const tiles: Junction["corridor"] = [];
	const stepX = ax <= bx ? 1 : -1;
	for (let x = ax; x !== bx + stepX; x += stepX) tiles.push({ x, y: ay });
	const stepY = ay <= by ? 1 : -1;
	for (let y = ay + stepY; y !== by + stepY; y += stepY) tiles.push({ x: bx, y });
	return tiles;
}

export interface Simulation {
	state: OfficeState;
	/** Advance one tick; returns events (including the tick) in deterministic order. */
	step(): AgentEvent[];
}

interface SpanTemplate {
	name: string;
	kind: SpanKind;
	attrs: StringBag;
}

const SPAN_TEMPLATES: SpanTemplate[] = [
	{ name: "HTTP POST /bindles", kind: "server", attrs: {} },
	{ name: "GET /trails/:id", kind: "server", attrs: {} },
	{ name: "pg SELECT", kind: "client", attrs: { "db.system": "postgresql" } },
	{ name: "redis GET", kind: "client", attrs: { "db.system": "redis" } },
	{ name: "queue publish", kind: "producer", attrs: { "messaging.system": "nats" } },
	{ name: "queue consume", kind: "consumer", attrs: { "messaging.system": "nats" } },
	{ name: "reconcile loop", kind: "internal", attrs: {} },
];

interface KindToOtlp {
	internal: 1;
	server: 2;
	client: 3;
	producer: 4;
	consumer: 5;
}

const KIND_TO_OTLP: KindToOtlp = {
	internal: 1,
	server: 2,
	client: 3,
	producer: 4,
	consumer: 5,
};

interface OpenSpan {
	spanId: string;
	traceId: string;
	startedAt: number;
}

/** A server/consumer child span due on a later tick (cross-request pairing). */
interface PendingChild {
	dueAt: number;
	characterId: string;
	traceId: string;
	spanId: string;
	parentSpanId: string;
	name: string;
}

export function createSimulation(seed = 1): Simulation {
	const rng = createRng(seed);
	const state = emptyOffice();
	state.stations[TOPOLOGY.station] = { id: TOPOLOGY.station, name: "local" };
	for (const yard of TOPOLOGY.yards) {
		state.yards[yard.id] = { id: yard.id, stationId: TOPOLOGY.station, name: yard.name };
	}
	for (const camp of [...TOPOLOGY.camps, OPS_CAMP]) {
		state.camps[camp.id] = { id: camp.id, yardId: camp.yardId, name: camp.name, rect: camp.rect };
	}
	for (const jn of TOPOLOGY.junctions) {
		const from = state.camps[jn.from];
		const to = state.camps[jn.to];
		if (from === undefined || to === undefined) continue;
		state.junctions[jn.id] = {
			id: jn.id,
			name: jn.name,
			fromCampId: jn.from,
			toCampId: jn.to,
			corridor: corridorBetween(from.rect, to.rect),
		};
	}
	const campIndex = new Map<string, number>();
	for (const b of TOPOLOGY.bindles) {		const camp = state.camps[b.campId];
		if (camp === undefined) continue;
		const idx = campIndex.get(b.campId) ?? 0;
		campIndex.set(b.campId, idx + 1);
		const perRow = Math.max(1, Math.floor((camp.rect.w - 2) / 2));
		const desk = {
			x: camp.rect.x + 1 + (idx % perRow) * 2,
			y: camp.rect.y + 1 + Math.floor(idx / perRow) * 2,
		};
		const id = `${TOPOLOGY.station}/${b.name}`;
		state.characters[id] = {
			id,
			name: b.name,
			kind: b.kind,
			stationId: TOPOLOGY.station,
			campId: b.campId,
			desk,
			position: { ...desk },
			state: "idle",
			stateSince: 0,
			health: 1,
			bubble: undefined,
			bubbleSince: 0,
			path: [],
			activeSpans: {},
		};
	}

	let clock = 0;
	let spanSeq = 0;
	// The office layout is data (Phase 2 slice 3): derive the default from the
	// topology above; the server may replace it with a persisted/edited one.
	state.layouts[TOPOLOGY.station] = deriveLayout(state, TOPOLOGY.station);
	const characters = Object.values(state.characters);
	const byCamp = new Map<string, Character[]>();
	for (const ch of characters) {
		const list = byCamp.get(ch.campId) ?? [];
		list.push(ch);
		byCamp.set(ch.campId, list);
	}
	// The sim owns its open-span ledger: the server reduces events into cloned
	// state, so the sim never reads its own topology object back.
	const openSpans = new Map<string, OpenSpan[]>();
	const pendingChildren: PendingChild[] = [];
	const index = new TraceIndex();

	function pick<T>(items: readonly T[]): T {
		const item = items[Math.floor(rng() * items.length)];
		if (item === undefined) throw new Error("empty pick");
		return item;
	}

	function resourceAttrs(ch: Character): { key: string; value: { stringValue: string } }[] {
		return [
			{ key: "service.name", value: { stringValue: ch.name } },
			{ key: "hobo.station", value: { stringValue: ch.stationId } },
			{ key: "hobo.yard", value: { stringValue: state.camps[ch.campId]?.yardId ?? "default" } },
			{ key: "hobo.camp", value: { stringValue: ch.campId } },
			{ key: "hobo.primitive", value: { stringValue: ch.kind } },
		];
	}

	function tracePayload(
		ch: Character,
		span: {
			traceId: string;
			spanId: string;
			parentSpanId?: string;
			name: string;
			kind: SpanKind;
			attrs: Record<string, string>;
			startMs: number;
		},
	): OtlpTraceRequest {
		return {
			resourceSpans: [
				{
					resource: { attributes: resourceAttrs(ch) },
					scopeSpans: [
						{
							scope: { name: "simulator" },
							spans: [
								{
									traceId: span.traceId,
									spanId: span.spanId,
									...(span.parentSpanId !== undefined
										? { parentSpanId: span.parentSpanId }
										: undefined),
									name: span.name,
									kind: KIND_TO_OTLP[span.kind],
									startTimeUnixNano: String(span.startMs * 1_000_000),
									attributes: Object.entries(span.attrs).map(([key, value]) => ({
										key,
										value: { stringValue: value },
									})),
								},
							],
						},
					],
				},
			],
		};
	}

	function logsPayload(
		ch: Character,
		record: { severityNumber: number; severityText: string; message: string; traceId?: string },
	): OtlpLogsRequest {
		return {
			resourceLogs: [
				{
					resource: { attributes: resourceAttrs(ch) },
					scopeLogs: [
						{
							scope: { name: "simulator" },
							logRecords: [
								{
									timeUnixNano: String(clock * 1_000_000),
									severityNumber: record.severityNumber,
									severityText: record.severityText,
									body: { stringValue: record.message },
									...(record.traceId !== undefined ? { traceId: record.traceId } : undefined),
								},
							],
						},
					],
				},
			],
		};
	}

	function metricsPayload(ch: Character, value: number): OtlpMetricsRequest {
		return {
			resourceMetrics: [
				{
					resource: { attributes: resourceAttrs(ch) },
					scopeMetrics: [
						{
							scope: { name: "simulator" },
							metrics: [
								{
									name: "hobo.health",
									gauge: {
										dataPoints: [{ timeUnixNano: String(clock * 1_000_000), asDouble: value }],
									},
								},
							],
						},
					],
				},
			],
		};
	}

	function step(): AgentEvent[] {
		clock += SIM_TICK_MS;
		const tracePayloads: OtlpTraceRequest[] = [];
		const logPayloads: OtlpLogsRequest[] = [];
		const metricPayloads: OtlpMetricsRequest[] = [];
		const direct: AgentEvent[] = [];

		// 1. Cross-camp children due this tick — their parents were ingested on
		//    an earlier tick, so pairing resolves through the trace index.
		for (let i = pendingChildren.length - 1; i >= 0; i -= 1) {
			const child = pendingChildren[i];
			if (child === undefined || child.dueAt > clock) continue;
			pendingChildren.splice(i, 1);
			const ch = characters.find((c) => c.id === child.characterId);
			if (ch === undefined) continue;
			tracePayloads.push(
				tracePayload(ch, {
					traceId: child.traceId,
					spanId: child.spanId,
					parentSpanId: child.parentSpanId,
					name: child.name,
					kind: "server",
					attrs: {},
					startMs: clock,
				}),
			);
			const open = openSpans.get(ch.id) ?? [];
			open.push({ spanId: child.spanId, traceId: child.traceId, startedAt: clock });
			openSpans.set(ch.id, open);
		}

		// 2. Regular per-character activity.
		for (const ch of characters) {
			const open = openSpans.get(ch.id) ?? [];
			const roll = rng();
			if (open.length > 0 && roll < 0.45) {
				// Close the oldest open span; ~1 in 8 ends in error.
				const closing = open.shift() ?? { spanId: "", traceId: "", startedAt: clock };
				const errored = rng() < 0.125;
				let durationMs = clock - closing.startedAt + Math.floor(rng() * 400);
				if (errored && rng() < 0.3) durationMs += 6_000;
				direct.push({
					type: "span-ended",
					at: clock,
					spanId: closing.spanId,
					characterId: ch.id,
					status: errored ? "error" : "ok",
					durationMs,
				});
				if (errored) {
					logPayloads.push(
						logsPayload(ch, {
							severityNumber: 17,
							severityText: "ERROR",
							message: "span failed — needs a human",
							traceId: closing.traceId,
						}),
					);
				}
			} else if (roll < 0.45 + 0.35) {
				// Open a new span via an OTLP payload; sometimes a cross-camp call.
				const template = pick(SPAN_TEMPLATES);
				spanSeq += 1;
				const spanId = `span-${spanSeq}`;
				const traceId = `trace-${spanSeq}`;
				const crossing =
					rng() < 0.2 && (template.kind === "client" || template.kind === "producer")
						? Object.values(state.junctions).find(
								(j) => j.fromCampId === ch.campId || j.toCampId === ch.campId,
							)
						: undefined;
				const attrs = { ...template.attrs };
				if (crossing !== undefined) attrs["hobo.junction"] = crossing.id;
				tracePayloads.push(
					tracePayload(ch, {
						traceId,
						spanId,
						name: template.name,
						kind: template.kind,
						attrs,
						startMs: clock,
					}),
				);
				open.push({ spanId, traceId, startedAt: clock });
				openSpans.set(ch.id, open);
				if (crossing !== undefined) {
					// Schedule the server child in the peer camp 1–2 ticks out, so the
					// pair lands in separate "requests" and pairs via the index.
					const peerCampId =
						crossing.fromCampId === ch.campId ? crossing.toCampId : crossing.fromCampId;
					const peers = byCamp.get(peerCampId) ?? [];
					if (peers.length > 0) {
						spanSeq += 1;
						pendingChildren.push({
							dueAt: clock + SIM_TICK_MS * (1 + Math.floor(rng() * 2)),
							characterId: pick(peers).id,
							traceId,
							spanId: `span-${spanSeq}`,
							parentSpanId: spanId,
							name: template.name,
						});
					}
				}
			}
			if (rng() < 0.05) {
				metricPayloads.push(metricsPayload(ch, 0.5 + rng() * 0.5));
			}
			if (rng() < 0.03) {
				// Varied, deterministic severities: INFO stays quiet, WARN bubbles,
				// ERROR bubbles + flips the character to stuck attention.
				const sevRoll = rng();
				const severity =
					sevRoll < 0.4
						? { severityNumber: 9, severityText: "INFO" }
						: sevRoll < 0.85
							? { severityNumber: 13, severityText: "WARN" }
							: { severityNumber: 17, severityText: "ERROR" };
				const message =
					severity.severityText === "ERROR"
						? pick(["payment reconcile failed", "index shard offline"])
						: pick(["deploy drifting", "queue lag rising", "retry budget low", "gc pause long"]);
				logPayloads.push(logsPayload(ch, { ...severity, message }));
			}
		}

		// 3. Route payloads through the same mappers the HTTP ingest uses.
		const events: AgentEvent[] = [];
		for (const payload of tracePayloads) {
			events.push(...mapTracePayload(payload, state, clock, index));
		}
		for (const payload of logPayloads) {
			events.push(...mapLogsPayload(payload, state, clock));
		}
		for (const payload of metricPayloads) {
			events.push(...mapMetricsPayload(payload, state, clock));
		}
		events.push(...direct);
		events.push({ type: "tick", at: clock });
		return events;
	}

	return { state, step };
}
