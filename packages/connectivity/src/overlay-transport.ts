/**
 * The overlay transport of HoBo Fleet (L14). Signature frozen by the fleet
 * contract commit (ADR-0182). The host joins the overlay with the
 * `OverlayJoin` from `EnrollmentResponse` before calling this.
 */
import type { OverlayNetwork } from "@hobo/core";
import { FleetNotImplemented, type FleetTransport } from "@hobo/fleet";

/** A `FleetTransport` of kind `overlay` over an overlay this device has already joined. */
export function createOverlayTransport(
	overlay: OverlayNetwork,
): FleetTransport {
	void overlay;
	throw new FleetNotImplemented("createOverlayTransport");
}
