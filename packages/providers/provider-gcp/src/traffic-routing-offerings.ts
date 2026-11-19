import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";

export const GCP_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile = {
	provider: "other",
	offerings: [
		offering("lb.lifecycle", {
			stability: "preview",
			features: ["cloud-load-balancing", "declaration"],
		}),
		offering("lb.weighted", {
			stability: "preview",
			features: ["backend-service-weights", "declaration"],
		}),
		offering("lb.health", {
			stability: "preview",
			features: ["health-checks", "declaration"],
		}),
		offering("dns.weighted", {
			stability: "preview",
			features: ["cloud-dns", "declaration"],
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

export const GCP_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	GCP_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
