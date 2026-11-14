/**
 * A `FleetBus` that is always whichever connection the agent holds now, so a
 * work source built before the agent connects (the `oci-command` source reads
 * `FLEET_SUBMISSIONS` through it) follows reconnects, as `hobo fleet run`
 * composes it.
 */
import type { FleetBus } from "@hobo/fleet";

export function liveBus(current: () => FleetBus | undefined): FleetBus {
	const bus = (): FleetBus => {
		const connected = current();
		if (connected === undefined) throw new Error("the agent is not connected to its bus");
		return connected;
	};
	return {
		get registry() {
			return bus().registry;
		},
		get observations() {
			return bus().observations;
		},
		get claims() {
			return bus().claims;
		},
		get offers() {
			return bus().offers;
		},
		get submissions() {
			return bus().submissions;
		},
		get orders() {
			return bus().orders;
		},
		get events() {
			return bus().events;
		},
		get control() {
			return bus().control;
		},
		get relay() {
			return bus().relay;
		},
		status: () => current()?.status() ?? "disconnected",
		close: async () => {},
	};
}
