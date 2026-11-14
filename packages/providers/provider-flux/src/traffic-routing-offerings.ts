import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";
import type { AbsentTrafficOffering } from "./delivery-coverage.js";

/**
 * Flux TrafficRouting offerings (plan 0024 WP13, I14; ADR-0143/0144).
 *
 * FluxOS spreads an app's instances across nodes and its domain manager
 * balances requests across them evenly. A tenant controls neither weights nor
 * health policy, and one registered app runs one image set, so there is no
 * canary between versions. What remains is the portable in-process floor: the
 * caller's router splits traffic between two registered apps it owns.
 * `provider` is `other`: the core union has no Flux member.
 */
export const FLUX_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([
			offering("inprocess.weighted", {
				features: ["fallback-floor", "caller-owned-router"],
			}),
		]),
		fallbacks: Object.freeze(["inprocess.weighted"] as const),
	});

const EVEN =
	"FluxOS balances an app's instances evenly; tenants set no weights, health policy or lifecycle on it";
const ONE_IMAGE_SET =
	"A registered Flux app runs one image set; there is no per-request routing between versions";
const NO_DNS =
	"Flux app domains are managed by FluxOS with no tenant weighted or failover DNS";

/** Offerings Flux cannot realize, declared absent rather than preview. */
export const FLUX_TRAFFIC_ROUTING_ABSENT: readonly AbsentTrafficOffering[] =
	Object.freeze(
		(
			[
				["dns.failover", NO_DNS],
				["dns.weighted", NO_DNS],
				["driver.route-bind", "FluxOS has no deploy-time route-binding driver"],
				["edge.canary", ONE_IMAGE_SET],
				["edge.header", ONE_IMAGE_SET],
				["edge.path", ONE_IMAGE_SET],
				["lb.health", EVEN],
				["lb.lifecycle", EVEN],
				["lb.locality", EVEN],
				["lb.weighted", EVEN],
				[
					"mesh.optional",
					"Flux nodes are not members of a tenant service mesh",
				],
				[
					"observe.health",
					"FluxOS publishes instance placement, not backend health, to the tenant",
				],
				[
					"observe.location",
					"FluxOS reports node addresses, not request locality usable for routing",
				],
				["overlay.funnel", "No overlay network fronts a Flux app"],
				["overlay.funnel.multi", "No overlay network fronts a Flux app"],
				["resiliency.edge", EVEN],
			] as const
		).map(([offeringId, reason]) => Object.freeze({ offeringId, reason })),
	);

export const FLUX_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	FLUX_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
