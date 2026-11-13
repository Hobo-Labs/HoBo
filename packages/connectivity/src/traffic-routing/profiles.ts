import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";

/** Portable offline floor. */
export const SIMPLE_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile = {
	provider: "simple",
	offerings: [offering("inprocess.weighted", { features: ["static-weights"] })],
	fallbacks: [],
};

/** Cloudflare Load Balancing — lifecycle create/update/delete + weighted. */
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
			offering("observe.health", { stability: "preview" }),
		],
		fallbacks: ["dns.weighted", "inprocess.weighted"],
	};

/** Vercel edge canary + path/header routes. */
export const VERCEL_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile = {
	provider: "vercel",
	offerings: [
		offering("edge.canary", { features: ["rolling-release"] }),
		offering("edge.path", { features: ["project-routes"] }),
		offering("edge.header", { features: ["route-has"] }),
	],
	fallbacks: ["inprocess.weighted"],
};

/** Lakebed dual-layer: in-process + deploy-time driver bind. Mirrors
 * `@hobo/provider-lakebed`'s profile (plan 0024 WP14; asserted in
 * `@hobo/hobo`'s catalog tests). */
export const LAKEBED_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile = {
	provider: "lakebed",
	offerings: [
		offering("inprocess.weighted", {
			features: ["capsule-endpoints", "static-weights"],
		}),
		offering("driver.route-bind", {
			features: ["lakebed:traffic-route", "hobo.driver-program/v1"],
		}),
	],
	fallbacks: [],
};

/**
 * Netlify (plan 0024 WP14 audit): no Netlify routing adapter ships, and
 * Netlify's split testing splits by git branch, so the only realized offering
 * is in-process weighting between immutable deploy permalinks. Kind `other`:
 * the core union has no Netlify member. Mirrors `@hobo/provider-netlify`.
 */
export const NETLIFY_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile = {
	provider: "other",
	offerings: [
		offering("inprocess.weighted", {
			features: ["deploy-permalinks", "static-weights"],
		}),
	],
	fallbacks: [],
};

/** Tailscale Funnel via Junction overlay — single and multi-backend compose. */
export const FUNNEL_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile = {
	provider: "funnel",
	offerings: [
		offering("overlay.funnel", { features: ["publishFunnel"] }),
		offering("overlay.funnel.multi", {
			features: ["weighted-select", "primary-public-tip"],
		}),
		offering("inprocess.weighted", { features: ["selection"] }),
	],
	fallbacks: ["inprocess.weighted"],
};

export const BUILTIN_TRAFFIC_ROUTING_PROFILES: readonly TrafficRoutingProviderProfile[] =
	[
		SIMPLE_TRAFFIC_ROUTING_PROFILE,
		CLOUDFLARE_TRAFFIC_ROUTING_PROFILE,
		VERCEL_TRAFFIC_ROUTING_PROFILE,
		LAKEBED_TRAFFIC_ROUTING_PROFILE,
		FUNNEL_TRAFFIC_ROUTING_PROFILE,
		NETLIFY_TRAFFIC_ROUTING_PROFILE,
	];
