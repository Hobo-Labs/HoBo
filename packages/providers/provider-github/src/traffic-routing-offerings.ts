import type {
	TrafficRoutingOfferingId,
	TrafficRoutingProviderProfile,
} from "@hobo/core";

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
