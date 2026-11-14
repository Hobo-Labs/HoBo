import type { TrafficRoutingProviderProfile } from "@hobo/core";
import {
	type AbsentTrafficOffering,
	PORTABLE_TRAFFIC_OFFERING_IDS,
} from "./delivery-coverage.js";

/**
 * OCI registry TrafficRouting offerings (plan 0024, I14; ADR-0143/0144).
 *
 * A registry stores and serves content by digest. It routes no request traffic
 * to a workload, so it realizes no offering, not even the in-process floor:
 * that floor belongs to whichever host runs the image. Every portable offering
 * is declared absent with a reason rather than omitted, and there is no
 * fallback ladder. `provider` is `other` because the core union has no
 * registry member and this package does not edit `@hobo/core`.
 */
export const OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([]),
		fallbacks: Object.freeze([]),
	});

const REASON =
	"An OCI registry serves content by digest to pulling runtimes; it routes no workload traffic. Traffic offerings belong to the host that runs the image.";

/** Every portable offering, declared absent (ADR-0144: absent, not preview). */
export const OCI_REGISTRY_TRAFFIC_ROUTING_ABSENT: readonly AbsentTrafficOffering[] =
	Object.freeze(
		PORTABLE_TRAFFIC_OFFERING_IDS.map((offeringId) =>
			Object.freeze({ offeringId, reason: REASON }),
		),
	);
