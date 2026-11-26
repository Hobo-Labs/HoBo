export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "browser-wasm:guest",
		providerService: "Browser Component Model",
		features: ["http", "wasm", "wit"],
	},
	kv: {
		port: "kv",
		resourceClass: "browser-wasm:kv",
		providerService: "In-browser KV",
		features: ["key-value"],
	},
	queue: {
		port: "queue",
		resourceClass: "browser-wasm:queue",
		providerService: "In-browser queue",
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

export function browserWasmNativePorts(): readonly string[] {
	return Object.freeze([
		...new Set(Object.values(EQUIVALENCE_CLASSES).map((entry) => entry.port)),
	]);
}
