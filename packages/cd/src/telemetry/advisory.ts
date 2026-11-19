import type { OtelMetricPoint, TelemetrySink } from "../ports.js";

export function emitMetrics(
	sink: TelemetrySink | undefined,
	points: readonly OtelMetricPoint[],
): void {
	if (!sink || points.length === 0) return;
	try {
		sink.metrics(points).catch(() => undefined);
	} catch {}
}
