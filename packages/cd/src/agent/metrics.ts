// Advisory metrics through the frozen TelemetrySink. A failing sink never
// fails a command or a request.
import type { OtelAttributes, TelemetrySink } from "../ports.js";

export type MetricKind = "counter" | "histogram" | "gauge";

export type Meter = (
	name: string,
	value: number,
	attributes?: OtelAttributes,
	kind?: MetricKind,
	unit?: string,
) => void;

export function createMeter(
	sink: TelemetrySink | undefined,
	now: () => number,
): Meter {
	return (name, value, attributes = {}, kind = "counter", unit = "1") => {
		if (!sink) return;
		sink
			.metrics([{ name, kind, value, unit, atMs: now(), attributes }])
			.catch(() => undefined);
	};
}
