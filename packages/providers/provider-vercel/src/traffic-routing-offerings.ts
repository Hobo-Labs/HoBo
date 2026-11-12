import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";
import type { AbsentTrafficOffering } from "./delivery-coverage.js";

/**
 * Vercel TrafficRouting offerings (ADR-0143/0144; plan 0024 WP14 audit, I14).
 *
 * Realized by `@hobo/connectivity`'s Vercel adapter: Rolling Releases give a
 * weighted canary between two deployments, and project routes give path and
 * header rewrites. The in-process router is the portable fallback, realized by
 * the Station rather than by Vercel. This record is byte-equal to
 * `VERCEL_TRAFFIC_ROUTING_PROFILE` in `@hobo/connectivity` (asserted in
 * `@hobo/hobo`'s catalog tests); this package cannot import connectivity.
 */
export const VERCEL_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "vercel",
		offerings: Object.freeze([
			offering("edge.canary", { features: ["rolling-release"] }),
			offering("edge.path", { features: ["project-routes"] }),
			offering("edge.header", { features: ["route-has"] }),
		]),
		fallbacks: Object.freeze(["inprocess.weighted"] as const),
	});

const ONE_EDGE =
	"Vercel's edge fronts each project as a whole; the adapter shifts traffic through Rolling Releases and routes, not a separately managed load balancer";
const NO_DNS =
	"Vercel serves the project domain itself; HoBo shifts traffic at the edge, not by steering DNS records";

/** Offerings Vercel cannot realize through the shipped adapter, declared absent. */
export const VERCEL_TRAFFIC_ROUTING_ABSENT: readonly AbsentTrafficOffering[] =
	Object.freeze(
		(
			[
				["dns.failover", NO_DNS],
				["dns.weighted", NO_DNS],
				[
					"driver.route-bind",
					"Vercel routing is applied through the API by Station cutover, not bound by a deploy-time driver",
				],
				[
					"inprocess.weighted",
					"Vercel does not split requests in process; the Station's in-process router is the portable fallback",
				],
				["lb.health", ONE_EDGE],
				["lb.lifecycle", ONE_EDGE],
				["lb.locality", ONE_EDGE],
				["lb.weighted", ONE_EDGE],
				["mesh.optional", "Vercel functions run without a service mesh"],
				[
					"observe.health",
					"The adapter reads Rolling Release state, not backend health; verification sources observe health",
				],
				[
					"observe.location",
					"Vercel does not report which region served a request through the adapter",
				],
				[
					"overlay.funnel",
					"Vercel deployments are already public; a funnel overlay has nothing to publish",
				],
				[
					"overlay.funnel.multi",
					"Vercel deployments are already public; a funnel overlay has nothing to publish",
				],
				[
					"resiliency.edge",
					"The adapter configures no retries or circuit breaking at the Vercel edge",
				],
			] as const
		).map(([offeringId, reason]) => Object.freeze({ offeringId, reason })),
	);

export const VERCEL_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	VERCEL_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
