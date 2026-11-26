import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	applyScopeToManifest,
	assertNpmScopeMapAllowlist,
	loadNpmScopeMap,
	mapPackageName,
} from "../ci/npm-publish-scope.mts";

describe("npm-publish-scope", () => {
	it("maps @hobo/pricing to @hobo-labs/pricing for publish staging", () => {
		const map = loadNpmScopeMap();
		assert.equal(map.publicScope, "@hobo-labs");
		assert.equal(mapPackageName("@hobo/pricing", map), "@hobo-labs/pricing");
		const staged = applyScopeToManifest(
			{
				name: "@hobo/pricing",
				dependencies: {},
			},
			map,
		);
		assert.equal(staged.name, "@hobo-labs/pricing");
	});

	it("names the source repository npm checks a provenance bundle against", () => {
		const map = loadNpmScopeMap();
		const staged = applyScopeToManifest({ name: "@hobo/core" }, map);
		assert.deepEqual(staged.repository, {
			type: "git",
			url: "git+https://github.com/Hobo-Labs/HoBo.git",
		});
		assert.throws(
			() =>
				assertNpmScopeMapAllowlist({
					...map,
					repository: "https://example.com/x",
				}),
			/repository must be/,
		);
	});

	it("preserves workspace import names using npm aliases", () => {
		const map = loadNpmScopeMap();
		const staged = applyScopeToManifest(
			{
				name: "@hobo/cli",
				dependencies: { "@hobo/core": "workspace:*", lodash: "^4.0.0" },
				peerDependencies: { "@hobo/policy": "workspace:*" },
			},
			map,
			{ version: "0.0.0-alpha.1" },
		);
		assert.equal(
			staged.dependencies?.["@hobo/core"],
			"npm:@hobo-labs/core@0.0.0-alpha.1",
		);
		assert.equal(staged.dependencies?.lodash, "^4.0.0");
		assert.equal(
			staged.peerDependencies?.["@hobo/policy"],
			"npm:@hobo-labs/policy@0.0.0-alpha.1",
		);
	});

	it("rejects unmapped workspace runtime dependencies", () => {
		const map = loadNpmScopeMap();
		for (const section of [
			"dependencies",
			"peerDependencies",
			"optionalDependencies",
		] as const) {
			assert.throws(
				() =>
					applyScopeToManifest(
						{ name: "@hobo/cli", [section]: { "@hobo/cloud": "workspace:*" } },
						map,
						{ version: "0.0.0-alpha.1" },
					),
				/runtime workspace dependency @hobo\/cloud has no public package mapping/,
			);
		}
	});
});
