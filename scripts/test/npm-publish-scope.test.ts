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

	it("pins mapped workspace deps to the release semver for npm pack", () => {
		const map = loadNpmScopeMap();
		const staged = applyScopeToManifest(
			{
				name: "@hobo/cli",
				dependencies: {
					"@hobo/core": "workspace:*",
					"@hobo/cloud": "workspace:*",
				},
			},
			map,
			{ version: "0.0.0-alpha.1" },
		);
		assert.equal(staged.dependencies?.["@hobo-labs/core"], "0.0.0-alpha.1");
		assert.equal(staged.dependencies?.["@hobo/cloud"], undefined);
	});

	it("retains explicitly pinned external workspace runtime dependencies", () => {
		const map = loadNpmScopeMap();
		const manifest = {
			name: "@hobo/runtime",
			dependencies: {
				"@hobo/core": "workspace:*",
				"ts-autocode-grounding": "workspace:*",
			},
		};
		const options = {
			version: "0.0.0-alpha.1",
			externalWorkspaceVersions: { "ts-autocode-grounding": "0.1.0" },
		};
		const staged = applyScopeToManifest(manifest, map, options);
		assert.deepEqual(staged.dependencies, {
			"@hobo-labs/core": "0.0.0-alpha.1",
			"ts-autocode-grounding": "0.1.0",
		});
		assert.throws(
			() =>
				applyScopeToManifest(manifest, map, {
					...options,
					externalWorkspaceVersions: { "ts-autocode-grounding": "workspace:*" },
				}),
			/invalid external workspace version/,
		);
		for (const version of [
			"01.1.0",
			"1.2.3-01",
			"1.2.3-..",
			"1.2.3+",
			`1.2.3-${"a".repeat(128)}`,
		]) {
			assert.throws(
				() =>
					applyScopeToManifest(manifest, map, {
						...options,
						externalWorkspaceVersions: { "ts-autocode-grounding": version },
					}),
				/invalid external workspace version/,
			);
		}
		const prerelease = applyScopeToManifest(manifest, map, {
			...options,
			externalWorkspaceVersions: {
				"ts-autocode-grounding": "0.1.0-beta.1+build.5",
			},
		});
		assert.equal(
			prerelease.dependencies?.["ts-autocode-grounding"],
			"0.1.0-beta.1+build.5",
		);
	});
});
