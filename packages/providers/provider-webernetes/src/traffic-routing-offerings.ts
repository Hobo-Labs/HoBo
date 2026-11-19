import type { TrafficRoutingProviderProfile } from "@hobo/core";
import type { AbsentTrafficOffering } from "./delivery-coverage.js";

export const WEBERNETES_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([]),
		fallbacks: Object.freeze(["inprocess.weighted"] as const),
	});

const NOTHING_IN_FRONT =
	"Each local station is its own endpoint; no load balancer or edge runs in front of the local yard";
const NO_DNS = "A local yard owns no DNS zone it could steer";
const NOT_PUBLIC =
	"A local yard is never publicly reachable; a public funnel would contradict its locality";

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
				[
					"inprocess.weighted",
					"The in-process router is a portable Station fallback, not a native provider offering",
				],
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
