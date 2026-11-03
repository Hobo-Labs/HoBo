import type { PortDescriptor, ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";

// The subscription-gateway port a transport (WebSocket/SSE, backed by the
// Streamer) satisfies to carry reactive pushes to clients (data-plane.md Plan 32
// §Transport). The kernel depends inward on the @hobo/core port vocabulary only.
export const SUBSCRIPTION_GATEWAY_INTERFACE = "hobo:subscription/gateway";

const subscriptionGatewayPort = createPortDescriptor({
	kind: "provider",
	name: "subscription-gateway",
	interface: SUBSCRIPTION_GATEWAY_INTERFACE,
	stability: "preview",
});
function isProviderPort(
	descriptor: PortDescriptor,
): descriptor is ProviderPort {
	return descriptor.kind === "provider";
}
if (!isProviderPort(subscriptionGatewayPort)) {
	throw new TypeError("subscription gateway port must be a provider port");
}
export const SUBSCRIPTION_GATEWAY_PORT: ProviderPort = subscriptionGatewayPort;
