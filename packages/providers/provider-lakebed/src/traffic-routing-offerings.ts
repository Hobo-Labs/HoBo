import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";
import type { AbsentTrafficOffering } from "./delivery-coverage.js";

/**
 * Lakebed TrafficRouting offerings (ADR-0143 dual layer; plan 0024 WP14, I14).
 *
 * Lakebed has no multi-backend load-balancer API. HoBo realizes weights in
 * process between capsule endpoints, and `realizeTrafficRoutingPlan` binds
 * the route at deploy time through the `lakebed-deploy` driver. Everything
 * else is declared absent with a reason (ADR-0144), never as preview.
 */
export const LAKEBED_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "lakebed",
		offerings: Object.freeze([
			offering("inprocess.weighted", {
				features: ["capsule-endpoints", "static-weights"],
			}),
			offering("driver.route-bind", {
				features: ["lakebed:traffic-route", "hobo.driver-program/v1"],
			}),
		]),
		fallbacks: Object.freeze([]),
	});

const NO_LB =
	"Lakebed exposes a deploy surface, not a load balancer: there is no API to pool or weight capsule backends";
const NO_EDGE =
	"Lakebed has no programmable edge in front of capsules; header, path and canary routing would be faked";
const NO_DNS =
	"Lakebed owns capsule hostnames under lakebed.app; HoBo cannot steer that zone";
const ALREADY_PUBLIC =
	"Capsules are already public on lakebed.app; a funnel overlay has nothing to publish";

/** Offerings Lakebed cannot realize, declared absent rather than preview. */
export const LAKEBED_TRAFFIC_ROUTING_ABSENT: readonly AbsentTrafficOffering[] =
	Object.freeze(
		(
			[
				["dns.failover", NO_DNS],
				["dns.weighted", NO_DNS],
				["edge.canary", NO_EDGE],
				["edge.header", NO_EDGE],
				["edge.path", NO_EDGE],
				["lb.health", NO_LB],
				["lb.lifecycle", NO_LB],
				["lb.locality", NO_LB],
				["lb.weighted", NO_LB],
				[
					"mesh.optional",
					"Capsules run in a closed runtime with no service mesh",
				],
				[
					"observe.health",
					"Lakebed publishes no continuous health feed; readiness is a per-reconcile probe of the capsule URL",
				],
				["observe.location", "Lakebed does not report where a capsule runs"],
				["overlay.funnel", ALREADY_PUBLIC],
				["overlay.funnel.multi", ALREADY_PUBLIC],
				["resiliency.edge", NO_EDGE],
			] as const
		).map(([offeringId, reason]) => Object.freeze({ offeringId, reason })),
	);

export const LAKEBED_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	LAKEBED_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
