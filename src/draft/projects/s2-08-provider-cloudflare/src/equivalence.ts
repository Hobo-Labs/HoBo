export const EQUIVALENCE_CLASSES = Object.freeze({
  "web/service": {
    port: "compute",
    resourceClass: "cloudflare:workers-script",
    providerService: "Workers",
    features: ["edge", "worker", "wasm-native", "http"],
  },
  kv: {
    port: "kv",
    resourceClass: "cloudflare:kv-namespace",
    providerService: "KV",
    features: ["eventual", "edge", "key-value"],
  },
  objectStore: {
    port: "objectStore",
    resourceClass: "cloudflare:r2-bucket",
    providerService: "R2",
    features: ["durable", "s3-compatible"],
  },
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

export const INITIAL_CAPABILITY_PORTS = Object.freeze(
  // SAFETY: Object.keys is taken from the typed equivalence-class registry above.
  Object.keys(EQUIVALENCE_CLASSES) as InitialCapabilityPort[],
);

export function equivalenceForPort(port: InitialCapabilityPort) {
  return EQUIVALENCE_CLASSES[port];
}
