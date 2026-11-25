import type { InitialCapabilityPort } from "./equivalence.js";
import { INITIAL_CAPABILITY_PORTS } from "./equivalence.js";
import { createHelloBindlePlan, type HelloBindlePlan } from "./hello-bindle.js";
import { CLOUDFLARE_PROVIDER_ID, publishCapabilityManifest } from "./manifest.js";

export interface ProviderCloudflareDraft {
  id: string;
  initialPorts: readonly InitialCapabilityPort[];
  publishedManifest: ReturnType<typeof publishCapabilityManifest>;
  helloBindlePlan: HelloBindlePlan;
  coversInitialPort(port: InitialCapabilityPort): boolean;
}

export function createProviderCloudflareDraft(options: { colos?: string[] } = {}): ProviderCloudflareDraft {
  const colos = options.colos ?? ["WNAM", "ENAM", "WEUR"];
  const publishedManifest = publishCapabilityManifest({ colos });
  const capabilities = JSON.parse(publishedManifest["/.well-known/capability-manifest/capabilities.json"]) as {
    capabilities: Array<{ port: string }>;
  };
  const claimed = new Set(capabilities.capabilities.map((entry) => entry.port));

  return {
    id: CLOUDFLARE_PROVIDER_ID,
    initialPorts: INITIAL_CAPABILITY_PORTS,
    publishedManifest,
    helloBindlePlan: createHelloBindlePlan({ colo: colos[0] ?? "WNAM" }),
    coversInitialPort(port: InitialCapabilityPort) {
      const mapping = { "web/service": "compute", kv: "kv", objectStore: "objectStore" }[port];
      return claimed.has(mapping);
    },
  };
}
