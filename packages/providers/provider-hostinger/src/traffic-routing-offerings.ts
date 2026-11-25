import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";

export const HOSTINGER_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	{
		provider: "other",
		offerings: [
			offering("dns.weighted", {
				stability: "preview",
				features: ["hostinger-dns", "declaration"],
			}),
			offering("dns.failover", {
				stability: "preview",
				features: ["hostinger-dns", "declaration"],
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

export const HOSTINGER_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	HOSTINGER_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
