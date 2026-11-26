import type { PortDescriptor, ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";

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
