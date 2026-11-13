/**
 * The bus-relay transport (L37, design §6.12 item 3).
 * Signature frozen by the fleet contract commit (ADR-0182).
 */
import type { FleetBus, FleetTransport } from "@hobo/fleet";
import { createRelayTransport } from "./transport.js";

/** `bus` is the agent's `bus()`; dial fails `unavailable` while it is undefined. */
export function createBusRelayTransport(
	bus: () => FleetBus | undefined,
): FleetTransport {
	return createRelayTransport(bus);
}
