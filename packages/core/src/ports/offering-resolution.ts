import { deepFreeze } from "../parse-utils.js";

/**
 * Generic offering resolution, keyed by resource class.
 *
 * Extracted from the traffic-routing offering negotiation (ADR-0143): the
 * "resolve user intent against station-registered provider offerings" pattern
 * — prefer/require negotiation plus an ordered portable-fallback ladder — is
 * the same for every resource class (traffic routing, data stores, queues,
 * identity, …). Vocabulary modules pin the `Id`/`Provider` unions per class
 * (`traffic-routing-offerings.ts`, `data-store-offerings.ts`); this module
 * owns the negotiation semantics so they can never drift apart per class.
 */
export type OfferingNegotiation = "prefer" | "require";

export type OfferingStability = "stable" | "preview" | "experimental";

export type OfferingFidelity = "real" | "simulated" | "mocked" | "camp-only";

export interface ResourceOffering<Id extends string = string> {
	readonly id: Id;
	readonly stability: OfferingStability;
	readonly fidelity: OfferingFidelity;
	readonly features: readonly string[];
}

export interface ResourceOfferingProfile<
	Id extends string = string,
	Provider extends string = string,
> {
	readonly provider: Provider;
	readonly offerings: readonly ResourceOffering<Id>[];
	/** Ordered fallback offering ids when native realization cannot cover the request. */
	readonly fallbacks: readonly Id[];
}

export interface ResourceOfferingRequest<Id extends string = string> {
	readonly features?: readonly Id[];
	readonly negotiation?: OfferingNegotiation;
}

export type ResourceOfferingMatch<Id extends string = string> =
	| { readonly kind: "full"; readonly offerings: readonly Id[] }
	| {
			readonly kind: "partial";
			readonly offerings: readonly Id[];
			readonly missing: readonly Id[];
			readonly fallbacks: readonly Id[];
	  }
	| {
			readonly kind: "none";
			readonly missing: readonly Id[];
			readonly remediation: string;
	  };

export type ResourceOfferingResolveResult<
	Id extends string = string,
	Provider extends string = string,
> =
	| {
			readonly kind: "resolved";
			readonly provider: Provider;
			readonly strategy: readonly Id[];
			readonly match: ResourceOfferingMatch<Id>;
	  }
	| {
			readonly kind: "unresolved";
			readonly missing: readonly Id[];
			readonly remediation: string;
	  };

/**
 * Match requested offerings against a provider profile with prefer/require
 * negotiation and the profile's fallback ladder. `resourceClass` names the
 * vocabulary in remediation messages (e.g. "traffic-routing", "data-store").
 */
export function matchResourceOfferings<
	Id extends string,
	Provider extends string,
>(
	resourceClass: string,
	profile: ResourceOfferingProfile<Id, Provider>,
	request: ResourceOfferingRequest<Id> = {},
): ResourceOfferingMatch<Id> {
	const requested = request.features ?? [];
	const negotiation = request.negotiation ?? "prefer";
	const native = new Set(profile.offerings.map((entry) => entry.id));
	const fallbacks = profile.fallbacks.filter((id) => !native.has(id));
	const available = new Set([...native, ...fallbacks]);

	if (requested.length === 0) {
		return {
			kind: "full",
			offerings: profile.offerings.map((entry) => entry.id),
		};
	}

	const present = requested.filter((id) => available.has(id));
	const missing = requested.filter((id) => !available.has(id));
	const usedFallbacks = present.filter((id) => fallbacks.includes(id));

	if (missing.length === 0 && usedFallbacks.length === 0) {
		return { kind: "full", offerings: present };
	}
	if (missing.length === 0) {
		return {
			kind: "partial",
			offerings: present,
			missing: [],
			fallbacks: usedFallbacks,
		};
	}
	if (negotiation === "require") {
		return {
			kind: "none",
			missing,
			remediation: `provider ${profile.provider} lacks required ${resourceClass} offerings: ${missing.join(", ")}`,
		};
	}
	if (present.length === 0) {
		return {
			kind: "none",
			missing,
			remediation: `provider ${profile.provider} cannot satisfy ${resourceClass} offerings: ${missing.join(", ")}`,
		};
	}
	return {
		kind: "partial",
		offerings: present,
		missing,
		fallbacks: usedFallbacks,
	};
}

/**
 * Resolve a request against candidate provider profiles for a resource class.
 * First profile that is not `none` wins (callers should rank by cost/policy).
 */
export function resolveResourceOfferings<
	Id extends string,
	Provider extends string,
>(
	resourceClass: string,
	profiles: readonly ResourceOfferingProfile<Id, Provider>[],
	request: ResourceOfferingRequest<Id> = {},
	options: {
		/** Reported as missing when no profiles are registered at all. */
		readonly defaultMissing?: readonly Id[];
	} = {},
): ResourceOfferingResolveResult<Id, Provider> {
	if (profiles.length === 0) {
		return {
			kind: "unresolved",
			missing: request.features ?? options.defaultMissing ?? [],
			remediation: `no ${resourceClass} provider profiles registered`,
		};
	}
	let lastMissing: readonly Id[] = request.features ?? [];
	let lastRemediation = `no provider satisfied ${resourceClass} request`;
	for (const profile of profiles) {
		const match = matchResourceOfferings(resourceClass, profile, request);
		if (match.kind === "none") {
			lastMissing = match.missing;
			lastRemediation = match.remediation;
			continue;
		}
		const strategy =
			match.kind === "full"
				? match.offerings
				: [...match.offerings, ...match.fallbacks];
		return {
			kind: "resolved",
			provider: profile.provider,
			strategy: uniqueIds(strategy),
			match,
		};
	}
	return {
		kind: "unresolved",
		missing: lastMissing,
		remediation: lastRemediation,
	};
}

function uniqueIds<Id extends string>(values: readonly Id[]): readonly Id[] {
	return deepFreeze([...new Set(values)]);
}
