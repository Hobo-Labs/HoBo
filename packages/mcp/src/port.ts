import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";

// The MCP control-surface seam (ai-native-agent-auth.md §6.4). The Yard exposes
// this as a WIT port with a built-in HoBo implementation that dispatches through
// the SAME @hobo/cli command registry the CLI uses (NFR-004 parity). Concrete
// transports bind behind this descriptor via Matching — never in app code. The
// only inward dependencies are the shared @hobo/core port vocabulary, the
// @hobo/cli dispatch layer, and @hobo/identity for SVID scope.

export const MCP_CONTROL_SURFACE_INTERFACE = "hobo:mcp/control-surface";

const mcpControlSurfaceDescriptor = createPortDescriptor({
	kind: "provider",
	name: "mcp-control-surface",
	interface: MCP_CONTROL_SURFACE_INTERFACE,
	stability: "preview",
});
export const MCP_CONTROL_SURFACE_PORT: ProviderPort =
	// SAFETY: PortDescriptor with kind provider is this surface's ProviderPort.
	mcpControlSurfaceDescriptor as ProviderPort;
