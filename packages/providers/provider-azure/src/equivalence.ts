// Azure equivalence classes: the cross-cloud equivalence-table row for Azure
// (control-plane.md §Cross-cloud equivalence classes) shipped as this
// provider's default Resource Definitions (HOBO-93 model / ADR-0090).
export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "azure:container-app",
		providerService: "Container Apps",
		features: ["container", "http", "autoscaling", "managed"],
	},
	kv: {
		port: "kv",
		resourceClass: "azure:cosmos-table",
		providerService: "Cosmos DB (Table)",
		features: ["key-value", "durable", "serverless"],
	},
	objectStore: {
		port: "objectStore",
		resourceClass: "azure:storage-blob-container",
		providerService: "Blob Storage",
		features: ["durable", "versioned", "tiered"],
	},
	"database/postgres": {
		port: "database",
		resourceClass: "azure:postgres-flexible-server",
		providerService: "PostgreSQL Flexible Server",
		features: ["postgres", "relational", "managed"],
	},
	queue: {
		port: "queue",
		resourceClass: "azure:servicebus-queue",
		providerService: "Service Bus",
		features: ["queue", "at-least-once", "managed"],
	},
	cache: {
		port: "cache",
		resourceClass: "azure:cache-redis",
		providerService: "Cache for Redis",
		features: ["cache", "redis", "in-memory"],
	},
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"kv",
	"objectStore",
	"database/postgres",
	"queue",
	"cache",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}
