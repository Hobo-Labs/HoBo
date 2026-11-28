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
