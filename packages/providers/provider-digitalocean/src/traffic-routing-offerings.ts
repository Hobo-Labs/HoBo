import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";

export const DIGITALOCEAN_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	{
		provider: "other",
		offerings: [
			offering("lb.lifecycle", {
				stability: "preview",
				features: ["load-balancer", "declaration"],
			}),
			offering("lb.weighted", {
				stability: "preview",
				features: ["forwarding-rules", "declaration"],
			}),
			offering("lb.health", {
				stability: "preview",
				features: ["health-check", "declaration"],
			}),
			offering("dns.weighted", {
				stability: "preview",
				features: ["do-dns", "declaration"],
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

export const DIGITALOCEAN_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	DIGITALOCEAN_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
