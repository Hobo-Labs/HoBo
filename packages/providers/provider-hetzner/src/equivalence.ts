// Hetzner equivalence classes: the cross-cloud equivalence-table row for
// Hetzner (control-plane.md §Cross-cloud equivalence classes) shipped as this
// provider's default Resource Definitions (HOBO-93 model / ADR-0090).
//
// Two classes, not six, and that is the honest count. Hetzner sells virtual
// machines, networking and object storage; it sells no managed database, no
// managed cache and no managed queue. An equivalence row for a product the
// provider does not offer would make Matching answer `full` for a capability
// nothing can realize, which is the one failure this table exists to prevent —
// so the missing rows stay missing and an app that needs Postgres gets a
// truthful `none` from this provider rather than a Cloud Server it would have
// to administer itself.
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
