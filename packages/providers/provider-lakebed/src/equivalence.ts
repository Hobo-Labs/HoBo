export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "lakebed:capsule",
		providerService: "Capsule",
		features: ["capsule", "http", "managed", "sync-rpc"],
	},
	kv: {
		port: "kv",
		resourceClass: "lakebed:capsule-kv",
		providerService: "Capsule KV",
		features: ["key-value", "durable"],
	},
	objectStore: {
		port: "objectStore",
		resourceClass: "lakebed:file-store",
		providerService: "File Store",
		features: ["durable"],
	},
	"database/reactive": {
		port: "database",
		resourceClass: "lakebed:reactive-db",
		providerService: "Reactive DB",
		features: ["document", "reactive", "managed"],
	},
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"kv",
	"objectStore",
	"database/reactive",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}

export function lakebedNativePorts(): readonly string[] {
	return Object.freeze([
		...new Set(Object.values(EQUIVALENCE_CLASSES).map((entry) => entry.port)),
	]);
}

export function lakebedNativeFeaturesForPort(port: string): readonly string[] {
	const entry = Object.values(EQUIVALENCE_CLASSES).find(
		(row) => row.port === port,
	);
	return entry?.features ?? [];
}
