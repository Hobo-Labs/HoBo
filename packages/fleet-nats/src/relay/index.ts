/**
 * The bus-relay transport (L37).
 * Signature frozen by the fleet contract commit (ADR-0182).
 */
import {
	type FleetBus,
	FleetNotImplemented,
	type FleetTransport,
} from "@hobo/fleet";

/** `bus` is the agent's `bus()`; dial fails `unavailable` while it is undefined. */
export function createBusRelayTransport(
	bus: () => FleetBus | undefined,
): FleetTransport {
	void bus;
	throw new FleetNotImplemented("createBusRelayTransport");
}
