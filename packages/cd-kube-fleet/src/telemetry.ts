// Metrics for @hobo/cd-kube-fleet, emitted through the frozen TelemetrySink.
// A meter accumulates points during one pass and flushes once; a telemetry
// failure never fails a pass (the sink is best-effort by contract).
import type { OtelAttributes, OtelMetricPoint, TelemetrySink } from "@hobo/cd";

// public-contract: metric names this package emits.
export const KUBE_FLEET_METRICS = Object.freeze({
	apiCalls: "hobo.cd.kube_fleet.api.calls",
	passes: "hobo.cd.kube_fleet.realize.passes",
	duration: "hobo.cd.kube_fleet.realize.duration",
	mutations: "hobo.cd.kube_fleet.realize.mutations",
	profiles: "hobo.cd.kube_fleet.cluster_profiles",
	skipped: "hobo.cd.kube_fleet.cluster_profiles.skipped",
	relists: "hobo.cd.kube_fleet.watch.relists",
} as const);

export type Meter = Readonly<{
	count(name: string, attributes: OtelAttributes, value?: number): void;
	gauge(name: string, value: number, attributes: OtelAttributes): void;
	histogram(name: string, value: number, unit: string, attributes: OtelAttributes): void;
	flush(): Promise<void>;
}>;

export function createMeter(
	sink: TelemetrySink | undefined,
	now: () => number,
): Meter {
	const points: OtelMetricPoint[] = [];
	const push = (point: Omit<OtelMetricPoint, "atMs">): void => {
		points.push({ ...point, atMs: now() });
	};
	return Object.freeze({
		count(name, attributes, value = 1) {
			push({ name, kind: "counter", value, unit: "1", attributes });
		},
		gauge(name, value, attributes) {
			push({ name, kind: "gauge", value, unit: "1", attributes });
		},
		histogram(name, value, unit, attributes) {
			push({ name, kind: "histogram", value, unit, attributes });
		},
		async flush() {
			if (sink === undefined || points.length === 0) return;
			const batch = points.splice(0, points.length);
			try {
				await sink.metrics(batch);
			} catch {
				// Telemetry is best-effort: a sink failure never fails a pass.
			}
		},
	});
}
