
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
		fixtureImageOrder: (patch?: Patch) =>
			manifest(patch).images.map((image) => image.architecture),
		fixtureConfigOrder: (patch?: Patch) =>
			manifest(patch).configSchema.map((field) => field.key),
	}),
});
