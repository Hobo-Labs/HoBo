// Hostinger equivalence classes: the cross-cloud equivalence-table row for
// Hostinger (control-plane.md §Cross-cloud equivalence classes) shipped as this
// provider's default Resource Definitions (HOBO-93 model / ADR-0090).
//
// Two classes, not six. Hostinger sells hosting plans — VPS instances, shared
// and cloud web hosting, and the MySQL databases that come with a hosting plan
// — and it sells no object store, no managed cache and no managed queue. An
// equivalence row for a product the provider does not offer would make Matching
// answer `full` for a capability nothing can realize, which is the one failure
// this table exists to prevent.
export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "hostinger:vps",
		providerService: "Hostinger VPS",
		features: ["vm", "http", "managed"],
	},
	"database/mysql": {
		port: "database",
		resourceClass: "hostinger:mysql-database",
		providerService: "Hostinger managed MySQL",
		features: ["mysql", "relational", "managed"],
	},
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"database/mysql",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}
