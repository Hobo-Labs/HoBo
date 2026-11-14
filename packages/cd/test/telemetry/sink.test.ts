// createTelemetrySink: OTLP/HTTP JSON over HttpTransport with batching and
// retry (WP19, D17). Deterministic: sleep is injected, backoff has no jitter.
import type { TransportRequest, TransportResponse } from "@hobo/core";
import { describe, expect, it } from "vitest";
import type { OtelMetricPoint, OtelSpan } from "../../src/ports.js";
import {
	createTelemetrySink,
	encodeMetrics,
	OTLP_DEFAULTS,
	parseOtlpEndpoint,
	TELEMETRY_FAILURES,
	TelemetryError,
} from "../../src/telemetry/index.js";
import { T0 } from "../authz/memory-store.js";

function span(i: number): OtelSpan {
	return {
		name: `RUN p${i}`,
		traceId: i.toString(16).padStart(32, "0"),
		spanId: i.toString(16).padStart(16, "0"),
		kind: "server",
		startMs: T0,
		endMs: T0 + 1_500,
		status: "ok",
		attributes: { "cicd.pipeline.name": `p${i}` },
	};
}

function recorder(answers: Array<TransportResponse | Error>) {
	const requests: TransportRequest[] = [];
	const sleeps: number[] = [];
	const http = async (
		request: TransportRequest,
	): Promise<TransportResponse> => {
		requests.push(request);
		const answer = answers.shift() ?? { status: 200, headers: {}, body: "{}" };
		if (answer instanceof Error) throw answer;
		return answer;
	};
	const sleep = async (ms: number) => {
		sleeps.push(ms);
	};
	return { requests, sleeps, http, sleep };
}

const ok = (): TransportResponse => ({ status: 200, headers: {}, body: "{}" });
const status = (
	code: number,
	headers: Record<string, string> = {},
): TransportResponse => ({
	status: code,
	headers,
	body: "",
});

describe("createTelemetrySink", () => {
	it("posts spans to <endpoint>/v1/traces with configured headers and bounds", async () => {
		const r = recorder([ok()]);
		const sink = createTelemetrySink({
			endpoint: "https://otel.example.test/",
			http: r.http,
			headers: { Authorization: "Bearer test-token" },
			sleep: r.sleep,
		});
		await sink.spans([span(1)]);
		expect(sink.endpoint).toBe("https://otel.example.test");
		const [request] = r.requests;
		expect(request).toMatchObject({
			method: "POST",
			url: "https://otel.example.test/v1/traces",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
			},
			timeoutMs: OTLP_DEFAULTS.timeoutMs,
			maxResponseBytes: OTLP_DEFAULTS.maxResponseBytes,
		});
		const body = JSON.parse(request?.body ?? "{}");
		expect(body.resourceSpans[0].resource.attributes).toEqual([
			{ key: "service.name", value: { stringValue: "hobo-cd" } },
		]);
		expect(body.resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({
			name: "RUN p1",
			kind: 2,
			startTimeUnixNano: `${T0}000000`,
			endTimeUnixNano: `${T0 + 1_500}000000`,
		});
		expect(sink.stats()).toMatchObject({
			requests: 1,
			exportedSpans: 1,
			retries: 0,
		});
	});

	it("defaults to the local collector", () => {
		expect(createTelemetrySink({ http: async () => ok() }).endpoint).toBe(
			OTLP_DEFAULTS.endpoint,
		);
	});

	it("batches: never more than maxBatch items per request", async () => {
		const r = recorder([]);
		const sink = createTelemetrySink({
			http: r.http,
			maxBatch: 2,
			sleep: r.sleep,
		});
		await sink.spans([1, 2, 3, 4, 5].map(span));
		const sizes = r.requests.map(
			(q) =>
				JSON.parse(q.body ?? "{}").resourceSpans[0].scopeSpans[0].spans.length,
		);
		expect(sizes).toEqual([2, 2, 1]);
		await sink.spans([]);
		expect(r.requests).toHaveLength(3);
	});

	it("retries 429/502/503/504 and transport errors with capped exponential backoff", async () => {
		const r = recorder([
			status(503),
			new Error("ECONNRESET"),
			status(502),
			status(504),
			ok(),
		]);
		const sink = createTelemetrySink({
			http: r.http,
			sleep: r.sleep,
			maxAttempts: 5,
			backoffBaseMs: 1_000,
			backoffMaxMs: 5_000,
		});
		await sink.spans([span(1)]);
		expect(r.sleeps).toEqual([1_000, 2_000, 4_000, 5_000]);
		expect(sink.stats()).toMatchObject({
			requests: 5,
			retries: 4,
			exportedSpans: 1,
		});
	});

	it("honours Retry-After, capped at the backoff maximum", async () => {
		const r = recorder([status(429, { "retry-after": "120" }), ok()]);
		const sink = createTelemetrySink({
			http: r.http,
			sleep: r.sleep,
			backoffMaxMs: 30_000,
		});
		await sink.spans([span(1)]);
		expect(r.sleeps).toEqual([30_000]);
	});

	it("gives up after maxAttempts with otlp-retries-exhausted and counts the drop", async () => {
		const r = recorder([status(503), status(503), status(503)]);
		const sink = createTelemetrySink({
			http: r.http,
			sleep: r.sleep,
			maxAttempts: 3,
		});
		const failure = await sink.spans([span(1), span(2)]).catch((e) => e);
		expect(failure).toBeInstanceOf(TelemetryError);
		expect(failure).toMatchObject({
			code: "otlp-retries-exhausted",
			status: 503,
			remediation: TELEMETRY_FAILURES["otlp-retries-exhausted"].remediation,
		});
		expect(r.requests).toHaveLength(3);
		expect(sink.stats()).toMatchObject({
			droppedSpans: 2,
			exportedSpans: 0,
			lastError: { code: "otlp-retries-exhausted" },
		});
	});

	it("does not retry a non-retryable status", async () => {
		const r = recorder([status(401)]);
		const sink = createTelemetrySink({ http: r.http, sleep: r.sleep });
		await expect(sink.metrics([point(1)])).rejects.toMatchObject({
			code: "otlp-rejected",
			status: 401,
		});
		expect(r.requests).toHaveLength(1);
		expect(r.sleeps).toEqual([]);
	});

	it("keeps exporting later batches after one fails, then reports the first error", async () => {
		const r = recorder([status(400), ok()]);
		const sink = createTelemetrySink({
			http: r.http,
			sleep: r.sleep,
			maxBatch: 1,
		});
		await expect(sink.spans([span(1), span(2)])).rejects.toMatchObject({
			code: "otlp-rejected",
		});
		expect(sink.stats()).toMatchObject({ exportedSpans: 1, droppedSpans: 1 });
	});

	it("surfaces partial success", async () => {
		const r = recorder([
			{
				status: 200,
				headers: {},
				body: JSON.stringify({
					partialSuccess: { rejectedDataPoints: "2", errorMessage: "bad" },
				}),
			},
		]);
		const sink = createTelemetrySink({ http: r.http, sleep: r.sleep });
		await expect(sink.metrics([point(1)])).rejects.toMatchObject({
			code: "otlp-partial-success",
		});
	});

	it("rejects an invalid endpoint at construction", () => {
		for (const bad of ["not a url", "ftp://x", "http://u:p@x", "http://x/?q=1"])
			expect(() => parseOtlpEndpoint(bad)).toThrow(TelemetryError);
		expect(parseOtlpEndpoint("http://x:4318/otlp/")).toBe("http://x:4318/otlp");
	});
});

function point(
	value: number,
	kind: OtelMetricPoint["kind"] = "gauge",
): OtelMetricPoint {
	return {
		name: "m",
		kind,
		value,
		unit: "1",
		atMs: T0,
		attributes: { a: "b" },
	};
}

describe("encodeMetrics", () => {
	it("maps counters to monotonic delta sums, histograms and gauges", () => {
		const body = encodeMetrics(
			[
				point(1, "counter"),
				point(2.5, "gauge"),
				point(3, "histogram"),
				point(4, "counter"),
			],
			{ "service.name": "s" },
		);
		const metrics = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
		expect(metrics).toEqual([
			{
				name: "m",
				unit: "1",
				sum: {
					aggregationTemporality: 1,
					isMonotonic: true,
					dataPoints: [
						{
							attributes: [{ key: "a", value: { stringValue: "b" } }],
							timeUnixNano: `${T0}000000`,
							asInt: "1",
						},
						{
							attributes: [{ key: "a", value: { stringValue: "b" } }],
							timeUnixNano: `${T0}000000`,
							asInt: "4",
						},
					],
				},
			},
			{
				name: "m",
				unit: "1",
				gauge: {
					dataPoints: [
						{
							attributes: [{ key: "a", value: { stringValue: "b" } }],
							timeUnixNano: `${T0}000000`,
							asDouble: 2.5,
						},
					],
				},
			},
			{
				name: "m",
				unit: "1",
				histogram: {
					aggregationTemporality: 1,
					dataPoints: [
						{
							attributes: [{ key: "a", value: { stringValue: "b" } }],
							timeUnixNano: `${T0}000000`,
							count: "1",
							sum: 3,
							min: 3,
							max: 3,
							bucketCounts: ["1"],
							explicitBounds: [],
						},
					],
				},
			},
		]);
	});
});
