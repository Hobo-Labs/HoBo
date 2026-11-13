import type {
	TrafficRoutingOfferingId,
	TrafficRoutingProviderProfile,
} from "@hobo/core";

/**
 * GitHub Pages TrafficRouting offerings (plan 0024, I14; ADR-0143/0144).
 *
 * A Pages site serves exactly one published tree per repository from GitHub's
 * CDN. There is no weighted split, no header or path routing between
 * versions, no canary, no load balancer, no health feed and no DNS steering a
 * tenant controls: publishing replaces the whole site at once. So the profile
 * declares nothing and no fallback — a rollout that needs weighted or canary
 * routing must refuse on a Pages Camp rather than be told the in-process floor
 * applies to a static CDN. `provider` is `other`: the core union has no GitHub
 * member.
 */
export const GITHUB_PAGES_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([]),
		fallbacks: Object.freeze([]),
	});

const NOT_ROUTABLE =
	"a GitHub Pages site serves one published tree per repository from GitHub's CDN; publishing replaces it atomically and no request routing is exposed";

// public-contract: every TrafficRouting offering, each declared absent for GitHub Pages.
export const GITHUB_PAGES_TRAFFIC_ROUTING_ABSENT: readonly {
	readonly offeringId: TrafficRoutingOfferingId;
	readonly reason: string;
}[] = Object.freeze(
	(
		[
			"dns.failover",
			"dns.weighted",
			"driver.route-bind",
			"edge.canary",
			"edge.header",
			"edge.path",
			"inprocess.weighted",
			"lb.health",
			"lb.lifecycle",
			"lb.locality",
			"lb.weighted",
			"mesh.optional",
			"observe.health",
			"observe.location",
			"overlay.funnel",
			"overlay.funnel.multi",
			"resiliency.edge",
		] as const
	).map((offeringId) => Object.freeze({ offeringId, reason: NOT_ROUTABLE })),
);

export const GITHUB_PAGES_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	GITHUB_PAGES_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
