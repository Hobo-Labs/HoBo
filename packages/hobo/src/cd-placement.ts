import { createHash } from "node:crypto";

import type { YardRuntime } from "@hobo/cli";
import {
	createInProcessExecutor,
	createRegistryFromProviders,
	type Executor,
	type IacProgram,
	type IacProvider,
	type PlannerRegistry,
} from "@hobo/cloud";
import { CD_PLACEMENT_YARDS, cdConfigYard, cdJournalYard } from "@hobo/hobo-cd";
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

/** The specific resources the prepare step makes on its reserved Yards. */
const PREPARED_RESOURCES: ReadonlyMap<string, string> = new Map([
	[`yard:${cdJournalYard.name}`, "cd-journal"],
	[`yard:${cdConfigYard.name}`, "cd-config"],
]);

/**
 * `next`, except for a resource placed on a Yard `prepare` makes (the
 * journal's fleet, the owner's config service): `prepare` created it in this
 * run, before the plan, and refused the run if it could not. Applying it
 * records that; nothing is deployed for it. Destroying it does nothing: the
 * journal holds CD's history and the store is the owner's, so `hobo cd down`
 * never drops either.
 */
export function routePreparedPlacements(next: IacProvider): IacProvider {
	const prepared = (program: IacProgram) => {
		const resource = PREPARED_RESOURCES.get(program.provider);
		if (resource === undefined) return false;
		if (program.resourceId !== resource)
			throw new Error(
				`${program.resourceId} was not prepared for ${program.provider}`,
			);
		return true;
	};
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

/** Keep prepared resources out of the generic teardown provider. */
export function retainPreparedOnDown(next: Executor): Executor {
	const unexpected = async () => {
		throw new Error("resource was not prepared by hobo cd up");
	};
	const retained = createInProcessExecutor({
		iac: routePreparedPlacements({
			id: "cd-prepared-retention",
			preview: unexpected,
			apply: unexpected,
			destroy: unexpected,
			refresh: unexpected,
		}),
	});
	return {
		run: (program, credential, options) =>
			program.action === "destroy" && PREPARED_RESOURCES.has(program.provider)
				? retained.run(program, credential, options)
				: next.run(program, credential, options),
	};
}
