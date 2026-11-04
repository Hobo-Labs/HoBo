import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	applyScopeToManifest,
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
});
