export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "hetzner:cloud-server",
		providerService: "Hetzner Cloud Server",
		features: ["vm", "http", "managed"],
	},
	objectStore: {
		port: "objectStore",
		resourceClass: "hetzner:object-storage-bucket",
		providerService: "Hetzner Object Storage",
		features: ["durable", "s3-compatible"],
	},
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"objectStore",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}
