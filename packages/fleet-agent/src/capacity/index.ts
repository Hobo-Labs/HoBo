import type { CapacitySource } from "@hobo/fleet";
import {
	HOST_PROBES,
	parseHostCapacityOptions,
	readHostCapacity,
} from "./measure.js";

export function createHostCapacity(
	options: Readonly<{
		slots: number;
		workRoot: string;
		labels: readonly string[];
	}>,
): CapacitySource {
	const parsed = parseHostCapacityOptions(options);
	return Object.freeze({
		read: () => readHostCapacity(parsed, HOST_PROBES),
	} satisfies CapacitySource);
}
