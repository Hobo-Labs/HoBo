import type {
	TrafficRoutingOfferingId,
	TrafficRoutingProviderProfile,
} from "@hobo/core";

export const NPM_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([]),
		fallbacks: Object.freeze([]),
	});

const NOT_TRAFFIC =
	"an npm registry serves package tarballs to installers and routes no request traffic; version selection is the dist-tag on the package-version resource";

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
