import type { TrafficRoutingProviderProfile } from "@hobo/core";
import {
	type AbsentTrafficOffering,
	PORTABLE_TRAFFIC_OFFERING_IDS,
} from "./delivery-coverage.js";

export const OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([]),
		fallbacks: Object.freeze([]),
	});

const REASON =
	"An OCI registry serves content by digest to pulling runtimes; it routes no workload traffic. Traffic offerings belong to the host that runs the image.";

export const OCI_REGISTRY_TRAFFIC_ROUTING_ABSENT: readonly AbsentTrafficOffering[] =
	Object.freeze(
		PORTABLE_TRAFFIC_OFFERING_IDS.map((offeringId) =>
			Object.freeze({ offeringId, reason: REASON }),
		),
	);
