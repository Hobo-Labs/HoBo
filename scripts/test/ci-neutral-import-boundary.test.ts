import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildCiNeutralImportAllowlist,
	crossPackageFolderFromRelativeImport,
	hostLayerEscapeSpecifier,
	neutralCiCrossPackageImportViolation,
} from "../lib/ci-neutral-import-boundary.mts";

const repoRoot = join(import.meta.dirname, "../..");
const packagesDir = join(repoRoot, "packages");

describe("ci-neutral-import-boundary", () => {
	it("builds a transitive workspace closure for @hobo/ci without ci-gh-actions", () => {
		const allow = buildCiNeutralImportAllowlist(repoRoot);
		assert.ok(allow.has("@hobo/ci"));
		assert.ok(allow.has("@hobo/core"));
		assert.ok(allow.has("@hobo/storage-sqlite"));
		assert.equal(allow.has("@hobo/ci-gh-actions"), false);
	});

	it("resolves cross-package folders from relative specifiers", () => {
		const from = join(packagesDir, "ci/src/domain/foo.ts");
		assert.equal(
			crossPackageFolderFromRelativeImport(
				from,
				"../../../broker/src/index.js",
				packagesDir,
			),
			"broker",
		);
		assert.equal(
			crossPackageFolderFromRelativeImport(
				from,
				"../cluster/bar.js",
				packagesDir,
			),
			null,
		);
	});

	it("rejects closure and escape violations for neutral ci imports", () => {
		const allow = buildCiNeutralImportAllowlist(repoRoot);
		const from = join(packagesDir, "ci/src/domain/foo.ts");
		assert.equal(
			neutralCiCrossPackageImportViolation(
				from,
				"../../../broker/src/index.js",
				repoRoot,
				allow,
			),
			null,
		);
		assert.match(
			neutralCiCrossPackageImportViolation(
				from,
				"../../../hobo/src/index.js",
				repoRoot,
				allow,
			) ?? "",
			/outside the @hobo\/ci dependency closure/u,
		);
		assert.match(
			neutralCiCrossPackageImportViolation(
				from,
				"../../ci-gh-actions/src/index.js",
				repoRoot,
				allow,
			) ?? "",
			/forbidden host or ci-gh-actions escape/u,
		);
		assert.equal(hostLayerEscapeSpecifier("../domain/ids.js"), false);
	});
});
