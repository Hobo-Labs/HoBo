/**
 * Every case here is a line in `manifest.cases.jsonl`.
 *
 * The fixture is patched by a plain object rather than a mutator function, and
 * the rule is deliberately one rule: **top-level keys are replaced**. A deep
 * merge would read more nicely for `provenance` and much worse for `probes`,
 * where the replacement probe is a different `kind` and merging would leave the
 * old `argv` behind — so a case would be rejected for a reason it was not
 * written to test.
 */

import { describeConcern } from "@hobo/contract-harness";
import {
	canonicalJson,
	type PackManifestInput,
	parseImageDigest,
	parsePackId,
	parsePackManifest,
	parsePinnedImageRef,
} from "../src/index.js";
import { fixtureManifest } from "./harness.js";

type Patch = Partial<Omit<PackManifestInput, "signature">>;

const manifest = (patch: Patch = {}) =>
	parsePackManifest(fixtureManifest((draft) => ({ ...draft, ...patch })));

describeConcern("pack manifest", {
	cases: `${import.meta.dirname}/manifest.cases.jsonl`,
	subject: () => ({
		parsePinnedImageRef,
		parseImageDigest,
		parsePackId,
		canonicalJson,
		parseFixtureManifest: (patch?: Patch) => manifest(patch),
		/**
		 * Canonical ordering, as a value rather than as a comparison.
		 *
		 * The suite this replaced asserted `order(a) === order(b)` for two
		 * authoring orders, which holds just as well if the parser leaves both
		 * untouched. Naming the expected order proves the sort actually happened.
		 */
		fixtureImageOrder: (patch?: Patch) =>
			manifest(patch).images.map((image) => image.architecture),
		fixtureConfigOrder: (patch?: Patch) =>
			manifest(patch).configSchema.map((field) => field.key),
	}),
});
