export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "webernetes:pod",
		providerService: "Local Webernetes",
		features: ["http", "container"],
	},
	kv: {
		port: "kv",
		resourceClass: "webernetes:kv",
		providerService: "Local KV",
		features: ["key-value"],
	},
	queue: {
		port: "queue",
		resourceClass: "webernetes:queue",
		providerService: "Local queue",
		features: ["queue"],
	},
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"kv",
	"queue",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}

export function webernetesNativePorts(): readonly string[] {
	return Object.freeze([
		...new Set(Object.values(EQUIVALENCE_CLASSES).map((entry) => entry.port)),
	]);
}
