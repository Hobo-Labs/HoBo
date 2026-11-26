import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";

/**
 * Hostinger TrafficRouting offerings declaration (scaffold).
 *
 * Hostinger sells no load balancer, so the `lb.*` offerings are omitted rather
 * than declared as preview: an offering nothing can realize is worse than an
 * absent one, because Matching would negotiate it and then fall through. What
 * is left is DNS-level routing, which Hostinger genuinely does host, plus the
 * portable in-process floor Matching falls back to.
 */
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
