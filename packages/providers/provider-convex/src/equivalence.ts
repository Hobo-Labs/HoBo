// Convex equivalence classes (ADR-0144 thin-adapter rule): the reactive
// TypeScript BaaS mapped honestly onto HoBo's agnostic ports. Feature lists
// are deliberately NARROW — a document store with code-side joins cannot
// claim relational or graph semantics, so `require` misses surface as
// partial(missing) verdicts with remediation, never fabricated parity.
// Vector search and scheduled functions ride as capability FEATURES because
// HoBo has no `vector` or scheduler port today (documented in
// docs/competitors/convex.md "Impedance boundaries").
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

// `Object.freeze`, not `as const` alone. `as const` is a compile-time claim
// and leaves the array mutable at runtime; this table is read on every realize,
// so a mutated entry would silently change what every later deploy provisions.
// The package's own test asserts `Object.isFrozen` for exactly that reason.
export const INITIAL_CAPABILITY_PORTS = Object.freeze([
	"web/service",
	"database/reactive",
	"objectStore",
] as const satisfies readonly InitialCapabilityPort[]);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}
