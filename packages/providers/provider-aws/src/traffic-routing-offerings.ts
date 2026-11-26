import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";

/**
 * AWS TrafficRouting offerings declaration (scaffold).
 * Native ALB/NLB HTTP adapter may land later; Matching can negotiate these
 * features while realization falls back to inprocess.weighted until then.
 */
export const AWS_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile = {
	provider: "other",
	offerings: [
		offering("lb.lifecycle", {
			stability: "preview",
			features: ["alb", "nlb", "declaration"],
		}),
		offering("lb.weighted", {
			stability: "preview",
			features: ["target-group-weights", "declaration"],
		}),
		offering("lb.health", {
			stability: "preview",
			features: ["target-health", "declaration"],
		}),
		offering("dns.weighted", {
			stability: "preview",
			features: ["route53", "declaration"],
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

export const AWS_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	AWS_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
