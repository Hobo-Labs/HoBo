import type { FleetBus, FleetTransport } from "@hobo/fleet";
import { createRelayTransport } from "./transport.js";

export function createBusRelayTransport(
	bus: () => FleetBus | undefined,
): FleetTransport {
	return createRelayTransport(bus);
}
