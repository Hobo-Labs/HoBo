import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";

// The Gatekeeper and contract-engine seams (contracts-policy-flags.md,
// ADR-0015). The contract engine is a WIT port with a built-in HoBo
// implementation; the Gatekeeper composes it with the policy engine. Concrete
// adapters bind behind these descriptors via Matching — never in app code. The
// only inward dependency is the shared @hobo/core port vocabulary.

export const CONTRACT_ENGINE_INTERFACE = "hobo:contract-engine/can-deploy";
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
