import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";

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
