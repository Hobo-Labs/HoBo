import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";

// public-contract: stable exported contract literal
export const PROJECTION_INTERFACE = "hobo:projection/sink";

const projectionDescriptor = createPortDescriptor({
	kind: "provider",
	name: "projection",
	interface: PROJECTION_INTERFACE,
	stability: "preview",
});

export const PROJECTION_PORT: ProviderPort = Object.freeze({
	kind: "provider",
	name: projectionDescriptor.name,
	interface: projectionDescriptor.interface,
	stability: projectionDescriptor.stability,
});
