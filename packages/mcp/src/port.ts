import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";

// public-contract: stable exported contract literal
export const MCP_CONTROL_SURFACE_INTERFACE = "hobo:mcp/control-surface";

const mcpControlSurfaceDescriptor = createPortDescriptor({
	kind: "provider",
	name: "mcp-control-surface",
	interface: MCP_CONTROL_SURFACE_INTERFACE,
	stability: "preview",
});
export const MCP_CONTROL_SURFACE_PORT: ProviderPort =
	mcpControlSurfaceDescriptor as ProviderPort;
