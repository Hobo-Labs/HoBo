// WP19 Accept: "yard-world renders a promotion trace". The golden OTLP trace
// in cd-promotion-trace.otlp.json was produced by @hobo/cd's own span builder
// and OTLP encoder (promotion `web`: staging-eu, then prod-eu + prod-us, with
// prod-us failing). Plus the fleet views: Camps by condition and taint, and
// the compliance heatmap by Rail and control.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	COMPLIANCE_WATCH_RATIO,
	complianceHeatmap,
	emptyWorld,
	fleetView,
	freightTimeline,
	heatBand,
	liftCdTopology,
	mapTracePayload,
	type OtlpMetricsRequest,
	type OtlpTraceRequest,
	parseCdSpans,
	pipelineGraph,
	renderPromotionTrace,
} from "../src/index.js";

const TRACE: OtlpTraceRequest = JSON.parse(
	readFileSync(
		new URL("./cd-promotion-trace.otlp.json", import.meta.url),
		"utf8",
	),
);
const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const MIN = 60_000;
const FREIGHT = "sha256:5e1f";

describe("renderPromotionTrace", () => {
	it("renders a promotion trace onto Camps and Stations", () => {
		const r = renderPromotionTrace(TRACE, T0 + 40 * MIN);
		expect(Object.keys(r.world.stations).sort()).toEqual([
			"station-eu",
			"station-us",
		]);
		expect(r.world.camps["prod-us"]?.yardId).toBe("yard-us");
		expect(r.world.yards["yard-us"]?.stationId).toBe("station-us");
		const delivery = (station: string, campId: string) =>
			r.world.characters[`${station}/hobo-cd@${campId}`];
		for (const [station, campId] of [
			["station-eu", "staging-eu"],
			["station-eu", "prod-eu"],
			["station-us", "prod-us"],
		] as const) {
			expect(delivery(station, campId)).toMatchObject({
				kind: "actor",
				campId,
				stationId: station,
			});
		}
		// Every CD span became a started+ended pair in the world event stream.
		expect(r.events.filter((e) => e.type === "span-started")).toHaveLength(5);
		expect(r.events.filter((e) => e.type === "span-ended")).toHaveLength(5);
		const failed = r.events.find(
			(e) =>
				e.type === "span-ended" &&
				e.characterId === "station-us/hobo-cd@prod-us",
		);
		expect(failed).toMatchObject({ status: "error" });
		// The multi-Camp run span stays with the CD service itself.
		expect(r.world.characters["station-eu/hobo-cd"]?.campId).toBe("default");
	});

	it("projects the Freight timeline", () => {
		const r = renderPromotionTrace(TRACE, T0 + 40 * MIN);
		expect(r.timeline).toEqual([
			{
				freightId: FREIGHT,
				entries: [
					{
						freightId: FREIGHT,
						runId: "promo_staging",
						pipeline: "web",
						node: "staging",
						campId: "staging-eu",
						stationId: "station-eu",
						environment: "staging",
						result: "success",
						startMs: T0,
						endMs: T0 + 3 * MIN,
					},
					expect.objectContaining({
						runId: "promo_prod",
						campId: "prod-eu",
						result: "success",
						startMs: T0 + 20 * MIN,
						endMs: T0 + 26 * MIN,
					}),
					expect.objectContaining({
						runId: "promo_prod",
						campId: "prod-us",
						stationId: "station-us",
						result: "failure",
						endMs: T0 + 31 * MIN,
					}),
				],
			},
		]);
	});

	it("projects the pipeline graph", () => {
		const r = renderPromotionTrace(TRACE, T0 + 40 * MIN);
		expect(r.graph).toEqual([
			{
				pipeline: "web",
				nodes: [
					{
						id: "staging",
						camps: ["staging-eu"],
						lastFreightId: FREIGHT,
						lastResult: "success",
						lastAtMs: T0,
					},
					{
						id: "prod",
						camps: ["prod-eu", "prod-us"],
						lastFreightId: FREIGHT,
						lastResult: "failure",
						lastAtMs: T0 + 20 * MIN,
					},
				],
				edges: [{ from: "staging", to: "prod", freightCount: 1 }],
			},
		]);
	});

	it("is deterministic and independent of span order within the payload", () => {
		const reversed: OtlpTraceRequest = {
			resourceSpans: (TRACE.resourceSpans ?? []).map((rs) => ({
				...rs,
				scopeSpans: (rs.scopeSpans ?? []).map((ss) => ({
					...ss,
					spans: [...(ss.spans ?? [])].reverse(),
				})),
			})),
		};
		const a = renderPromotionTrace(TRACE, T0);
		const b = renderPromotionTrace(reversed, T0);
		expect(b.timeline).toEqual(a.timeline);
		expect(b.graph).toEqual(a.graph);
	});

	it("does not mutate the world it starts from", () => {
		const world = emptyWorld();
		renderPromotionTrace(TRACE, T0, world);
		expect(world).toEqual(emptyWorld());
	});
});

describe("CD span parsing and topology lift", () => {
	it("parses only CD spans", () => {
		const mixed: OtlpTraceRequest = {
			resourceSpans: [
				...(TRACE.resourceSpans ?? []),
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: "api" } },
						],
					},
					scopeSpans: [
						{
							spans: [
								{
									traceId: "a".repeat(32),
									spanId: "b".repeat(16),
									name: "GET /",
								},
							],
						},
					],
				},
			],
		};
		expect(parseCdSpans(mixed)).toHaveLength(5);
	});

	it("leaves spans without hobo.camp.id and explicit hobo.camp resources alone", () => {
		const plain: OtlpTraceRequest = {
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: "api" } },
							{ key: "hobo.camp", value: { stringValue: "web" } },
						],
					},
					scopeSpans: [
						{
							spans: [
								{
									traceId: "a".repeat(32),
									spanId: "b".repeat(16),
									name: "x",
									attributes: [
										{ key: "hobo.camp.id", value: { stringValue: "other" } },
									],
								},
							],
						},
					],
				},
			],
		};
		expect(liftCdTopology(plain)).toEqual(plain);
		const state = emptyWorld();
		mapTracePayload(plain, state, T0);
		expect(Object.keys(state.camps)).toEqual(["web"]);
	});

	it("an executing run shows as pending", () => {
		const open: OtlpTraceRequest = {
			resourceSpans: [
				{
					scopeSpans: [
						{
							spans: [
								{
									traceId: "c".repeat(32),
									spanId: "d".repeat(16),
									name: "promote c-1",
									startTimeUnixNano: `${T0}000000`,
									attributes: [
										{
											key: "cicd.pipeline.run.id",
											value: { stringValue: "p" },
										},
										{
											key: "cicd.pipeline.task.name",
											value: { stringValue: "promote c-1" },
										},
										{
											key: "hobo.freight.id",
											value: { stringValue: "sha256:x" },
										},
										{ key: "hobo.camp.id", value: { stringValue: "c-1" } },
									],
								},
							],
						},
					],
				},
			],
		};
		const [timeline] = freightTimeline(parseCdSpans(open));
		expect(timeline?.entries[0]?.result).toBe("pending");
		expect(pipelineGraph(parseCdSpans(open))[0]?.nodes[0]?.id).toBe("c-1");
	});
});

function gauge(
	name: string,
	attrs: Record<string, string>,
	value: number,
	atMs = T0,
) {
	return {
		name,
		unit: "1",
		gauge: {
			dataPoints: [
				{
					attributes: Object.entries(attrs).map(([key, v]) => ({
						key,
						value: { stringValue: v },
					})),
					timeUnixNano: `${atMs}000000`,
					...(Number.isInteger(value)
						? { asInt: String(value) }
						: { asDouble: value }),
				},
			],
		},
	};
}

function metrics(list: ReturnType<typeof gauge>[]): OtlpMetricsRequest {
	return { resourceMetrics: [{ scopeMetrics: [{ metrics: list }] }] };
}

describe("fleet views", () => {
	it("groups Camps by condition and taint", () => {
		const cond = (camp: string, condition: string, status: string) =>
			gauge(
				"hobo.cd.camp.condition",
				{
					"hobo.camp.id": camp,
					"hobo.camp.condition": condition,
					"hobo.camp.condition.status": status,
				},
				1,
			);
		const view = fleetView(
			metrics([
				cond("c2", "reachable", "false"),
				cond("c1", "reachable", "true"),
				cond("c1", "ready", "true"),
				gauge(
					"hobo.cd.camp.taint",
					{
						"hobo.camp.id": "c2",
						"hobo.camp.taint.key": "region-down",
						"hobo.camp.taint.effect": "no_run",
					},
					1,
				),
			]),
		);
		expect(view.camps.map((c) => c.campId)).toEqual(["c1", "c2"]);
		expect(view.byCondition).toEqual({
			reachable: { true: ["c1"], false: ["c2"] },
			ready: { true: ["c1"] },
		});
		expect(view.byTaint).toEqual({ no_run: ["c2"] });
		expect(view.untainted).toEqual(["c1"]);
	});

	it("builds the compliance heatmap by Rail and control", () => {
		const ratio = (
			rail: string,
			control: string,
			value: number,
			atMs = T0,
			mode = "enforce",
		) =>
			gauge(
				"hobo.cd.compliance.noncompliant_ratio",
				{
					"hobo.rail.digest": rail,
					"hobo.policy.control": control,
					"hobo.policy.mode": mode,
				},
				value,
				atMs,
			);
		const map = complianceHeatmap(
			metrics([
				ratio("sha256:b", "SC-7", 0.5),
				ratio("sha256:a", "AC-2", 0.5, T0),
				ratio("sha256:a", "AC-2", 0, T0 + MIN), // latest wins
				ratio("sha256:a", "*", 0.01),
				ratio("sha256:b", "*", 0.25, T0, "inform"),
			]),
		);
		expect(map.rails).toEqual(["sha256:a", "sha256:b"]);
		expect(map.controls).toEqual(["*", "AC-2", "SC-7"]);
		expect(map.cells).toEqual([
			{
				rail: "sha256:a",
				control: "*",
				mode: "enforce",
				ratio: 0.01,
				band: "watch",
			},
			{
				rail: "sha256:a",
				control: "AC-2",
				mode: "enforce",
				ratio: 0,
				band: "ok",
			},
			{
				rail: "sha256:b",
				control: "*",
				mode: "inform",
				ratio: 0.25,
				band: "breach",
			},
			{
				rail: "sha256:b",
				control: "SC-7",
				mode: "enforce",
				ratio: 0.5,
				band: "breach",
			},
		]);
	});

	it("bands follow the R12 INFORM budget", () => {
		expect(heatBand(0)).toBe("ok");
		expect(heatBand(COMPLIANCE_WATCH_RATIO)).toBe("watch");
		expect(heatBand(COMPLIANCE_WATCH_RATIO + 0.001)).toBe("breach");
	});
});
