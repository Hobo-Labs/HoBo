// Lakebed equivalence classes (ADR-0127): the head-on competitor's closed
// PaaS surface mapped honestly onto HoBo's agnostic ports. Feature lists are
// deliberately NARROW — a closed Capsule runtime cannot claim container or
// postgres semantics, so `require` misses surface as partial(missing)
// verdicts with remediation, never fabricated parity.
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

// `Object.freeze`, not `as const` alone. `as const` is a compile-time claim
// and leaves the array mutable at runtime; this table is read on every realize,
// so a mutated entry would silently change what every later deploy provisions.
// The package's own test asserts `Object.isFrozen` for exactly that reason.
export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"kv",
	"objectStore",
	"database/reactive",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}

/** HoBo ports this provider can natively host (Matching / Examples truth). */
export function lakebedNativePorts(): readonly string[] {
	return Object.freeze([
		...new Set(Object.values(EQUIVALENCE_CLASSES).map((entry) => entry.port)),
	]);
}

/** Features advertised per port — used for prefer/require negotiation. */
export function lakebedNativeFeaturesForPort(port: string): readonly string[] {
	const entry = Object.values(EQUIVALENCE_CLASSES).find(
		(row) => row.port === port,
	);
	return entry?.features ?? [];
}
