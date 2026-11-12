// OTLP/HTTP JSON encoding (opentelemetry-proto ExportTraceServiceRequest and
// ExportMetricsServiceRequest, JSON mapping) for the frozen OtelSpan and
// OtelMetricPoint shapes. No SDK dependency (D17): the wire form is small and
// stable. Encoding is pure and deterministic.
import type { OtelAttributes, OtelMetricPoint, OtelSpan } from "../ports.js";
import { CD_INSTRUMENTATION_SCOPE, SEMCONV } from "./semconv.js";

export type OtlpAnyValue =
	| Readonly<{ stringValue: string }>
	| Readonly<{ intValue: string }>
	| Readonly<{ doubleValue: number }>
	| Readonly<{ boolValue: boolean }>;

export type OtlpKeyValue = Readonly<{ key: string; value: OtlpAnyValue }>;

// public-contract: OTLP span kind numbers (opentelemetry-proto SpanKind).
export const OTLP_SPAN_KIND = Object.freeze({
	internal: 1,
	server: 2,
	client: 3,
	producer: 4,
	consumer: 5,
} as const);

// public-contract: OTLP status codes (opentelemetry-proto Status.StatusCode).
export const OTLP_STATUS_CODE = Object.freeze({
	unset: 0,
	ok: 1,
	error: 2,
} as const);

// public-contract: OTLP aggregation temporality used for counters/histograms.
export const OTLP_DELTA_TEMPORALITY = 1 as const;

function value(v: string | number | boolean): OtlpAnyValue {
	if (typeof v === "string") return { stringValue: v };
	if (typeof v === "boolean") return { boolValue: v };
	return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

export function otlpAttributes(attributes: OtelAttributes): OtlpKeyValue[] {
	return Object.keys(attributes)
		.sort()
		.flatMap((key) => {
			const v = attributes[key];
			return v === undefined ? [] : [{ key, value: value(v) }];
		});
}

function nanos(ms: number): string {
	return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

function resource(attributes: OtelAttributes) {
	return { attributes: otlpAttributes(attributes) };
}

const SCOPE = {
	name: CD_INSTRUMENTATION_SCOPE.name,
	version: CD_INSTRUMENTATION_SCOPE.version,
};

export function encodeTraces(
	spans: readonly OtelSpan[],
	resourceAttributes: OtelAttributes,
) {
	return {
		resourceSpans: [
			{
				resource: resource(resourceAttributes),
				schemaUrl: SEMCONV.schemaUrl,
				scopeSpans: [
					{
						scope: SCOPE,
						schemaUrl: SEMCONV.schemaUrl,
						spans: spans.map((s) => ({
							traceId: s.traceId,
							spanId: s.spanId,
							...(s.parentSpanId === undefined
								? {}
								: { parentSpanId: s.parentSpanId }),
							name: s.name,
							kind: OTLP_SPAN_KIND[s.kind],
							startTimeUnixNano: nanos(s.startMs),
							endTimeUnixNano: nanos(s.endMs),
							attributes: otlpAttributes(s.attributes),
							status: { code: OTLP_STATUS_CODE[s.status] },
						})),
					},
				],
			},
		],
	};
}

function numberPoint(p: OtelMetricPoint) {
	return {
		attributes: otlpAttributes(p.attributes),
		timeUnixNano: nanos(p.atMs),
		...(Number.isInteger(p.value)
			? { asInt: String(p.value) }
			: { asDouble: p.value }),
	};
}

function histogramPoint(p: OtelMetricPoint) {
	return {
		attributes: otlpAttributes(p.attributes),
		timeUnixNano: nanos(p.atMs),
		count: "1",
		sum: p.value,
		min: p.value,
		max: p.value,
		bucketCounts: ["1"],
		explicitBounds: [],
	};
}

export function encodeMetrics(
	points: readonly OtelMetricPoint[],
	resourceAttributes: OtelAttributes,
) {
	// Group by (name, kind, unit) in first-seen order: one OTLP metric each.
	const groups = new Map<string, OtelMetricPoint[]>();
	for (const p of points) {
		const key = `${p.name}\u0000${p.kind}\u0000${p.unit}`;
		const group = groups.get(key);
		if (group) group.push(p);
		else groups.set(key, [p]);
	}
	const metrics = [...groups.values()].map((group) => {
		const first = group[0];
		const name = first?.name ?? "";
		const unit = first?.unit ?? "1";
		if (first?.kind === "counter")
			return {
				name,
				unit,
				sum: {
					dataPoints: group.map(numberPoint),
					aggregationTemporality: OTLP_DELTA_TEMPORALITY,
					isMonotonic: true,
				},
			};
		if (first?.kind === "histogram")
			return {
				name,
				unit,
				histogram: {
					dataPoints: group.map(histogramPoint),
					aggregationTemporality: OTLP_DELTA_TEMPORALITY,
				},
			};
		return { name, unit, gauge: { dataPoints: group.map(numberPoint) } };
	});
	return {
		resourceMetrics: [
			{
				resource: resource(resourceAttributes),
				schemaUrl: SEMCONV.schemaUrl,
				scopeMetrics: [{ scope: SCOPE, schemaUrl: SEMCONV.schemaUrl, metrics }],
			},
		],
	};
}
