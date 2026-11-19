import type { TrafficRoutingProviderProfile } from "@hobo/core";
import type { AbsentTrafficOffering } from "./delivery-coverage.js";

export const RAILWAY_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([]),
		fallbacks: Object.freeze(["inprocess.weighted"] as const),
	});

const NO_LB =
	"Railway sells no tenant-controlled load balancer; the edge proxy fronts one active deployment per service";
const NO_EDGE =
	"Railway's edge has no per-request routing rules between deployments";
const NO_DNS =
	"Railway custom domains are CNAMEs to one service; there is no weighted or failover DNS product";

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
				[
					"inprocess.weighted",
					"The in-process router is a portable Station fallback, not a native provider offering",
				],
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
