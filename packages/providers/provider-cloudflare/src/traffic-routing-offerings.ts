import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";

/** Declared TrafficRouting offerings for Matching / custom-provider surface. */
export const CLOUDFLARE_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	{
		provider: "cloudflare",
		offerings: [
			offering("lb.lifecycle", {
				features: ["create-pool", "create-lb", "update", "delete"],
			}),
			offering("lb.weighted", { features: ["random-steering"] }),
			offering("lb.health", {
				stability: "preview",
				features: ["monitors-optional"],
			}),
			offering("observe.health", {
				stability: "preview",
				features: ["pool-health"],
			}),
		],
		fallbacks: ["dns.weighted", "inprocess.weighted"],
	};

export const CLOUDFLARE_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	CLOUDFLARE_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
