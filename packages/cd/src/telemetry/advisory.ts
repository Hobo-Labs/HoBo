import type { OtelMetricPoint, TelemetrySink } from "../ports.js";

export async function emitMetrics(
	sink: TelemetrySink | undefined,
	points: readonly OtelMetricPoint[],
): Promise<void> {
	if (!sink || points.length === 0) return;
	try {
		await sink.metrics(points);
	} catch {}
}
