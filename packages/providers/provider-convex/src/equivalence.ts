export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "convex:function-host",
		providerService: "Convex Functions",
		features: [
			"http",
			"managed",
			"typescript",
			"actions",
			"functions.scheduled",
			"crons",
		],
	},
	"database/reactive": {
		port: "database",
		resourceClass: "convex:document-db",
		providerService: "Convex Database",
		features: [
			"document",
			"reactive",
			"transactions",
			"managed",
			"search.text",
			"search.vector",
		],
	},
	objectStore: {
		port: "objectStore",
		resourceClass: "convex:file-storage",
		providerService: "Convex File Storage",
		features: ["durable", "serve-url"],
	},
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"database/reactive",
	"objectStore",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}
