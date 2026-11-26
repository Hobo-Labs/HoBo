export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "railway:service",
		providerService: "Railway Service",
		features: ["http", "container", "managed"],
	},
	kv: {
		port: "kv",
		resourceClass: "railway:redis",
		providerService: "Railway Redis",
		features: ["key-value", "durable"],
	},
	queue: {
		port: "queue",
		resourceClass: "railway:queue",
		providerService: "Railway Queue",
		features: ["queue"],
	},
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

// `Object.freeze`, not `as const` alone. `as const` is a compile-time claim
// and leaves the array mutable at runtime; this table is read on every realize,
// so a mutated entry would silently change what every later deploy provisions.
// The package's own test asserts `Object.isFrozen` for exactly that reason.
export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"kv",
	"queue",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}

export function railwayNativePorts(): readonly string[] {
	return Object.freeze([
		...new Set(Object.values(EQUIVALENCE_CLASSES).map((entry) => entry.port)),
	]);
}
