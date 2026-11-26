// DigitalOcean equivalence classes: the cross-cloud equivalence-table row for
// DigitalOcean (control-plane.md §Cross-cloud equivalence classes) shipped as
// this provider's default Resource Definitions (HOBO-93 model / ADR-0090).
//
// Four classes, not six. DigitalOcean has no first-party queue and no
// first-party secret store, so the `queue` and `secretRef` rows the
// hyperscaler providers carry are simply absent here. An equivalence row for a
// product the provider does not sell would make Matching answer `full` for a
// capability nothing can realize, which is the one failure this table exists
// to prevent.
export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "digitalocean:app-platform-service",
		providerService: "App Platform",
		features: ["container", "http", "autoscaling", "managed"],
	},
	objectStore: {
		port: "objectStore",
		resourceClass: "digitalocean:spaces-bucket",
		providerService: "Spaces",
		features: ["durable", "s3-compatible", "cdn"],
	},
	"database/postgres": {
		port: "database",
		resourceClass: "digitalocean:managed-postgres",
		providerService: "Managed Databases for PostgreSQL",
		features: ["postgres", "relational", "managed"],
	},
	cache: {
		port: "cache",
		resourceClass: "digitalocean:managed-valkey",
		providerService: "Managed Caching (Valkey)",
		features: ["cache", "redis", "in-memory"],
	},
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"objectStore",
	"database/postgres",
	"cache",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}
