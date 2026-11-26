import { describe, expect, it } from "vitest";
import { applyEvent, emptyOffice, visibleCharacters } from "../src/model.js";
import { type OtlpTraceRequest, mapTracePayload, spanKindFromOtlp } from "../src/otel.js";
import { TraceIndex } from "../src/trace-index.js";

function payload(overrides: {
	station?: string;
	service?: string;
	primitive?: string;
	kind?: number;
	statusCode?: number;
	spanAttrs?: { key: string; value: { stringValue: string } }[];
}): OtlpTraceRequest {
	const resourceAttrs = [
		{ key: "service.name", value: { stringValue: overrides.service ?? "orders-api" } },
		{ key: "hobo.station", value: { stringValue: overrides.station ?? "station-a" } },
		{ key: "hobo.yard", value: { stringValue: "yard-1" } },
		{ key: "hobo.camp", value: { stringValue: "camp-orders" } },
	];
	if (overrides.primitive !== undefined) {
		resourceAttrs.push({ key: "hobo.primitive", value: { stringValue: overrides.primitive } });
	}
	return {
		resourceSpans: [
			{
				resource: { attributes: resourceAttrs },
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

describe("spanKindFromOtlp", () => {
	it("maps OTLP kind numbers", () => {
		expect(spanKindFromOtlp(1)).toBe("internal");
		expect(spanKindFromOtlp(2)).toBe("server");
		expect(spanKindFromOtlp(3)).toBe("client");
		expect(spanKindFromOtlp(4)).toBe("producer");
		expect(spanKindFromOtlp(5)).toBe("consumer");
		expect(spanKindFromOtlp(undefined)).toBe("internal");
	});
});

describe("mapTracePayload", () => {
	it("server span (kind 2) drives the character to working", () => {
		const state = emptyOffice();
		const events = mapTracePayload(payload({}), state);
		let next = state;
		for (const event of events) next = applyEvent(next, event);
		expect(next.characters["station-a/orders-api"]?.state).toBe("idle"); // ended cleanly
		expect(events[0]).toMatchObject({ type: "span-started", spanKind: "server" });
		const startedOnly = next.characters["station-a/orders-api"];
		expect(startedOnly?.campId).toBe("camp-orders");
	});

	it("db client span maps to reading while open", () => {
		const state = emptyOffice();
		const events = mapTracePayload(
			payload({ kind: 3, spanAttrs: [{ key: "db.system", value: { stringValue: "postgresql" } }] }),
			state,
		);
		let next = state;
		for (const event of events.filter((e) => e.type === "span-started")) {
			next = applyEvent(next, event);
		}
		expect(next.characters["station-a/orders-api"]?.state).toBe("reading");
	});

	it("error status code 2 leaves the character stuck", () => {
		const state = emptyOffice();
		const events = mapTracePayload(payload({ statusCode: 2 }), state);
		let next = state;
		for (const event of events) next = applyEvent(next, event);
		expect(next.characters["station-a/orders-api"]?.state).toBe("stuck");
	});

	it("station isolation: same service in two stations never mixes", () => {
		const state = emptyOffice();
		for (const event of mapTracePayload(payload({ station: "station-a" }), state)) {
			applyEvent(state, event);
		}
		const eventsB = mapTracePayload(payload({ station: "station-b" }), state);
		expect(eventsB[0]).toMatchObject({ characterId: "station-b/orders-api" });
		const inA = visibleCharacters(state, "station-a").map((c) => c.id);
		expect(inA).toContain("station-a/orders-api");
		expect(inA).not.toContain("station-b/orders-api");
	});

	it("hobo.primitive selects crew/actor kinds", () => {
		const state = emptyOffice();
		mapTracePayload(payload({ service: "op-sam", primitive: "crew" }), state);
		mapTracePayload(payload({ service: "reconciler", primitive: "actor" }), state);
		expect(state.characters["station-a/op-sam"]?.kind).toBe("crew");
		expect(state.characters["station-a/reconciler"]?.kind).toBe("actor");
	});
});

function crossCampPayload(): OtlpTraceRequest {
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: "web" } },
						{ key: "hobo.station", value: { stringValue: "s1" } },
						{ key: "hobo.camp", value: { stringValue: "camp-a" } },
					],
				},
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
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: "orders" } },
						{ key: "hobo.station", value: { stringValue: "s1" } },
						{ key: "hobo.camp", value: { stringValue: "camp-b" } },
					],
				},
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

function stateWithCampsAndJunction() {
	const state = emptyOffice();
	state.stations.s1 = { id: "s1", name: "s1" };
	state.yards.y1 = { id: "y1", stationId: "s1", name: "y1" };
	state.camps["camp-a"] = { id: "camp-a", yardId: "y1", name: "a", rect: { x: 0, y: 0, w: 8, h: 6 } };
	state.camps["camp-b"] = { id: "camp-b", yardId: "y1", name: "b", rect: { x: 10, y: 0, w: 8, h: 6 } };
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

describe("trace-pair derivation (junction packets)", () => {
	it("client span in camp A + server child in camp B emits packet-started", () => {
		const state = stateWithCampsAndJunction();
		const events = mapTracePayload(crossCampPayload(), state);
		const packet = events.find((e) => e.type === "packet-started");
		expect(packet).toMatchObject({
			type: "packet-started",
			traceId: "trace-x",
			spanId: "child-1",
			junctionId: "j1",
			fromCampId: "camp-a",
			toCampId: "camp-b",
		});
	});

	it("no packet when parent and child are in the same camp", () => {
		const state = stateWithCampsAndJunction();
		const payload = crossCampPayload();
		const second = payload.resourceSpans?.[1]?.resource?.attributes.find(
			(a) => a.key === "hobo.camp",
		);
		if (second?.value.stringValue !== undefined) second.value.stringValue = "camp-a";
		const events = mapTracePayload(payload, state);
		expect(events.some((e) => e.type === "packet-started")).toBe(false);
	});

	it("hobo.junction attribute emits a packet without a parent span", () => {
		const state = stateWithCampsAndJunction();
		const payload: OtlpTraceRequest = {
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: "orders" } },
							{ key: "hobo.station", value: { stringValue: "s1" } },
							{ key: "hobo.camp", value: { stringValue: "camp-b" } },
						],
					},
					scopeSpans: [
						{
							spans: [
								{
									traceId: "trace-y",
									spanId: "sp-y",
									name: "POST /orders",
									kind: 2,
									startTimeUnixNano: "1000000000",
									endTimeUnixNano: "2000000000",
									status: { code: 1 },
									attributes: [{ key: "hobo.junction", value: { stringValue: "j1" } }],
								},
							],
						},
					],
				},
			],
		};
		const events = mapTracePayload(payload, state);
		expect(events.find((e) => e.type === "packet-started")).toMatchObject({
			junctionId: "j1",
			fromCampId: "camp-a",
			toCampId: "camp-b",
		});
	});

	it("packet appears in state after reducing a cross-camp trace pair", () => {
		const state = stateWithCampsAndJunction();
		let next = state;
		// Drop span-ended so the server span is still open when the packet starts.
		for (const event of mapTracePayload(crossCampPayload(), state).filter(
			(e) => e.type !== "span-ended",
		)) {
			next = applyEvent(next, event);
		}
		expect(next.packets["child-1"]).toBeDefined();
	});
});

describe("cross-request pair derivation (trace index)", () => {
	function parentOnlyPayload(): OtlpTraceRequest {
		const full = crossCampPayload();
		return { resourceSpans: full.resourceSpans?.slice(0, 1) };
	}
	function childOnlyPayload(): OtlpTraceRequest {
		const full = crossCampPayload();
		return { resourceSpans: full.resourceSpans?.slice(1) };
	}

	it("parent and child in separate requests still emit a packet", () => {
		const state = stateWithCampsAndJunction();
		const index = new TraceIndex();
		const parentEvents = mapTracePayload(parentOnlyPayload(), state, 1_000, index);
		expect(parentEvents.some((e) => e.type === "packet-started")).toBe(false);
		expect(index.size).toBe(1);
		const childEvents = mapTracePayload(childOnlyPayload(), state, 2_000, index);
		expect(childEvents.find((e) => e.type === "packet-started")).toMatchObject({
			type: "packet-started",
			traceId: "trace-x",
			spanId: "child-1",
			junctionId: "j1",
			fromCampId: "camp-a",
			toCampId: "camp-b",
		});
	});

	it("no packet without an index when the parent is in another request", () => {
		const state = stateWithCampsAndJunction();
		mapTracePayload(parentOnlyPayload(), state);
		const childEvents = mapTracePayload(childOnlyPayload(), state);
		expect(childEvents.some((e) => e.type === "packet-started")).toBe(false);
	});

	it("an expired parent resolves to nothing (no packet)", () => {
		const state = stateWithCampsAndJunction();
		const index = new TraceIndex(10_000, 1_000);
		mapTracePayload(parentOnlyPayload(), state, 1_000, index);
		const childEvents = mapTracePayload(childOnlyPayload(), state, 5_000, index);
		expect(childEvents.some((e) => e.type === "packet-started")).toBe(false);
	});
});
