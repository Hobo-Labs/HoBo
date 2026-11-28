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
