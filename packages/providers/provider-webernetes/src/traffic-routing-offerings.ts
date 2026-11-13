import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";
import type { AbsentTrafficOffering } from "./delivery-coverage.js";

/**
 * Webernetes TrafficRouting offerings (plan 0024 WP13, I14; ADR-0143/0144).
 *
 * The local yard serves each station at its own loopback, private-network or
 * `.hobo.test` endpoint. Nothing in front of the stations routes traffic, and a
 * local yard is never publicly reachable. What remains is the portable
 * in-process floor: the local router (or the caller) splits traffic between
 * two stations. `provider` is `other`: the core union has no Webernetes member.
 */
export const WEBERNETES_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([
			offering("inprocess.weighted", {
				features: ["fallback-floor", "local-router"],
			}),
		]),
		fallbacks: Object.freeze(["inprocess.weighted"] as const),
	});

const NOTHING_IN_FRONT =
	"Each local station is its own endpoint; no load balancer or edge runs in front of the local yard";
const NO_DNS = "A local yard owns no DNS zone it could steer";
const NOT_PUBLIC =
	"A local yard is never publicly reachable; a public funnel would contradict its locality";

/** Offerings Webernetes cannot realize, declared absent rather than preview. */
export const WEBERNETES_TRAFFIC_ROUTING_ABSENT: readonly AbsentTrafficOffering[] =
	Object.freeze(
		(
			[
				["dns.failover", NO_DNS],
				["dns.weighted", NO_DNS],
				[
					"driver.route-bind",
					"The local yard has no deploy-time route-binding driver",
				],
				["edge.canary", NOTHING_IN_FRONT],
				["edge.header", NOTHING_IN_FRONT],
				["edge.path", NOTHING_IN_FRONT],
				["lb.health", NOTHING_IN_FRONT],
				["lb.lifecycle", NOTHING_IN_FRONT],
				["lb.locality", NOTHING_IN_FRONT],
				["lb.weighted", NOTHING_IN_FRONT],
				["mesh.optional", "The local yard runs no service mesh"],
				[
					"observe.health",
					"The station host reports existence, not a continuous health feed; readiness is a per-reconcile probe",
				],
				["observe.location", "A local yard has one location"],
				["overlay.funnel", NOT_PUBLIC],
				["overlay.funnel.multi", NOT_PUBLIC],
				["resiliency.edge", NOTHING_IN_FRONT],
			] as const
		).map(([offeringId, reason]) => Object.freeze({ offeringId, reason })),
	);

export const WEBERNETES_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	WEBERNETES_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
