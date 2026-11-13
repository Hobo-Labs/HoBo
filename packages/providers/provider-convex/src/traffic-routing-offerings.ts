import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";
import type { AbsentTrafficOffering } from "./delivery-coverage.js";

/**
 * Convex TrafficRouting offerings (plan 0024 WP13, I14; ADR-0143/0144).
 *
 * A Convex deployment is one backend at one URL; code pushes replace it in
 * place. Convex offers no weighted split, canary, header/path routing or DNS
 * steering between deployments. What remains is the portable in-process
 * floor: the client chooses which deployment URL to talk to. `provider` is
 * `other`: the core union has no Convex member.
 */
export const CONVEX_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([
			offering("inprocess.weighted", {
				features: ["fallback-floor", "client-selects-deployment-url"],
			}),
		]),
		fallbacks: Object.freeze(["inprocess.weighted"] as const),
	});

const ONE_URL =
	"A Convex deployment is one backend behind one URL; Convex exposes no traffic control in front of it";
const NO_DNS =
	"Convex deployment URLs are Convex-owned names with no tenant DNS steering";

/** Offerings Convex cannot realize, declared absent rather than preview. */
export const CONVEX_TRAFFIC_ROUTING_ABSENT: readonly AbsentTrafficOffering[] =
	Object.freeze(
		(
			[
				["dns.failover", NO_DNS],
				["dns.weighted", NO_DNS],
				["driver.route-bind", "Convex has no deploy-time route-binding driver"],
				["edge.canary", ONE_URL],
				["edge.header", ONE_URL],
				["edge.path", ONE_URL],
				["lb.health", ONE_URL],
				["lb.lifecycle", ONE_URL],
				["lb.locality", ONE_URL],
				["lb.weighted", ONE_URL],
				["mesh.optional", "Convex is a managed backend, not a mesh member"],
				[
					"observe.health",
					"Convex reports no backend health feed through the Management API",
				],
				["observe.location", "Convex reports no client location to the tenant"],
				["overlay.funnel", "No overlay network fronts a Convex deployment"],
				[
					"overlay.funnel.multi",
					"No overlay network fronts a Convex deployment",
				],
				["resiliency.edge", ONE_URL],
			] as const
		).map(([offeringId, reason]) => Object.freeze({ offeringId, reason })),
	);

export const CONVEX_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	CONVEX_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
