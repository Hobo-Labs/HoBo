import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverProduct } from "../lib/repo-discover.mts";

test("discovers UI review from implemented tokens without a design document", () => {
	const root = mkdtempSync(path.join(tmpdir(), "hobo-visual-discovery-"));
	try {
		mkdirSync(path.join(root, "site/src/styles"), { recursive: true });
		writeFileSync(path.join(root, "README.md"), "# Fixture\n\nA site.\n");
		writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "design:lint": "check" } }));
		writeFileSync(path.join(root, "site/src/styles/global.css"), ":root { --ink: #101010; }\n");
		const discovery = discoverProduct(root);
		assert.equal(discovery.signals.hasVisualTokens, true);
		assert.ok(discovery.personaPlans.some((persona) => persona.id === "product-designer"));
		const feature = discovery.featurePlans.find((candidate) => candidate.id === "design-system-contract");
		assert.ok(feature);
		assert.deepEqual(feature.surfaces, ["pnpm run design:lint"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
