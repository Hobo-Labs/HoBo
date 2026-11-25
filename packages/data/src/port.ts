import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";

// The `hobo:projection` provider port a sink adapter satisfies (data-plane.md
// §Projection events & ports). The kernel's only inward dependency is the shared
// @hobo/core port vocabulary; concrete sinks (native/relational/document) bind
// behind this descriptor via Matching, never in app code.
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
