/**
 * Kubernetes equivalence classes: the Kubernetes row of the cross-cloud
 * equivalence table (control-plane.md §Cross-cloud equivalence classes),
 * shipped as this provider's default Resource Definitions (HOBO-93 model /
 * ADR-0090).
 *
 * One class, and that is the honest count. Kubernetes natively provides
 * *compute* — a Deployment running containers behind a Service. It provides no
 * database, no object store, no queue and no cache; those arrive through
 * operators, which are third-party software installed into a cluster rather
 * than something the Kubernetes API offers. An equivalence row for one of them
 * would make Matching answer `full` for a capability that depends on software
 * this provider cannot see, let alone install.
 *
 * The Yard catalog in `./default-yard.ts` is wider than this table, and that is
 * not a contradiction: a Job, a CronJob and a PersistentVolumeClaim are real
 * allocatable Kubernetes objects, but they are not rows of the *cross-cloud*
 * equivalence table, which maps HoBo's capability ports onto a provider's
 * headline products.
 */
export const EQUIVALENCE_CLASSES = Object.freeze({
	"web/service": {
		port: "compute",
		resourceClass: "kubernetes:deployment",
		providerService: "Kubernetes Deployment",
		features: ["container", "http", "autoscaling"],
	},
} as const);

export type InitialCapabilityPort = keyof typeof EQUIVALENCE_CLASSES;

export const INITIAL_CAPABILITY_PORTS = Object.freeze(
	// SAFETY: assertion to `ect.keys(EQUIVALENCE_CLASSES) as InitialCapabilityPort[], )` is required at this boundary.
	Object.keys(EQUIVALENCE_CLASSES) as InitialCapabilityPort[],
);

export function equivalenceForPort(port: InitialCapabilityPort) {
	return EQUIVALENCE_CLASSES[port];
}

export function kubernetesNativePorts(): readonly string[] {
	return Object.freeze([
		...new Set(Object.values(EQUIVALENCE_CLASSES).map((entry) => entry.port)),
	]);
}
