/**
 * Host capacity (L10). Signature frozen by the fleet contract commit (ADR-0182).
 */
import { type CapacitySource, FleetNotImplemented } from "@hobo/fleet";

/** This host's slots, free memory and disk under `workRoot`, and labels. */
export function createHostCapacity(
	options: Readonly<{
		slots: number;
		workRoot: string;
		labels: readonly string[];
	}>,
): CapacitySource {
	void options;
	throw new FleetNotImplemented("createHostCapacity");
}
