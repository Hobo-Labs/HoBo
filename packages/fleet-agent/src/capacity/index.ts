/**
 * Host capacity (L10, design §6.8). Signature frozen by the fleet contract
 * commit (ADR-0182). How each figure is measured is in `measure.ts`.
 */
import type { CapacitySource } from "@hobo/fleet";
import {
	HOST_PROBES,
	parseHostCapacityOptions,
	readHostCapacity,
} from "./measure.js";

/** This host's slots, free memory and disk under `workRoot`, and labels. */
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
