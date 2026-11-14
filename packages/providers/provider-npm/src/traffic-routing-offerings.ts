import type {
	TrafficRoutingOfferingId,
	TrafficRoutingProviderProfile,
} from "@hobo/core";

/**
 * npm TrafficRouting offerings (plan 0024, I14; ADR-0143/0144).
 *
 * A package registry serves tarballs to installers; it routes no request
 * traffic at all. The closest thing it has to a traffic lever is the dist-tag,
 * which selects which version `npm install <name>@<tag>` resolves, and that is
 * modelled as desired state of the package-version resource (the promotion
 * lever), not as a routing offering. So the profile declares nothing and no
 * fallback: a rollout that needs weighted or canary routing must refuse on an
 * npm Camp rather than be told the in-process floor applies to installers.
 * `provider` is `other`: the core union has no registry member.
 */
export const NPM_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([]),
		fallbacks: Object.freeze([]),
	});

const NOT_TRAFFIC =
	"an npm registry serves package tarballs to installers and routes no request traffic; version selection is the dist-tag on the package-version resource";

// public-contract: every TrafficRouting offering, each declared absent for npm.
export const NPM_TRAFFIC_ROUTING_ABSENT: readonly {
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
	).map((offeringId) => Object.freeze({ offeringId, reason: NOT_TRAFFIC })),
);

export const NPM_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	NPM_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
