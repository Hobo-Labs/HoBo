import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverProduct } from "../lib/repo-discover.mts";

const trustedScript = "node --import tsx scripts/check-visual-tokens.mts";

function visualFixture(designLint?: string, withContract = false): string {
	const root = mkdtempSync(path.join(tmpdir(), "hobo-visual-discovery-"));
	mkdirSync(path.join(root, "site/src/styles"), { recursive: true });
	writeFileSync(path.join(root, "README.md"), "# Fixture\n\nA site.\n");
	writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({
			scripts: designLint === undefined ? {} : { "design:lint": designLint },
		}),
	);
	writeFileSync(
		path.join(root, "site/src/styles/global.css"),
		":root { --ink: #101010; }\n",
	);
	if (withContract) {
		mkdirSync(path.join(root, "scripts"), { recursive: true });
		writeFileSync(path.join(root, "scripts/visual-token-contract.json"), "{}\n");
	}
	return root;
}

test("discovers UI review only from the trusted checker and its contract", () => {
	const root = visualFixture(trustedScript, true);
	try {
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

for (const fixture of [
	{ name: "no design:lint script", script: undefined, contract: false },
	{ name: "an arbitrary design:lint script", script: "check", contract: true },
	{ name: "the trusted script without its contract", script: trustedScript, contract: false },
])
	test(`reports ${fixture.name} as unresolved without executing it`, () => {
		const root = visualFixture(fixture.script, fixture.contract);
		try {
			const discovery = discoverProduct(root);
			assert.equal(discovery.featurePlans.some((feature) => feature.id === "design-system-contract"), false);
			const unresolved = discovery.featurePlans.find((feature) => feature.id === "design-system-contract-unresolved");
			assert.ok(unresolved);
			assert.deepEqual(unresolved.surfaces, []);
			assert.match(unresolved.seed, /not an executed check/u);
			assert.ok(discovery.notes.some((note) => /Unresolved visual check:.*design:lint/u.test(note)));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
