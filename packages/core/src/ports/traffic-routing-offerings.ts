import { cloneAsJson, isJsonString, type JsonValue } from "../json.js";
import { deepFreeze, enumValue, expectObject } from "../parse-utils.js";
import {
	matchResourceOfferings,
	type OfferingFidelity,
	type OfferingNegotiation,
	type OfferingStability,
	type ResourceOfferingMatch,
	type ResourceOfferingResolveResult,
	resolveResourceOfferings,
} from "./offering-resolution.js";
import {
	parseRoutingProvider,
	TrafficRoutingParseError,
	type TrafficRoutingProvider,
} from "./traffic-routing.js";

/**
 * Portable TrafficRouting offerings (ADR-0143).
 * Providers declare these up front; apply-result capabilities prove realization.
 * Negotiation semantics live in the generic resolver (`offering-resolution.ts`);
 * this module pins the traffic-routing vocabulary and parse boundary.
 */
export type TrafficRoutingOfferingId =
	| "lb.lifecycle"
	| "lb.weighted"
	| "lb.health"
	| "lb.locality"
	| "edge.path"
	| "edge.header"
	| "edge.canary"
	| "dns.weighted"
	| "dns.failover"
	| "overlay.funnel"
	| "overlay.funnel.multi"
	| "inprocess.weighted"
	| "driver.route-bind"
	| "mesh.optional"
	| "observe.health"
	| "observe.location"
	| "resiliency.edge";

export type TrafficRoutingOfferingStability = OfferingStability;

export type TrafficRoutingOfferingFidelity = OfferingFidelity;

export type TrafficRoutingNegotiation = OfferingNegotiation;

export interface TrafficRoutingOffering {
	readonly id: TrafficRoutingOfferingId;
	readonly stability: TrafficRoutingOfferingStability;
	readonly fidelity: TrafficRoutingOfferingFidelity;
	readonly features: readonly string[];
}

export interface TrafficRoutingProviderProfile {
	readonly provider: TrafficRoutingProvider;
	readonly offerings: readonly TrafficRoutingOffering[];
	/** Ordered fallback offering ids when native realization cannot cover the plan. */
	readonly fallbacks: readonly TrafficRoutingOfferingId[];
}

export interface TrafficRoutingPortRequest {
	readonly features?: readonly TrafficRoutingOfferingId[];
	readonly negotiation?: TrafficRoutingNegotiation;
}

export type TrafficRoutingMatch =
	ResourceOfferingMatch<TrafficRoutingOfferingId>;

export type TrafficRoutingResolveResult = ResourceOfferingResolveResult<
	TrafficRoutingOfferingId,
	TrafficRoutingProvider
>;

const OFFERINGS = new Set<TrafficRoutingOfferingId>([
	"lb.lifecycle",
	"lb.weighted",
	"lb.health",
	"lb.locality",
	"edge.path",
	"edge.header",
	"edge.canary",
	"dns.weighted",
	"dns.failover",
	"overlay.funnel",
	"overlay.funnel.multi",
	"inprocess.weighted",
	"driver.route-bind",
	"mesh.optional",
	"observe.health",
	"observe.location",
	"resiliency.edge",
]);

const STABILITIES = new Set<TrafficRoutingOfferingStability>([
	"stable",
	"preview",
	"experimental",
]);

const FIDELITIES = new Set<TrafficRoutingOfferingFidelity>([
	"real",
	"simulated",
	"mocked",
	"camp-only",
]);

/** Default portable fallback ladder when a profile omits `fallbacks`. */
export const DEFAULT_TRAFFIC_ROUTING_FALLBACKS: readonly TrafficRoutingOfferingId[] =
	[
		"edge.canary",
		"edge.path",
		"edge.header",
		"dns.weighted",
		"dns.failover",
		"overlay.funnel.multi",
		"overlay.funnel",
		"inprocess.weighted",
		"driver.route-bind",
	];

export function parseTrafficRoutingOfferingId(
	value: JsonValue | undefined,
	path = "offeringId",
): TrafficRoutingOfferingId {
	return enumValue(value, OFFERINGS, path, TrafficRoutingParseError);
}

export function parseTrafficRoutingOffering(
	value: JsonValue | undefined,
	path = "offering",
): TrafficRoutingOffering {
	const input = expectObject(value, path, TrafficRoutingParseError);
	const features = Array.isArray(input.features)
		? input.features.map((feature, index) => {
				if (!isJsonString(feature) || feature.trim().length === 0) {
					throw new TrafficRoutingParseError(
						`${path}.features[${index}]`,
						"non-empty string",
						feature,
					);
				}
				return feature.trim();
			})
		: [];
	return deepFreeze({
		id: parseTrafficRoutingOfferingId(input.id, `${path}.id`),
		stability: enumValue(
			input.stability ?? "stable",
			STABILITIES,
			`${path}.stability`,
			TrafficRoutingParseError,
		),
		fidelity: enumValue(
			input.fidelity ?? "real",
			FIDELITIES,
			`${path}.fidelity`,
			TrafficRoutingParseError,
		),
		features: deepFreeze(features),
	});
}

export function parseTrafficRoutingProviderProfile(
	value: JsonValue | undefined,
	path = "profile",
): TrafficRoutingProviderProfile {
	const input = expectObject(value, path, TrafficRoutingParseError);
	const offerings = (
		Array.isArray(input.offerings)
			? input.offerings
			: fail(path, "offerings array", input.offerings)
	).map((entry, index) =>
		parseTrafficRoutingOffering(entry, `${path}.offerings[${index}]`),
	);
	const ids = new Set(offerings.map((entry) => entry.id));
	if (ids.size !== offerings.length) {
		fail(`${path}.offerings`, "unique offering ids", input.offerings);
	}
	const fallbacks = Array.isArray(input.fallbacks)
		? input.fallbacks.map((entry, index) =>
				parseTrafficRoutingOfferingId(entry, `${path}.fallbacks[${index}]`),
			)
		: [...DEFAULT_TRAFFIC_ROUTING_FALLBACKS];
	return deepFreeze({
		provider: parseRoutingProvider(input.provider, `${path}.provider`),
		offerings,
		fallbacks: deepFreeze(fallbacks),
	});
}

// public-contract: registry key consumers use to register/resolve this class.
export const TRAFFIC_ROUTING_RESOURCE_CLASS = "traffic-routing";

/**
 * Match requested offerings against a provider profile with prefer/require
 * negotiation and the profile's fallback ladder. Thin vocabulary binding over
 * the generic per-resource-class resolver.
 */
export function matchTrafficRoutingOfferings(
	profile: TrafficRoutingProviderProfile,
	request: TrafficRoutingPortRequest = {},
): TrafficRoutingMatch {
	return matchResourceOfferings(
		TRAFFIC_ROUTING_RESOURCE_CLASS,
		profile,
		request,
	);
}

/**
 * Resolve a plan request against candidate provider profiles.
 * First profile that is not `none` wins (callers should rank by cost/policy).
 */
export function resolveTrafficRouting(
	profiles: readonly TrafficRoutingProviderProfile[],
	request: TrafficRoutingPortRequest = {},
): TrafficRoutingResolveResult {
	return resolveResourceOfferings(
		TRAFFIC_ROUTING_RESOURCE_CLASS,
		profiles,
		request,
		{ defaultMissing: ["inprocess.weighted"] },
	);
}

export function offering(
	id: TrafficRoutingOfferingId,
	options: {
		readonly stability?: TrafficRoutingOfferingStability;
		readonly fidelity?: TrafficRoutingOfferingFidelity;
		readonly features?: readonly string[];
	} = {},
): TrafficRoutingOffering {
	return deepFreeze({
		id,
		stability: options.stability ?? "stable",
		fidelity: options.fidelity ?? "real",
		features: deepFreeze([...(options.features ?? [])]),
	});
}

function fail<T>(path: string, expected: string, received: T): never {
	throw new TrafficRoutingParseError(path, expected, cloneAsJson(received));
}
