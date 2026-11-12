/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening -- SAFETY: this is the OTLP/JSON parse boundary; OTLP attribute maps and lookup tables are open dictionaries by the OTLP spec, and reading a value's representation is the parse. */
/**
 * OTLP/JSON → yard-world model mappers (traces, logs, metrics).
 *
 * Traces — accepts a subset of OTLP trace JSON (ExportTraceServiceRequest):
 *   resourceSpans[] → resource.attributes (service.name, hobo.*)
 *     → scopeSpans[] → spans[] { traceId, spanId, name, kind, status,
 *                                startTimeUnixNano, endTimeUnixNano, attributes }
 *
 * Custom resource attributes pin HoBo topology:
 *   hobo.station (default "default"), hobo.yard, hobo.camp (default "default"),
 *   hobo.junction (peer camp id for cross-camp spans),
 *   hobo.primitive = bindle | crew | actor (default bindle).
 *
 * CD spans naming a Camp in span attributes (`hobo.camp.id`) are lifted into a
 * per-Camp resource first (`liftCdTopology`).
 *
 * Unknown services materialize stations/yards/camps/characters on demand so a
 * real OTLP exporter can point at the ingest boundary with zero provisioning.
 *
 * Logs (ExportLogsServiceRequest):
 *   resourceLogs[] → resource.attributes (service.name, hobo.*)
 *     → scopeLogs[] → logRecords[] { timeUnixNano, severityNumber/severityText,
 *                                   body, attributes, traceId }
 * WARN and above raise a speech bubble; ERROR also flips the character to the
 * stuck attention state. Every record lands in the character's ActivityLog.
 *
 * Metrics (ExportMetricsServiceRequest):
 *   resourceMetrics[] → resource.attributes → scopeMetrics[] → metrics[]
 *     { name, sum.dataPoints | gauge.dataPoints { asDouble | asInt, timeUnixNano } }
 * A small explicit mapping table (METRIC_HEALTH_MAP) drives the health bar;
 * unknown metric names still land in the ActivityLog for the inspect panel.
 */
import { syncLayout } from "./layout-model.js";
import {
	type AgentEvent,
	type Character,
	junctionForCamps,
	type PrimitiveKind,
	type SpanKind,
	type WorldState,
} from "./model.js";
import type { TraceIndex } from "./trace-index.js";

interface OtlpValue {
	stringValue?: string;
	intValue?: number | string;
	doubleValue?: number;
}

interface OtlpAttribute {
	key: string;
	value: OtlpValue;
}

interface OtlpStatus {
	code?: number;
	message?: string;
}

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind?: number;
	startTimeUnixNano?: string | number;
	endTimeUnixNano?: string | number;
	status?: OtlpStatus;
	attributes?: OtlpAttribute[];
}

interface OtlpScopeSpans {
	scope?: { name?: string };
	spans?: OtlpSpan[];
}

interface OtlpResourceSpans {
	resource?: { attributes?: OtlpAttribute[] };
	scopeSpans?: OtlpScopeSpans[];
}

export interface OtlpTraceRequest {
	resourceSpans?: OtlpResourceSpans[];
}

export function attributesToRecord(
	attrs: OtlpAttribute[] | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const attr of attrs ?? []) {
		const v = attr.value;
		if (v.stringValue !== undefined) out[attr.key] = v.stringValue;
		else if (v.intValue !== undefined) out[attr.key] = String(v.intValue);
		else if (v.doubleValue !== undefined) out[attr.key] = String(v.doubleValue);
	}
	return out;
}

/** A scope-spans group carrying the source group's scope, when it has one. */
function scopeOf(source: OtlpScopeSpans, spans: OtlpSpan[]): OtlpScopeSpans {
	const out: OtlpScopeSpans = { spans };
	if (source.scope !== undefined) out.scope = source.scope;
	return out;
}

function str(key: string, value: string): OtlpAttribute {
	return { key, value: { stringValue: value } };
}

/**
 * HoBo CD spans (plan 0024 WP19) carry topology as SPAN attributes
 * (`hobo.camp.id`, `hobo.station.id`, `hobo.yard.id`) because one CD service
 * delivers to many Camps. Regroup spans that name a Camp (`hobo.camp.id`) under a per-Camp resource.
 * Spans without one stay where they were. Input order is preserved within a
 * group; groups appear in first-seen order. Pure: returns a new payload.
 */
export function liftCdTopology(payload: OtlpTraceRequest): OtlpTraceRequest {
	const out: OtlpResourceSpans[] = [];
	for (const rs of payload.resourceSpans ?? []) {
		const resource = attributesToRecord(rs.resource?.attributes);
		const service = resource["service.name"] ?? "hobo-cd";
		const keep: OtlpResourceSpans = { ...rs, scopeSpans: [] };
		const lifted = new Map<string, OtlpResourceSpans>();
		for (const ss of rs.scopeSpans ?? []) {
			const stay: OtlpSpan[] = [];
			for (const span of ss.spans ?? []) {
				const attrs = attributesToRecord(span.attributes);
				const campId = attrs["hobo.camp.id"];
				if (campId === undefined || resource["hobo.camp"] !== undefined) {
					stay.push(span);
					continue;
				}
				const stationId =
					attrs["hobo.station.id"] ?? resource["hobo.station"] ?? "default";
				const yardId = attrs["hobo.yard.id"] ?? resource["hobo.yard"];
				const key = `${stationId}\u0000${campId}`;
				let group = lifted.get(key);
				if (group === undefined) {
					const attributes = (rs.resource?.attributes ?? []).filter(
						(a) =>
							![
								"service.name",
								"hobo.camp",
								"hobo.station",
								"hobo.yard",
								"hobo.primitive",
							].includes(a.key),
					);
					attributes.push(
						str("service.name", `${service}@${campId}`),
						str("hobo.camp", campId),
						str("hobo.station", stationId),
						str("hobo.primitive", "actor"),
					);
					if (yardId !== undefined) attributes.push(str("hobo.yard", yardId));
					group = { resource: { attributes }, scopeSpans: [] };
					lifted.set(key, group);
				}
				const scopes = group.scopeSpans ?? [];
				const scope = scopes.find((s) => s.scope?.name === ss.scope?.name);
				if (scope) scope.spans = [...(scope.spans ?? []), span];
				else scopes.push(scopeOf(ss, [span]));
				group.scopeSpans = scopes;
			}
			if (stay.length > 0)
				keep.scopeSpans = [...(keep.scopeSpans ?? []), scopeOf(ss, stay)];
		}
		if ((keep.scopeSpans ?? []).length > 0) out.push(keep);
		out.push(...lifted.values());
	}
	return { resourceSpans: out };
}

const SPAN_KINDS: Record<number, SpanKind> = {
	1: "internal",
	2: "server",
	3: "client",
	4: "producer",
	5: "consumer",
};

export function spanKindFromOtlp(kind: number | undefined): SpanKind {
	return SPAN_KINDS[kind ?? 1] ?? "internal";
}

function nanoToMs(value: string | number | undefined): number {
	if (value === undefined) return 0;
	const n = typeof value === "string" ? Number(value) : value;
	return Math.floor(n / 1_000_000);
}

const PRIMITIVES: Record<string, PrimitiveKind> = {
	bindle: "bindle",
	crew: "crew",
	actor: "actor",
};

/** Stable character id — station-scoped so stations never mix. */
export function characterIdFor(stationId: string, serviceName: string): string {
	return `${stationId}/${serviceName}`;
}

/**
 * Ensure topology + character exist for a resource. Mutates `state`.
 * New entities get simple auto-layout positions on the tile grid.
 */
export function ensureCharacter(
	state: WorldState,
	attrs: Record<string, string>,
	now: number,
): Character {
	const stationId = attrs["hobo.station"] ?? "default";
	const yardId = attrs["hobo.yard"] ?? "default";
	const campId = attrs["hobo.camp"] ?? "default";
	const serviceName = attrs["service.name"] ?? "unknown-service";
	const kind = PRIMITIVES[attrs["hobo.primitive"] ?? "bindle"] ?? "bindle";

	state.stations[stationId] ??= { id: stationId, name: stationId };
	state.yards[yardId] ??= { id: yardId, stationId, name: yardId };
	if (state.camps[campId] === undefined) {
		// Auto-layout: tile new camp rooms in a row under existing ones.
		const count = Object.keys(state.camps).length;
		state.camps[campId] = {
			id: campId,
			yardId,
			name: campId,
			rect: {
				x: 2 + (count % 4) * 14,
				y: 2 + Math.floor(count / 4) * 12,
				w: 12,
				h: 9,
			},
		};
	}
	const camp = state.camps[campId];
	const id = characterIdFor(stationId, serviceName);
	let ch = state.characters[id];
	if (ch === undefined && camp !== undefined) {
		const siblings = Object.values(state.characters).filter(
			(c) => c.campId === campId,
		).length;
		const desk = {
			x: camp.rect.x + 1 + (siblings % Math.max(1, camp.rect.w - 2)),
			y: camp.rect.y + 1 + Math.floor(siblings / Math.max(1, camp.rect.w - 2)),
		};
		ch = {
			id,
			name: serviceName,
			kind,
			stationId,
			campId,
			desk,
			position: { ...desk },
			state: "idle",
			stateSince: now,
			health: 1,
			bubble: undefined,
			bubbleSince: 0,
			path: [],
			activeSpans: {},
		};
		state.characters[id] = ch;
	}
	if (ch === undefined)
		throw new Error(`failed to materialize character ${id}`);
	// Auto-materialized topology flows into the station's layout as data.
	syncLayout(state, stationId);
	return ch;
}

/**
 * Map one OTLP/JSON trace request into normalized agent events.
 * Open spans (no end) emit only span-started; ended spans emit started+ended.
 * Cross-camp parent/child pairs (client span in camp A → server span in camp B,
 * same traceId) emit a packet-started so a packet walks the junction corridor.
 *
 * When a `TraceIndex` is passed, every ingested span is recorded in it and a
 * child's `parentSpanId` is resolved against it — so parent and child may
 * arrive in SEPARATE OTLP requests (the normal collector fan-out).
 */
export function mapTracePayload(
	payload: OtlpTraceRequest,
	state: WorldState,
	now = Date.now(),
	index?: TraceIndex,
): AgentEvent[] {
	interface FlatSpan {
		span: OtlpSpan;
		attrs: Record<string, string>;
		character: Character;
		yardId: string | undefined;
		startMs: number;
		endMs: number;
		kind: SpanKind;
	}
	const flat: FlatSpan[] = [];
	for (const rs of liftCdTopology(payload).resourceSpans ?? []) {
		const resourceAttrs = attributesToRecord(rs.resource?.attributes);
		const character = ensureCharacter(state, resourceAttrs, now);
		for (const ss of rs.scopeSpans ?? []) {
			for (const span of ss.spans ?? []) {
				flat.push({
					span,
					attrs: attributesToRecord(span.attributes),
					character,
					yardId: resourceAttrs["hobo.yard"],
					startMs: nanoToMs(span.startTimeUnixNano) || now,
					endMs: nanoToMs(span.endTimeUnixNano),
					kind: spanKindFromOtlp(span.kind),
				});
			}
		}
	}

	const events: AgentEvent[] = [];
	for (const { span, attrs, character, yardId, startMs, endMs, kind } of flat) {
		const started: Extract<AgentEvent, { type: "span-started" }> = {
			type: "span-started",
			at: startMs,
			traceId: span.traceId,
			spanId: span.spanId,
			name: span.name,
			spanKind: kind,
			attributes: attrs,
			stationId: character.stationId,
			yardId,
			campId: character.campId,
			characterId: character.id,
			junctionId: attrs["hobo.junction"],
		};
		if (span.parentSpanId !== undefined)
			started.parentSpanId = span.parentSpanId;
		events.push(started);
		if (span.endTimeUnixNano !== undefined) {
			events.push({
				type: "span-ended",
				at: endMs || now,
				spanId: span.spanId,
				characterId: character.id,
				status: span.status?.code === 2 ? "error" : "ok",
				durationMs: Math.max(0, endMs - startMs),
			});
		}
	}

	// Feed the server-side index first so pairs split across requests resolve.
	for (const f of flat) {
		index?.record(
			{
				traceId: f.span.traceId,
				spanId: f.span.spanId,
				parentSpanId: f.span.parentSpanId,
				kind: f.kind,
				characterId: f.character.id,
				campId: f.character.campId,
				startMs: f.startMs,
				endMs: f.endMs,
			},
			now,
		);
	}

	// Trace-pair derivation: a client/producer span in camp A whose child
	// server/consumer span landed in camp B sends a packet along the junction.
	// Parent resolution: same payload first, then the cross-request index.
	const bySpanId = new Map(flat.map((f) => [f.span.spanId, f]));
	for (const child of flat) {
		if (child.kind !== "server" && child.kind !== "consumer") continue;
		const inPayload =
			child.span.parentSpanId !== undefined
				? bySpanId.get(child.span.parentSpanId)
				: undefined;
		const fromIndex =
			inPayload === undefined && child.span.parentSpanId !== undefined
				? index?.lookup(child.span.traceId, child.span.parentSpanId, now)
				: undefined;
		const parentCampId = inPayload?.character.campId ?? fromIndex?.campId;
		let junctionId: string | undefined;
		let fromCampId: string | undefined;
		if (parentCampId !== undefined && parentCampId !== child.character.campId) {
			fromCampId = parentCampId;
			junctionId = junctionForCamps(
				state,
				fromCampId,
				child.character.campId,
			)?.id;
		} else if (child.attrs["hobo.junction"] !== undefined) {
			const junction = state.junctions[child.attrs["hobo.junction"]];
			if (junction !== undefined) {
				junctionId = junction.id;
				fromCampId =
					junction.fromCampId === child.character.campId
						? junction.toCampId
						: junction.fromCampId;
			}
		}
		if (junctionId === undefined || fromCampId === undefined) continue;
		events.push({
			type: "packet-started",
			at: child.startMs,
			traceId: child.span.traceId,
			spanId: child.span.spanId,
			junctionId,
			fromCampId,
			toCampId: child.character.campId,
			durationMs: Math.max(500, child.endMs - child.startMs || 8_000),
		});
	}
	return events;
}

interface OtlpLogRecord {
	timeUnixNano?: string | number;
	severityNumber?: number;
	severityText?: string;
	body?: OtlpValue;
	attributes?: OtlpAttribute[];
	traceId?: string;
}

interface OtlpScopeLogs {
	scope?: { name?: string };
	logRecords?: OtlpLogRecord[];
}

export interface OtlpLogsRequest {
	resourceLogs?: {
		resource?: { attributes?: OtlpAttribute[] };
		scopeLogs?: OtlpScopeLogs[];
	}[];
}

interface OtlpDataPoint {
	timeUnixNano?: string | number;
	asDouble?: number;
	asInt?: number | string;
	attributes?: OtlpAttribute[];
}

interface OtlpMetric {
	name: string;
	sum?: { dataPoints?: OtlpDataPoint[] };
	gauge?: { dataPoints?: OtlpDataPoint[] };
}

export interface OtlpMetricsRequest {
	resourceMetrics?: {
		resource?: { attributes?: OtlpAttribute[] };
		scopeMetrics?: { scope?: { name?: string }; metrics?: OtlpMetric[] }[];
	}[];
}

type Severity = "INFO" | "WARN" | "ERROR";

/** OTLP severityNumber ranges: WARN = 13–16, ERROR = 17–24. */
export function severityFromOtlp(
	severityNumber: number | undefined,
	severityText: string | undefined,
): Severity {
	if (severityNumber !== undefined) {
		if (severityNumber >= 17) return "ERROR";
		if (severityNumber >= 13) return "WARN";
		return "INFO";
	}
	const text = severityText?.toUpperCase() ?? "";
	if (text.startsWith("ERROR") || text.startsWith("FATAL")) return "ERROR";
	if (text.startsWith("WARN")) return "WARN";
	return "INFO";
}

/** Bubble text stays one-liner short. */
const BUBBLE_MAX = 120;

function bodyToText(body: OtlpValue | undefined): string {
	const raw = body?.stringValue ?? body?.doubleValue ?? body?.intValue ?? "";
	const text = String(raw);
	return text.length > BUBBLE_MAX ? `${text.slice(0, BUBBLE_MAX - 1)}…` : text;
}

/** Map one OTLP/JSON logs request into log-record events. */
export function mapLogsPayload(
	payload: OtlpLogsRequest,
	state: WorldState,
	now = Date.now(),
): AgentEvent[] {
	const events: AgentEvent[] = [];
	for (const rl of payload.resourceLogs ?? []) {
		const resourceAttrs = attributesToRecord(rl.resource?.attributes);
		const character = ensureCharacter(state, resourceAttrs, now);
		for (const sl of rl.scopeLogs ?? []) {
			for (const record of sl.logRecords ?? []) {
				const severity = severityFromOtlp(
					record.severityNumber,
					record.severityText,
				);
				const message = bodyToText(record.body);
				if (message === "") continue;
				const logged: Extract<AgentEvent, { type: "log-record" }> = {
					type: "log-record",
					at: nanoToMs(record.timeUnixNano) || now,
					characterId: character.id,
					severity,
					message,
				};
				if (record.traceId !== undefined) logged.traceId = record.traceId;
				events.push(logged);
			}
		}
	}
	return events;
}

/**
 * Explicit metric → health-bar mapping (documented in README):
 *   hobo.health     gauge 0..1 → health = value
 *   hobo.error.rate gauge/sum 0..1 → health = 1 - value
 * Anything else is recorded in the ActivityLog under its own name only.
 */
export const METRIC_HEALTH_MAP: Record<string, (value: number) => number> = {
	"hobo.health": (value) => value,
	"hobo.error.rate": (value) => 1 - value,
};

/** Map one OTLP/JSON metrics request into metric-sample events. */
export function mapMetricsPayload(
	payload: OtlpMetricsRequest,
	state: WorldState,
	now = Date.now(),
): AgentEvent[] {
	const events: AgentEvent[] = [];
	for (const rm of payload.resourceMetrics ?? []) {
		const resourceAttrs = attributesToRecord(rm.resource?.attributes);
		const character = ensureCharacter(state, resourceAttrs, now);
		for (const sm of rm.scopeMetrics ?? []) {
			for (const metric of sm.metrics ?? []) {
				const healthMap = METRIC_HEALTH_MAP[metric.name];
				const points = [
					...(metric.sum?.dataPoints ?? []),
					...(metric.gauge?.dataPoints ?? []),
				];
				for (const point of points) {
					const raw = point.asDouble ?? Number(point.asInt ?? 0);
					if (Number.isNaN(raw)) continue;
					events.push({
						type: "metric-sample",
						at: nanoToMs(point.timeUnixNano) || now,
						characterId: character.id,
						metric: healthMap === undefined ? metric.name : "health",
						value:
							healthMap === undefined
								? raw
								: Math.max(0, Math.min(1, healthMap(raw))),
					});
				}
			}
		}
	}
	return events;
}
