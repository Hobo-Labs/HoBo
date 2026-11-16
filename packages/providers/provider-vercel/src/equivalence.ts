export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "vercel:web-ssr",
		providerService: "Vercel Web",
		features: ["http", "static", "managed"],
	},
	objectStore: {
		port: "objectStore",
		resourceClass: "vercel:blob",
		providerService: "Vercel Blob",
		features: ["durable"],
	},
	"database/postgres": {
		port: "database",
		resourceClass: "vercel:neon-postgres",
		providerService: "Neon (marketplace)",
		features: ["postgres", "managed", "integration-backed"],
	},
	kv: {
		port: "kv",
		resourceClass: "vercel:edge-config",
		providerService: "Edge Config / Upstash",
		features: ["key-value", "edge", "integration-backed"],
	},
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

// `Object.freeze`, not `as const` alone. `as const` is a compile-time claim
// and leaves the array mutable at runtime; this table is read on every realize,
// so a mutated entry would silently change what every later deploy provisions.
// The package's own test asserts `Object.isFrozen` for exactly that reason.
export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"objectStore",
	"database/postgres",
	"kv",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}

export function vercelNativePorts(): readonly string[] {
	return Object.freeze([
		...new Set(Object.values(EQUIVALENCE_CLASSES).map((entry) => entry.port)),
	]);
}
