// Metrics for resolver-component invocations, emitted through the @hobo/cd
// `TelemetrySink`. Attributes are bounded and secret-free: component id,
// operation, outcome and denial code only.
import type { OtelMetricPoint } from "@hobo/cd";
import {
	type ComponentInvocationRecord,
	EgressDenialCode,
	InvocationOutcome,
} from "./_generated/resolver_components_pb.js";

// public-contract: metric names this package emits.
export const RESOLVER_COMPONENT_METRICS = Object.freeze({
	invocations: "hobo.resolver_component.invocations",
	duration: "hobo.resolver_component.duration",
	fuel: "hobo.resolver_component.fuel",
	peakMemory: "hobo.resolver_component.memory.peak",
	egressCalls: "hobo.resolver_component.egress.calls",
	denials: "hobo.resolver_component.egress.denials",
});

/** Lowercase outcome label (`ok`, `egress_denied`, ...). */
export function outcomeLabel(outcome: InvocationOutcome): string {
	return (InvocationOutcome[outcome] ?? "UNSPECIFIED").toLowerCase();
}

/** Lowercase denial label (`host_not_allowlisted`, ...). */
export function denialLabel(code: EgressDenialCode): string {
	return (EgressDenialCode[code] ?? "UNSPECIFIED").toLowerCase();
}

/** The metric points for one invocation record. */
export function invocationMetrics(
	record: ComponentInvocationRecord,
	atMs: number,
): readonly OtelMetricPoint[] {
	const attributes = {
		"hobo.resolver_component.id": record.componentId,
		"hobo.resolver_component.operation": record.operation,
		"hobo.resolver_component.outcome": outcomeLabel(record.outcome),
	};
	const points: OtelMetricPoint[] = [
		{
			name: RESOLVER_COMPONENT_METRICS.invocations,
			kind: "counter",
			value: 1,
			unit: "{invocation}",
			atMs,
			attributes,
		},
		{
			name: RESOLVER_COMPONENT_METRICS.duration,
			kind: "histogram",
			value: record.durationMs,
			unit: "ms",
			atMs,
			attributes,
		},
		{
			name: RESOLVER_COMPONENT_METRICS.fuel,
			kind: "histogram",
			value: Number(record.fuelUsed),
			unit: "{fuel}",
			atMs,
			attributes,
		},
		{
			name: RESOLVER_COMPONENT_METRICS.peakMemory,
			kind: "histogram",
			value: Number(record.peakMemoryBytes),
			unit: "By",
			atMs,
			attributes,
		},
		{
			name: RESOLVER_COMPONENT_METRICS.egressCalls,
			kind: "counter",
			value: record.egressCalls,
			unit: "{request}",
			atMs,
			attributes,
		},
	];
	for (const denial of record.denials) {
		points.push({
			name: RESOLVER_COMPONENT_METRICS.denials,
			kind: "counter",
			value: 1,
			unit: "{denial}",
			atMs,
			attributes: {
				"hobo.resolver_component.id": record.componentId,
				"hobo.resolver_component.denial": denialLabel(denial.code),
			},
		});
	}
	return Object.freeze(points);
}
