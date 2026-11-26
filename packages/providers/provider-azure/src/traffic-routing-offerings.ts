import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";

/**
 * Azure TrafficRouting offerings declaration (scaffold).
 * Native LB HTTP adapter may land later; inprocess.weighted is the floor.
 */
export const AZURE_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile = {
	provider: "other",
	offerings: [
		offering("lb.lifecycle", {
			stability: "preview",
			features: ["load-balancer", "app-gateway", "declaration"],
		}),
		offering("lb.weighted", {
			stability: "preview",
			features: ["backend-pools", "declaration"],
		}),
		offering("lb.health", {
			stability: "preview",
			features: ["probes", "declaration"],
		}),
		offering("dns.weighted", {
			stability: "preview",
			features: ["traffic-manager", "declaration"],
		}),
		offering("observe.health", {
			stability: "preview",
			features: ["declaration"],
		}),
		offering("inprocess.weighted", {
			features: ["fallback-floor"],
		}),
	],
	fallbacks: ["inprocess.weighted"],
};

export const AZURE_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	AZURE_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
