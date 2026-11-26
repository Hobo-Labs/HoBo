/**
 * The authoring path this experience proof measures: write the Bindle with
 * provider-neutral kinds, serialize it the way the control plane receives it,
 * then cross src/parse.ts once to get a refined plan.
 *
 * The JSON round-trip is not ceremony — a manifest reaching Matching has been
 * serialized, so parsing the serialized form is what the real DX does.
 */
import { bindle } from "@hobo/bindles";
import { convexApp } from "@hobo/convex";

import {
	assertAuthoringTransition,
	parseSwaghausBindle,
	type SwaghausBindlePlan,
} from "./parse.ts";
import { type JsonObject } from "./json.js";


export type AuthorInput = {
	/** Repo-relative Convex app directory handed to `convexApp(root)`. */
	readonly root: string;
	/** When given, the plan is also checked against the real containment guard. */
	readonly repoRoot?: string;
	/** WorkOS AuthKit endpoint for the `b.external()` dependency. */
	readonly workosEndpoint?: string;
};

/** The serialized manifest graph the control plane actually receives. */
export type BindleManifest = {
	readonly name: string;
	readonly resources: JsonObject;
	readonly edges: readonly unknown[];
};

export const DEFAULT_WORKOS_ENDPOINT = "https://api.workos.com";

/**
 * Author the swaghaus Bindle: a `b.data()` Convex backend, a `b.external()`
 * WorkOS AuthKit dependency, and one `b.web(convexApp(root))` Kit that depends
 * on both. No provider is named anywhere — Matching picks the Yard.
 */
export function draftSwaghausManifest(input: AuthorInput): BindleManifest {
	const definition = bindle((b) => {
		const backend = b.data();
		const auth = b.external({
			endpoints: { workos: input.workosEndpoint ?? DEFAULT_WORKOS_ENDPOINT },
		});
		const web = b.web(convexApp(input.root)).dependsOn(backend, auth);
		return { backend, auth, web };
	});

	// SAFETY: `return JSON.parse(` is required at this I/O or test boundary.
	return JSON.parse(
		JSON.stringify({
			name: definition.name,
			resources: definition.resources,
			edges: definition.edges,
		}),
	) as BindleManifest;
}

/**
 * Draft → parse in one step, walking #AuthoringTransitions. Refusals surface
 * as `BindleAuthoringParseError` from the parser, never as a partial plan.
 */
export function authorSwaghausBindle(input: AuthorInput): {
	readonly manifest: BindleManifest;
	readonly plan: SwaghausBindlePlan;
} {
	const manifest = draftSwaghausManifest(input);
	assertAuthoringTransition("drafted", "parsed");
	const plan = parseSwaghausBindle(
		manifest,
		input.repoRoot === undefined ? {} : { repoRoot: input.repoRoot },
	);
	return Object.freeze({ manifest, plan });
}
