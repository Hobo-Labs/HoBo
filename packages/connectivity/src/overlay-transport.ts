/**
 * The overlay transport of HoBo Fleet (L14, ADR-0182). Signature frozen by
 * the fleet contract commit. The host joins the overlay with the
 * `OverlayJoin` from `EnrollmentResponse` before calling this; the transport
 * never joins, and never reads an overlay credential itself.
 */
import type { OverlayNetwork } from "@hobo/core";
import type { FleetTransport } from "@hobo/fleet";
import { createOverlayTransportWith } from "./overlay-transport/transport.js";

/** A `FleetTransport` of kind `overlay` over an overlay this device has already joined. */
export function createOverlayTransport(
	overlay: OverlayNetwork,
): FleetTransport {
	return createOverlayTransportWith(overlay);
}
