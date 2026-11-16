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

export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"kv",
	"objectStore",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}

/** HoBo ports this provider can natively host (Matching / Examples truth). */
export function cloudflareNativePorts(): readonly string[] {
	return Object.freeze([
		...new Set(Object.values(EQUIVALENCE_CLASSES).map((entry) => entry.port)),
	]);
}
