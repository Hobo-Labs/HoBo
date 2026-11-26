// Station offering registry: operators register per-resource-class provider
// profiles against a station; user intents resolve through the generic
// prefer/require negotiation (plan-25 Resource Definition Matching). Traffic
// routing was the first class; data stores are the first non-routing class —
// the registry itself is vocabulary-agnostic.
import {
	matchResourceOfferings,
	type ResourceOfferingMatch,
	type ResourceOfferingProfile,
	type ResourceOfferingRequest,
	type ResourceOfferingResolveResult,
	resolveResourceOfferings,
} from "@hobo/core";

export interface StationOfferingRegistration {
	readonly stationId: string;
	readonly resourceClass: string;
	readonly profile: ResourceOfferingProfile;
	readonly registeredAt: string;
}

export interface StationOfferingRegistry {
	readonly stationId: string;
	/** Register a provider profile for a resource class; last write per (class, provider) wins. */
	register(
		resourceClass: string,
		profile: ResourceOfferingProfile,
	): StationOfferingRegistration;
	/** All registered resource classes, sorted. */
	resourceClasses(): readonly string[];
	/** Profiles registered for a class, in registration order. */
	profiles(resourceClass: string): readonly ResourceOfferingProfile[];
	/** Match a request against one registered provider's profile. */
	match(
		resourceClass: string,
		provider: string,
		request?: ResourceOfferingRequest,
	): ResourceOfferingMatch | undefined;
	/**
	 * Resolve a request against every profile registered for the class.
	 * First non-`none` profile wins; callers rank candidates by cost/policy
	 * before registration order matters.
	 */
	resolve(
		resourceClass: string,
		request?: ResourceOfferingRequest,
	): ResourceOfferingResolveResult;
}

export interface CreateStationOfferingRegistryOptions {
	readonly stationId: string;
	readonly clock?: () => string;
}

export function createStationOfferingRegistry(
	options: CreateStationOfferingRegistryOptions,
): StationOfferingRegistry {
	const clock = options.clock ?? (() => new Date().toISOString());
	// class → provider → profile, preserving first-registration order per class.
	const classes = new Map<string, Map<string, ResourceOfferingProfile>>();

	function requireClass(resourceClass: string): string {
		const trimmed = resourceClass.trim();
		if (trimmed.length === 0) {
			throw new Error("resourceClass must be a non-empty string");
		}
		return trimmed;
	}

	return {
		stationId: options.stationId,
		register(resourceClass, profile) {
			const key = requireClass(resourceClass);
			const byProvider =
				classes.get(key) ?? new Map<string, ResourceOfferingProfile>();
			byProvider.set(profile.provider, profile);
			classes.set(key, byProvider);
			return Object.freeze({
				stationId: options.stationId,
				resourceClass: key,
				profile,
				registeredAt: clock(),
			});
		},
		resourceClasses() {
			return Object.freeze([...classes.keys()].sort());
		},
		profiles(resourceClass) {
			const byProvider = classes.get(requireClass(resourceClass));
			return Object.freeze(byProvider ? [...byProvider.values()] : []);
		},
		match(resourceClass, provider, request = {}) {
			const key = requireClass(resourceClass);
			const profile = classes.get(key)?.get(provider);
			if (!profile) return undefined;
			return matchResourceOfferings(key, profile, request);
		},
		resolve(resourceClass, request = {}) {
			const key = requireClass(resourceClass);
			return resolveResourceOfferings(key, this.profiles(key), request);
		},
	};
}
