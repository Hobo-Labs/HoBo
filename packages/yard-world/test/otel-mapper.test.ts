/**
 * Every case is a line in `otel-mapper.cases.jsonl`.
 *
 * Two payload fixtures live here rather than in the data: the single-span one
 * that most cases vary a field of, and the cross-camp parent/child pair that
 * the junction cases slice up. Everything else — which world to start from,
 * whether a trace index is in play, which emitted events get folded back — is
 * a field in the case.
 */

import { describeConcern } from "@hobo/contract-harness";
import { applyEvent, emptyWorld, visibleCharacters } from "../src/model.js";
import {
	mapTracePayload,
	type OtlpTraceRequest,
	spanKindFromOtlp,
} from "../src/otel-mapper.js";
import { TraceIndex } from "../src/trace-index.js";

interface PayloadOverrides {
	readonly station?: string;
	readonly service?: string;
	readonly primitive?: string;
	readonly kind?: number;
	readonly statusCode?: number;
	readonly spanAttrs?: { key: string; value: { stringValue: string } }[];
}

function onePayload(overrides: PayloadOverrides = {}): OtlpTraceRequest {
	const attributes = [
		{
			key: "service.name",
			value: { stringValue: overrides.service ?? "orders-api" },
		},
		{
			key: "hobo.station",
			value: { stringValue: overrides.station ?? "station-a" },
		},
		{ key: "hobo.yard", value: { stringValue: "yard-1" } },
		{ key: "hobo.camp", value: { stringValue: "camp-orders" } },
	];
	if (overrides.primitive !== undefined)
		attributes.push({
			key: "hobo.primitive",
			value: { stringValue: overrides.primitive },
		});
	return {
		resourceSpans: [
			{
				resource: { attributes },
				scopeSpans: [
					{
						spans: [
							{
								traceId: "abc",
								spanId: "sp-1",
								name: "op",
								kind: overrides.kind ?? 2,
								startTimeUnixNano: "1000000000",
								endTimeUnixNano: "1500000000",
								status: { code: overrides.statusCode ?? 1 },
								attributes: overrides.spanAttrs,
							},
						],
					},
				],
			},
		],
	};
}

const resource = (service: string, camp: string) => ({
	attributes: [
		{ key: "service.name", value: { stringValue: service } },
		{ key: "hobo.station", value: { stringValue: "s1" } },
		{ key: "hobo.camp", value: { stringValue: camp } },
	],
});

/** A client span in one camp and its server child in another. */
function crossCampPayload(childCamp = "camp-b"): OtlpTraceRequest {
	return {
		resourceSpans: [
			{
				resource: resource("web", "camp-a"),
				scopeSpans: [
					{
						spans: [
							{
								traceId: "trace-x",
								spanId: "parent-1",
								name: "POST /orders",
								kind: 3,
								startTimeUnixNano: "1000000000",
								endTimeUnixNano: "2000000000",
								status: { code: 1 },
							},
						],
					},
				],
			},
			{
				resource: resource("orders", childCamp),
				scopeSpans: [
					{
						spans: [
							{
								traceId: "trace-x",
								spanId: "child-1",
								parentSpanId: "parent-1",
								name: "POST /orders",
								kind: 2,
								startTimeUnixNano: "1100000000",
								endTimeUnixNano: "1900000000",
								status: { code: 1 },
							},
						],
					},
				],
			},
		],
	};
}

const PRESETS: Record<string, () => OtlpTraceRequest> = {
	"cross-camp": () => crossCampPayload(),
	"cross-camp-same-camp": () => crossCampPayload("camp-a"),
	"cross-camp-parent-only": () => ({
		resourceSpans: crossCampPayload().resourceSpans?.slice(0, 1),
	}),
	"cross-camp-child-only": () => ({
		resourceSpans: crossCampPayload().resourceSpans?.slice(1),
	}),
};

function worldWithCampsAndJunction() {
	const state = emptyWorld();
	state.stations.s1 = { id: "s1", name: "s1" };
	state.yards.y1 = { id: "y1", stationId: "s1", name: "y1" };
	state.camps["camp-a"] = {
		id: "camp-a",
		yardId: "y1",
		name: "a",
		rect: { x: 0, y: 0, w: 8, h: 6 },
	};
	state.camps["camp-b"] = {
		id: "camp-b",
		yardId: "y1",
		name: "b",
		rect: { x: 10, y: 0, w: 8, h: 6 },
	};
	state.junctions.j1 = {
		id: "j1",
		name: "a↔b",
		fromCampId: "camp-a",
		toCampId: "camp-b",
		corridor: [
			{ x: 8, y: 3 },
			{ x: 9, y: 3 },
		],
	};
	return state;
}

interface Submission {
	readonly preset?: keyof typeof PRESETS;
	readonly payload?: PayloadOverrides;
	/** Spelled out where no fixture fits — a junction attribute with no parent. */
	readonly raw?: OtlpTraceRequest;
	readonly nowMs?: number;
	/**
	 * Which emitted events to fold back into the world.
	 *
	 * `except-ended` keeps a span open on purpose: a packet only exists while
	 * its server span is still running, so folding `span-ended` would erase the
	 * very thing the case is about.
	 */
	readonly apply?: "all" | "started" | "except-ended" | "none";
}

interface Ask {
	readonly world?: "empty" | "camps-and-junction";
	/** Present means a TraceIndex is threaded through every submission. */
	readonly index?: { readonly ttlMs?: number; readonly sweepMs?: number };
	readonly submissions: readonly Submission[];
	/** Stations whose visible character ids the case asserts on. */
	readonly visibleIn?: readonly string[];
}

function payloadOf(submission: Submission): OtlpTraceRequest {
	if (submission.raw) return submission.raw;
	if (submission.preset) return PRESETS[submission.preset]?.() ?? {};
	return onePayload(submission.payload);
}

const KEEP: Record<string, (type: string) => boolean> = {
	all: () => true,
	started: (type) => type === "span-started",
	"except-ended": (type) => type !== "span-ended",
	none: () => false,
};

function run(ask: Ask) {
	let state =
		ask.world === "camps-and-junction"
			? worldWithCampsAndJunction()
			: emptyWorld();
	const index =
		ask.index === undefined
			? undefined
			: new TraceIndex(ask.index.ttlMs, ask.index.sweepMs);
	let events: readonly { type: string }[] = [];
	for (const submission of ask.submissions) {
		events = mapTracePayload(
			payloadOf(submission),
			state,
			submission.nowMs,
			index,
		);
		const keep = KEEP[submission.apply ?? "all"] ?? KEEP.all;
		for (const event of events)
			if (keep(event.type)) state = applyEvent(state, event);
	}
	return { state, events, index };
}

describeConcern("otel mapper", {
	cases: `${import.meta.dirname}/otel-mapper.cases.jsonl`,
	subject: () => ({
		spanKindFromOtlp,
		/** The last submission's events plus the world they fold into. */
		after: (ask: Ask) => {
			const { state, events, index } = run(ask);
			return {
				events: events as readonly Record<string, unknown>[],
				eventTypes: events.map((event) => event.type),
				characters: state.characters,
				packetIds: Object.keys(state.packets).sort(),
				indexSize: index?.size ?? null,
				visibleIn: Object.fromEntries(
					(ask.visibleIn ?? []).map((station) => [
						station,
						visibleCharacters(state, station).map((character) => character.id),
					]),
				),
			};
		},
	}),
});
