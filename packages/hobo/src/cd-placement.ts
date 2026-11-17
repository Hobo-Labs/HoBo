import { createHash } from "node:crypto";

import type { YardRuntime } from "@hobo/cli";
import {
	createRegistryFromProviders,
	type IacProgram,
	type IacProvider,
	type PlannerRegistry,
} from "@hobo/cloud";
import { CD_PLACEMENT_YARDS } from "@hobo/hobo-cd";
import type { Yard } from "@hobo/yards";

import { relayYardRegistryProvider } from "./ci-relay-delivery.js";

// `hobo cd plan|up` place the CD project with this machine's providers plus
// the Yards `hobo cd up` makes for it (`@hobo/hobo-cd` `placement.ts`): the
// journal's fleet and the owner's config service. Neither is registered here,
// so a plan without them rejects `cd-journal` and `cd-config`.

/** `base` with each Yard's offerings added; the base's live view is kept. */
export function withYardOfferings(
	base: PlannerRegistry,
	yards: readonly Yard[],
): PlannerRegistry {
	const extra = createRegistryFromProviders(
		yards.map((yard) => relayYardRegistryProvider(yard)),
	);
	return {
		// A getter: a base that refreshes changes its hash.
		get catalogHash() {
			return createHash("sha256")
				.update(base.catalogHash)
				.update("\0")
				.update(extra.catalogHash)
				.digest("hex");
		},
		definitions: () => [...base.definitions(), ...extra.definitions()],
		providers: () => [...new Set([...base.providers(), ...extra.providers()])],
		...(base.refresh !== undefined
			? { refresh: () => base.refresh?.() ?? Promise.resolve() }
			: undefined),
		...(base.held !== undefined
			? { held: () => base.held?.() ?? [] }
			: undefined),
	};
}

/** The runtime `hobo cd plan|up` place the CD project with. */
export function cdPlacementRuntime<R extends YardRuntime>(runtime: R): R {
	return {
		...runtime,
		registry: withYardOfferings(runtime.registry, CD_PLACEMENT_YARDS),
	};
}

/** The providers the plan names for resources placed on those Yards. */
const PREPARED_PROVIDERS: ReadonlySet<string> = new Set(
	CD_PLACEMENT_YARDS.map((yard) => `yard:${yard.name}`),
);

/**
 * `next`, except for a resource placed on a Yard `prepare` makes (the
 * journal's fleet, the owner's config service): `prepare` created it in this
 * run, before the plan, and refused the run if it could not. Applying it
 * records that; nothing is deployed for it. Destroying it does nothing: the
 * journal holds CD's history and the store is the owner's, so `hobo cd down`
 * never drops either.
 */
export function routePreparedPlacements(next: IacProvider): IacProvider {
	const prepared = (program: IacProgram) =>
		PREPARED_PROVIDERS.has(program.provider);
	const outputs = (program: IacProgram) => ({
		provider: program.provider,
		realizedBy: "prepare",
	});
	return {
		id: next.id,
		preview: async (program) =>
			prepared(program)
				? {
						summary: `${program.resourceId} on ${program.provider}: made by hobo cd up's prepare step`,
						changes: 0,
					}
				: next.preview(program),
		apply: async (program) =>
			prepared(program) ? outputs(program) : next.apply(program),
		destroy: async (program) => {
			if (!prepared(program)) await next.destroy(program);
		},
		refresh: async (program) =>
			prepared(program)
				? { drift: false, observed: outputs(program) }
				: next.refresh(program),
	};
}
