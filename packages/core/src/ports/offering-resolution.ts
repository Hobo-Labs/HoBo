import { deepFreeze } from "../parse-utils.js";

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
			readonly degraded?: readonly Id[];
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
	const qualified = new Set(
		profile.offerings
			.filter(
				(entry) => entry.stability === "stable" && entry.fidelity === "real",
			)
			.map((entry) => entry.id),
	);
	const fallbacks = profile.fallbacks.filter((id) => !native.has(id));
	const available = new Set([...native, ...fallbacks]);

	if (requested.length === 0) {
		const offered = profile.offerings.map((entry) => entry.id);
		const degraded = offered.filter((id) => !qualified.has(id));
		if (negotiation === "require") {
			return qualified.size > 0
				? { kind: "full", offerings: [...qualified] }
				: {
						kind: "none",
						missing: [],
						remediation: `provider ${profile.provider} has no stable, real native ${resourceClass} offerings`,
					};
		}
		if (degraded.length > 0) {
			return {
				kind: "partial",
				offerings: offered,
				missing: [],
				fallbacks: [],
				degraded,
			};
		}
		return {
			kind: "full",
			offerings: offered,
		};
	}
	if (negotiation === "require") {
		const missing = requested.filter((id) => !qualified.has(id));
		return missing.length === 0
			? { kind: "full", offerings: requested }
			: {
					kind: "none",
					missing,
					remediation: `provider ${profile.provider} lacks stable, real native ${resourceClass} offerings: ${missing.join(", ")}`,
				};
	}

	const present = requested.filter((id) => available.has(id));
	const missing = requested.filter((id) => !available.has(id));
	const usedFallbacks = present.filter((id) => fallbacks.includes(id));
	const degraded = present.filter((id) => native.has(id) && !qualified.has(id));

	if (
		missing.length === 0 &&
		usedFallbacks.length === 0 &&
		degraded.length === 0
	) {
		return { kind: "full", offerings: present };
	}
	if (missing.length === 0) {
		return {
			kind: "partial",
			offerings: present,
			missing: [],
			fallbacks: usedFallbacks,
			...(degraded.length ? { degraded } : undefined),
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
		...(degraded.length ? { degraded } : undefined),
	};
}

export function resolveResourceOfferings<
	Id extends string,
	Provider extends string,
>(
	resourceClass: string,
	profiles: readonly ResourceOfferingProfile<Id, Provider>[],
	request: ResourceOfferingRequest<Id> = {},
	options: {
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
	if (request.negotiation === "require" && request.features?.length) {
		const availability = uniqueIds(request.features).map((id) => ({
			id,
			providers: profiles
				.filter((profile) =>
					profile.offerings.some(
						(entry) =>
							entry.id === id &&
							entry.stability === "stable" &&
							entry.fidelity === "real",
					),
				)
				.map((profile) => profile.provider),
		}));
		return {
			kind: "unresolved",
			missing: availability
				.filter((entry) => entry.providers.length === 0)
				.map((entry) => entry.id),
			remediation: `no single provider satisfies required ${resourceClass} offerings: ${availability.map((entry) => `${entry.id} (${entry.providers.length ? entry.providers.join(", ") : "no qualifying provider"})`).join("; ")}`,
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
