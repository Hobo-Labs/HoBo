import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";
import type { AbsentTrafficOffering } from "./delivery-coverage.js";

/**
 * Netlify TrafficRouting offerings (ADR-0143/0144; plan 0024 WP14, I14).
 *
 * The audit against `@hobo/connectivity` found no Netlify profile and no
 * Netlify adapter. Every static deploy HoBo delivers is immutable and keeps
 * its own permalink, so the Station's in-process router can weight between
 * two deploys: that is the one offering realized. Netlify's own split testing
 * splits by git branch, and HoBo delivers immutable deploys rather than
 * branches, so it is declared absent rather than faked. `provider` is `other`:
 * the core union has no Netlify member and `@hobo/core` is not edited.
 */
export const NETLIFY_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([
			offering("inprocess.weighted", {
				features: ["deploy-permalinks", "static-weights"],
			}),
		]),
		fallbacks: Object.freeze([]),
	});

const BRANCH_SPLIT =
	"Netlify split testing splits by git branch; HoBo delivers immutable deploys, not branches, and ships no Netlify routing adapter";
const NO_LB =
	"Netlify's CDN fronts each site as a whole; there is no API to pool or weight deploy backends";
const NO_DNS =
	"HoBo shifts traffic between deploy permalinks in process, not by steering the site's DNS";
const ALREADY_PUBLIC =
	"Netlify deploys are already public; a funnel overlay has nothing to publish";

/** Offerings Netlify cannot realize, declared absent rather than preview. */
export const NETLIFY_TRAFFIC_ROUTING_ABSENT: readonly AbsentTrafficOffering[] =
	Object.freeze(
		(
			[
				["dns.failover", NO_DNS],
				["dns.weighted", NO_DNS],
				["driver.route-bind", "No deploy-time driver binds Netlify routes"],
				["edge.canary", BRANCH_SPLIT],
				["edge.header", BRANCH_SPLIT],
				["edge.path", BRANCH_SPLIT],
				["lb.health", NO_LB],
				["lb.lifecycle", NO_LB],
				["lb.locality", NO_LB],
				["lb.weighted", NO_LB],
				["mesh.optional", "Netlify runs no service mesh"],
				[
					"observe.health",
					"Netlify publishes no backend health feed; readiness is a per-reconcile probe of the deploy URL",
				],
				[
					"observe.location",
					"Netlify does not report which edge served a request",
				],
				["overlay.funnel", ALREADY_PUBLIC],
				["overlay.funnel.multi", ALREADY_PUBLIC],
				["resiliency.edge", BRANCH_SPLIT],
			] as const
		).map(([offeringId, reason]) => Object.freeze({ offeringId, reason })),
	);

export const NETLIFY_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	NETLIFY_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
