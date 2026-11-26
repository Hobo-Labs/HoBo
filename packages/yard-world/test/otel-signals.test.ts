import { describe, expect, it } from "vitest";
import { ActivityLog, applyEvent, emptyWorld } from "../src/model.js";
import {
	METRIC_HEALTH_MAP,
	mapLogsPayload,
	mapMetricsPayload,
	type OtlpLogsRequest,
	type OtlpMetricsRequest,
	severityFromOtlp,
} from "../src/otel-mapper.js";

const RESOURCE = [
	{ key: "service.name", value: { stringValue: "orders-api" } },
	{ key: "hobo.station", value: { stringValue: "s1" } },
	{ key: "hobo.camp", value: { stringValue: "camp-orders" } },
];

describe("severityFromOtlp", () => {
	it("maps OTLP severity number ranges", () => {
		expect(severityFromOtlp(5, undefined)).toBe("INFO");
		expect(severityFromOtlp(9, undefined)).toBe("INFO");
		expect(severityFromOtlp(13, undefined)).toBe("WARN");
		expect(severityFromOtlp(16, undefined)).toBe("WARN");
		expect(severityFromOtlp(17, undefined)).toBe("ERROR");
		expect(severityFromOtlp(24, undefined)).toBe("ERROR");
	});
	it("falls back to severity text", () => {
		expect(severityFromOtlp(undefined, "WARN")).toBe("WARN");
		expect(severityFromOtlp(undefined, "error")).toBe("ERROR");
		expect(severityFromOtlp(undefined, "FATAL")).toBe("ERROR");
		expect(severityFromOtlp(undefined, "debug")).toBe("INFO");
	});
});

function logsPayload(
	severityNumber: number,
	message: string,
	traceId?: string,
): OtlpLogsRequest {
	return {
		resourceLogs: [
			{
				resource: { attributes: RESOURCE },
				scopeLogs: [
					{
						logRecords: [
							{
								timeUnixNano: "2000000000",
								severityNumber,
								body: { stringValue: message },
								...(traceId !== undefined ? { traceId } : {}),
							},
						],
					},
				],
			},
		],
	};
}

describe("mapLogsPayload", () => {
	it("WARN logs raise a bubble and land in the activity log", () => {
		const state = emptyWorld();
		const events = mapLogsPayload(
			logsPayload(13, "queue lag rising"),
			state,
			5_000,
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "log-record",
			severity: "WARN",
			characterId: "s1/orders-api",
			at: 2000, // timeUnixNano 2_000_000_000 ns → 2000 ms
		});
		const next = applyEvent(state, events[0] ?? ({} as never));
		expect(next.characters["s1/orders-api"]?.bubble).toBe("queue lag rising");
	});

	it("ERROR logs flip the character to stuck attention", () => {
		const state = emptyWorld();
		const events = mapLogsPayload(logsPayload(17, "boom"), state, 5_000);
		const next = applyEvent(state, events[0] ?? ({} as never));
		const ch = next.characters["s1/orders-api"];
		expect(ch?.state).toBe("stuck");
		expect(ch?.bubble).toBe("boom");
	});

	it("INFO logs stay quiet (no bubble)", () => {
		const state = emptyWorld();
		const events = mapLogsPayload(logsPayload(9, "all good"), state, 5_000);
		const next = applyEvent(state, events[0] ?? ({} as never));
		expect(next.characters["s1/orders-api"]?.bubble).toBeUndefined();
	});

	it("carries the trace id into the activity log", () => {
		const state = emptyWorld();
		const log = new ActivityLog();
		for (const event of mapLogsPayload(
			logsPayload(13, "lag", "trace-xyz"),
			state,
			5_000,
		)) {
			log.record(event);
		}
		expect(log.for("s1/orders-api").logs[0]?.traceId).toBe("trace-xyz");
	});

	it("auto-materializes unknown services like the trace mapper", () => {
		const state = emptyWorld();
		mapLogsPayload(logsPayload(9, "hi"), state, 5_000);
		expect(state.characters["s1/orders-api"]).toBeDefined();
	});
});

describe("mapMetricsPayload", () => {
	it("hobo.health gauge drives the health bar directly", () => {
		const state = emptyWorld();
		const payload: OtlpMetricsRequest = {
			resourceMetrics: [
				{
					resource: { attributes: RESOURCE },
					scopeMetrics: [
						{
							metrics: [
								{
									name: "hobo.health",
									gauge: {
										dataPoints: [
											{ asDouble: 0.35, timeUnixNano: "1000000000" },
										],
									},
								},
							],
						},
					],
				},
			],
		};
		const events = mapMetricsPayload(payload, state, 5_000);
		expect(events[0]).toMatchObject({
			type: "metric-sample",
			metric: "health",
			value: 0.35,
		});
		const next = applyEvent(state, events[0] ?? ({} as never));
		expect(next.characters["s1/orders-api"]?.health).toBe(0.35);
	});

	it("hobo.error.rate sum derives health as 1 - rate", () => {
		const state = emptyWorld();
		const payload: OtlpMetricsRequest = {
			resourceMetrics: [
				{
					resource: { attributes: RESOURCE },
					scopeMetrics: [
						{
							metrics: [
								{
									name: "hobo.error.rate",
									sum: { dataPoints: [{ asDouble: 0.2 }] },
								},
							],
						},
					],
				},
			],
		};
		const events = mapMetricsPayload(payload, state, 5_000);
		expect(events[0]).toMatchObject({ metric: "health", value: 0.8 });
	});

	it("unknown metric names land in the activity log without touching health", () => {
		const state = emptyWorld();
		const payload: OtlpMetricsRequest = {
			resourceMetrics: [
				{
					resource: { attributes: RESOURCE },
					scopeMetrics: [
						{
							metrics: [
								{ name: "queue.depth", gauge: { dataPoints: [{ asInt: 42 }] } },
							],
						},
					],
				},
			],
		};
		const events = mapMetricsPayload(payload, state, 5_000);
		expect(events[0]).toMatchObject({ metric: "queue.depth", value: 42 });
		let next = state;
		const log = new ActivityLog();
		for (const event of events) {
			next = applyEvent(next, event);
			log.record(event);
		}
		expect(next.characters["s1/orders-api"]?.health).toBe(1);
		expect(log.for("s1/orders-api").metrics[0]).toMatchObject({
			metric: "queue.depth",
			value: 42,
		});
	});

	it("accepts asInt gauges and clamps mapped health into 0..1", () => {
		expect(METRIC_HEALTH_MAP["hobo.error.rate"]?.(1.5)).toBe(-0.5);
		const state = emptyWorld();
		const payload: OtlpMetricsRequest = {
			resourceMetrics: [
				{
					resource: { attributes: RESOURCE },
					scopeMetrics: [
						{
							metrics: [
								{ name: "hobo.health", gauge: { dataPoints: [{ asInt: 7 }] } },
							],
						},
					],
				},
			],
		};
		const events = mapMetricsPayload(payload, state, 5_000);
		expect(events[0]).toMatchObject({ metric: "health", value: 1 });
	});
});
