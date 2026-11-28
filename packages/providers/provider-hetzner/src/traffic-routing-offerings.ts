import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";

export const HETZNER_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile = {
	provider: "other",
	offerings: [
		offering("lb.lifecycle", {
			stability: "preview",
			features: ["hetzner-load-balancer", "declaration"],
		}),
		offering("lb.weighted", {
			stability: "preview",
			features: ["target-weights", "declaration"],
		}),
		offering("lb.health", {
			stability: "preview",
			features: ["health-check", "declaration"],
		}),
		offering("dns.weighted", {
			stability: "preview",
			features: ["hetzner-dns", "declaration"],
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

export const HETZNER_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	HETZNER_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
