import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";
import type { AbsentTrafficOffering } from "./delivery-coverage.js";

/**
 * Railway TrafficRouting offerings (plan 0024 WP13, I14; ADR-0143/0144).
 *
 * Railway routes a service's public domain to its single active deployment and
 * switches traffic only when a new deployment passes its deploy healthcheck.
 * There is no weighted split, no header or path routing between deployments,
 * no canary and no DNS steering a tenant controls. What remains is the
 * portable in-process floor, where the caller's own router splits traffic
 * between two Railway services it already owns. `provider` is `other`: the
 * core union has no Railway member and WP13 does not edit `@hobo/core`.
 */
export const RAILWAY_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([
			offering("inprocess.weighted", {
				features: ["fallback-floor", "caller-owned-router"],
			}),
		]),
		fallbacks: Object.freeze(["inprocess.weighted"] as const),
	});

const NO_LB =
	"Railway sells no tenant-controlled load balancer; the edge proxy fronts one active deployment per service";
const NO_EDGE =
	"Railway's edge has no per-request routing rules between deployments";
const NO_DNS =
	"Railway custom domains are CNAMEs to one service; there is no weighted or failover DNS product";

/** Offerings Railway cannot realize, declared absent rather than preview. */
export const RAILWAY_TRAFFIC_ROUTING_ABSENT: readonly AbsentTrafficOffering[] =
	Object.freeze(
		(
			[
				["dns.failover", NO_DNS],
				["dns.weighted", NO_DNS],
				[
					"driver.route-bind",
					"Railway exposes no deploy-time route-binding driver",
				],
				["edge.canary", NO_EDGE],
				["edge.header", NO_EDGE],
				["edge.path", NO_EDGE],
				["lb.health", NO_LB],
				["lb.lifecycle", NO_LB],
				["lb.locality", NO_LB],
				["lb.weighted", NO_LB],
				["mesh.optional", "Railway private networking is not a service mesh"],
				[
					"observe.health",
					"Railway healthchecks gate a deploy once; there is no continuous backend health feed",
				],
				[
					"observe.location",
					"Railway does not report per-request client location to the tenant",
				],
				["overlay.funnel", "No overlay network is part of a Railway service"],
				[
					"overlay.funnel.multi",
					"No overlay network is part of a Railway service",
				],
				[
					"resiliency.edge",
					"Railway's edge exposes no retry or timeout policy",
				],
			] as const
		).map(([offeringId, reason]) => Object.freeze({ offeringId, reason })),
	);

export const RAILWAY_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	RAILWAY_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
