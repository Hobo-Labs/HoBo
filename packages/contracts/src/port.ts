import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";

// public-contract: contract-engine port interface id.
export const CONTRACT_ENGINE_INTERFACE = "hobo:contract-engine/can-deploy";
// public-contract: gatekeeper port interface id.
export const GATEKEEPER_INTERFACE = "hobo:gatekeeper/verify";

const contractEngineDescriptor = createPortDescriptor({
	kind: "provider",
	name: "contract-engine",
	interface: CONTRACT_ENGINE_INTERFACE,
	stability: "preview",
});
// SAFETY: createPortDescriptor brands this seam as a ProviderPort.
const contractEnginePort = contractEngineDescriptor as ProviderPort;
export const CONTRACT_ENGINE_PORT: ProviderPort = contractEnginePort;

const gatekeeperDescriptor = createPortDescriptor({
	kind: "provider",
	name: "gatekeeper",
	interface: GATEKEEPER_INTERFACE,
	stability: "preview",
});
// SAFETY: createPortDescriptor brands this seam as a ProviderPort.
const gatekeeperPort = gatekeeperDescriptor as ProviderPort;
export const GATEKEEPER_PORT: ProviderPort = gatekeeperPort;
