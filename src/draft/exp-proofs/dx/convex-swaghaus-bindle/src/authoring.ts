import { bindle } from "@hobo/bindles";
import { convexApp } from "@hobo/convex";

import {
	assertAuthoringTransition,
	parseSwaghausBindle,
	type SwaghausBindlePlan,
} from "./parse.ts";
import { type JsonObject } from "./json.js";

export type AuthorInput = {
	readonly root: string;
	readonly repoRoot?: string;
	readonly workosEndpoint?: string;
};

export type BindleManifest = {
	readonly name: string;
	readonly resources: JsonObject;
	readonly edges: readonly unknown[];
};

export const DEFAULT_WORKOS_ENDPOINT = "https://api.workos.com";

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
