// GCP equivalence classes: the cross-cloud equivalence-table row for GCP
// (control-plane.md §Cross-cloud equivalence classes) shipped as this
// provider's default Resource Definitions (HOBO-93 model / ADR-0090).
export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "gcp:cloud-run-service",
		providerService: "Cloud Run",
		features: ["container", "http", "autoscaling", "managed"],
	},
	kv: {
		port: "kv",
		resourceClass: "gcp:firestore-database",
		providerService: "Firestore",
		features: ["key-value", "durable", "serverless"],
	},
	objectStore: {
		port: "objectStore",
		resourceClass: "gcp:gcs-bucket",
		providerService: "Cloud Storage",
		features: ["durable", "versioned", "s3-interop"],
	},
	"database/postgres": {
		port: "database",
		resourceClass: "gcp:cloud-sql-postgres",
		providerService: "Cloud SQL PostgreSQL",
		features: ["postgres", "relational", "managed"],
	},
	queue: {
		port: "queue",
		resourceClass: "gcp:pubsub-topic",
		providerService: "Pub/Sub",
		features: ["queue", "at-least-once", "managed"],
	},
	cache: {
		port: "cache",
		resourceClass: "gcp:memorystore-redis",
		providerService: "Memorystore",
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
