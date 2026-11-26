/**
 * OTLP/JSON → office model mapper.
 *
 * Accepts a subset of OTLP trace JSON (ExportTraceServiceRequest):
 *   resourceSpans[] → resource.attributes (service.name, hobo.*)
 *     → scopeSpans[] → spans[] { traceId, spanId, name, kind, status,
 *                                startTimeUnixNano, endTimeUnixNano, attributes }
 *
 * Custom resource attributes pin HoBo topology:
 *   hobo.station (default "default"), hobo.yard, hobo.camp (default "default"),
 *   hobo.junction (peer camp id for cross-camp spans),
 *   hobo.primitive = bindle | crew | actor (default bindle).
 *
 * Unknown services materialize stations/yards/camps/characters on demand so a
 * real OTLP exporter can point at POST /v1/traces with zero provisioning.
 */
import { type StringBag } from "./json.js";
import { syncLayout } from "./layout.js";
import {
	type AgentEvent,
	type Character,
	type OfficeState,
	type SpanKind,
	junctionForCamps,
} from "./model.js";
import type { TraceIndex } from "./trace-index.js";
import { isJsonString } from "./json.js";


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

export function attributesToRecord(attrs: OtlpAttribute[] | undefined): StringBag {
	const out: StringBag = {};
	for (const attr of attrs ?? []) {
		const v = attr.value;
		if (v.stringValue !== undefined) out[attr.key] = v.stringValue;
		else if (v.intValue !== undefined) out[attr.key] = String(v.intValue);
		else if (v.doubleValue !== undefined) out[attr.key] = String(v.doubleValue);
	}
	return out;
}

export function spanKindFromOtlp(kind: number | undefined): SpanKind {
	switch (kind) {
		case 2:
			return "server";
		case 3:
			return "client";
		case 4:
			return "producer";
		case 5:
			return "consumer";
		default:
			return "internal";
	}
}

function nanoToMs(value: string | number | undefined): number {
	if (value === undefined) return 0;
	const n = isJsonString(value) ? Number(value) : value;
	return Math.floor(n / 1_000_000);
}

interface PrimitiveKindByName {
	bindle: "bindle";
	crew: "crew";
	actor: "actor";
}

const PRIMITIVES: PrimitiveKindByName = {
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
	state: OfficeState,
	attrs: Record<string, string>,
	now: number,
): Character {
	const stationId = attrs["hobo.station"] ?? "default";
	const yardId = attrs["hobo.yard"] ?? "default";
	const campId = attrs["hobo.camp"] ?? "default";
	const serviceName = attrs["service.name"] ?? "unknown-service";
	const primitiveName = attrs["hobo.primitive"] ?? "bindle";
	// SAFETY: `PRIMITIVES[primitiveName as keyof PrimitiveKindByName]` is guarded by Object.hasOwn at this boundary.
	const kind =
		(Object.hasOwn(PRIMITIVES, primitiveName)
			? PRIMITIVES[primitiveName as keyof PrimitiveKindByName]
			: undefined) ?? "bindle";

	state.stations[stationId] ??= { id: stationId, name: stationId };
	state.yards[yardId] ??= { id: yardId, stationId, name: yardId };
	if (state.camps[campId] === undefined) {
		// Auto-layout: tile new rooms in a row under existing ones.
		const count = Object.keys(state.camps).length;
		state.camps[campId] = {
			id: campId,
			yardId,
			name: campId,
			rect: { x: 2 + (count % 4) * 14, y: 2 + Math.floor(count / 4) * 12, w: 12, h: 9 },
		};
	}
	const camp = state.camps[campId];
	const id = characterIdFor(stationId, serviceName);
	let ch = state.characters[id];
	if (ch === undefined && camp !== undefined) {
		const siblings = Object.values(state.characters).filter((c) => c.campId === campId).length;
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
	if (ch === undefined) throw new Error(`failed to materialize character ${id}`);
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
	state: OfficeState,
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
	for (const rs of payload.resourceSpans ?? []) {
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
		events.push({
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
			...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : undefined),
			junctionId: attrs["hobo.junction"],
		});
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
			child.span.parentSpanId !== undefined ? bySpanId.get(child.span.parentSpanId) : undefined;
		const fromIndex =
			inPayload === undefined && child.span.parentSpanId !== undefined
				? index?.lookup(child.span.traceId, child.span.parentSpanId, now)
				: undefined;
		const parentCampId = inPayload?.character.campId ?? fromIndex?.campId;
		let junctionId: string | undefined;
		let fromCampId: string | undefined;
		if (parentCampId !== undefined && parentCampId !== child.character.campId) {
			fromCampId = parentCampId;
			junctionId = junctionForCamps(state, fromCampId, child.character.campId)?.id;
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
