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
	register(
		resourceClass: string,
		profile: ResourceOfferingProfile,
	): StationOfferingRegistration;
	resourceClasses(): readonly string[];
	profiles(resourceClass: string): readonly ResourceOfferingProfile[];
	match(
		resourceClass: string,
		provider: string,
		request?: ResourceOfferingRequest,
	): ResourceOfferingMatch | undefined;
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
