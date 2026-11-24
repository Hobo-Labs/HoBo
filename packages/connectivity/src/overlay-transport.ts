import type { OverlayNetwork } from "@hobo/core";
import type { FleetTransport } from "@hobo/fleet";
import { createOverlayTransportWith } from "./overlay-transport/transport.js";

export function createOverlayTransport(
	overlay: OverlayNetwork,
): FleetTransport {
	return createOverlayTransportWith(overlay);
}
