import { offering, type TrafficRoutingProviderProfile } from "@hobo/core";
import type { AbsentTrafficOffering } from "./delivery-coverage.js";

/**
 * Browser WASM TrafficRouting offerings (plan 0024 WP14, I14; ADR-0143/0144).
 *
 * A browser guest receives calls from the host page that instantiated it,
 * inside one browsing context. The only traffic split that exists is the host
 * page choosing which published guest version to instantiate, by weight: the
 * in-process floor. `provider` is `other`: the core union has no browser-wasm
 * member, and `@hobo/core` is not edited (plan 0024 §12).
 */
export const BROWSER_WASM_TRAFFIC_ROUTING_PROFILE: TrafficRoutingProviderProfile =
	Object.freeze({
		provider: "other",
		offerings: Object.freeze([
			offering("inprocess.weighted", {
				features: ["host-page-selection", "static-weights"],
			}),
		]),
		fallbacks: Object.freeze([]),
	});

const NO_NETWORK_HOP =
	"Calls reach a guest inside the browsing context; there is no network hop to balance or route";
const NO_DNS =
	"A guest has no hostname of its own; the host page's origin owns DNS";
const NOT_A_SERVER =
	"A browser guest is not reachable from outside its tab; there is nothing to publish";

/** Offerings a browser guest cannot realize, declared absent rather than preview. */
export const BROWSER_WASM_TRAFFIC_ROUTING_ABSENT: readonly AbsentTrafficOffering[] =
	Object.freeze(
		(
			[
				["dns.failover", NO_DNS],
				["dns.weighted", NO_DNS],
				[
					"driver.route-bind",
					"The host origin is delivered by another provider; no driver binds guest routes",
				],
				["edge.canary", NO_NETWORK_HOP],
				["edge.header", NO_NETWORK_HOP],
				["edge.path", NO_NETWORK_HOP],
				["lb.health", NO_NETWORK_HOP],
				["lb.lifecycle", NO_NETWORK_HOP],
				["lb.locality", NO_NETWORK_HOP],
				["lb.weighted", NO_NETWORK_HOP],
				["mesh.optional", "A browsing context runs no service mesh"],
				[
					"observe.health",
					"Guest health lives in visitors' tabs; HoBo observes only the host origin's publication",
				],
				[
					"observe.location",
					"A guest runs wherever its visitors are; HoBo does not track browsers",
				],
				["overlay.funnel", NOT_A_SERVER],
				["overlay.funnel.multi", NOT_A_SERVER],
				["resiliency.edge", NO_NETWORK_HOP],
			] as const
		).map(([offeringId, reason]) => Object.freeze({ offeringId, reason })),
	);

export const BROWSER_WASM_TRAFFIC_ROUTING_OFFERING_IDS = Object.freeze(
	BROWSER_WASM_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
);
