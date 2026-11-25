import assert from "node:assert/strict";
import { test } from "node:test";
import { proofManifestSchema } from "../lib/proof-manifest.ts";

test("proof manifests accept Linear design records alongside repository paths", () => {
	const references = {
		technicalProofs: ["src/draft/technical-proofs/example"],
		designDocs: [
			"docs/design/example.md",
			"https://linear.app/example/document/proof",
		],
	};
	const manifest = proofManifestSchema.parse({
		layer: "technical",
		slug: "example",
		title: "Example",
		references,
	});
	assert.deepEqual(manifest.references.designDocs, references.designDocs);
	assert.deepEqual(
		manifest.references.technicalProofs,
		references.technicalProofs,
	);
	assert.equal(
		proofManifestSchema.safeParse({
			layer: "technical",
			slug: "example",
			title: "Example",
			references: { technicalProofs: ["/outside"] },
		}).success,
		false,
	);
});
