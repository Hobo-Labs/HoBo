import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";

/**
 * Kubernetes TrafficRouting offerings declaration (scaffold).
 *
 * Every offering below is `simulated` rather than `real`, and that is the
 * honest fidelity: a Service gives weighted routing only across the pods of one
 * Deployment, and everything richer — header matching, canaries, per-route
 * weights — needs an Ingress *controller* or a service mesh, which is software
 * an operator installs into the cluster rather than something the Kubernetes
 * API provides. Declaring these as `real` would let Matching negotiate a
 * feature that then falls through at realization on a bare cluster.
 */
export const KUBERNETES_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	{
		provider: "other",
		offerings: [
			offering("lb.lifecycle", {
				stability: "preview",
				fidelity: "simulated",
				features: ["service", "declaration"],
			}),
			offering("lb.health", {
				stability: "preview",
				fidelity: "simulated",
				features: ["readiness-probe", "declaration"],
			}),
			offering("mesh.optional", {
				stability: "experimental",
				fidelity: "simulated",
				features: ["requires-installed-mesh", "declaration"],
			}),
			offering("observe.health", {
				stability: "preview",
				fidelity: "simulated",
				features: ["declaration"],
			}),
			offering("inprocess.weighted", {
				features: ["fallback-floor"],
			}),
		],
		fallbacks: ["inprocess.weighted"],
	};

export const KUBERNETES_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	KUBERNETES_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
