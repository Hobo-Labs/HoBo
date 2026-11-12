import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RELEASE_SITE_PREBUILD_FILTER,
	releaseSitePrebuildTurboArgs,
} from "../ci/build-release-site-prebuild.mts";

describe("release site prebuild turbo args", () => {
	it("builds the whole hobo-site workspace closure", () => {
		expect(releaseSitePrebuildTurboArgs()).toEqual([
			"exec",
			"turbo",
			"run",
			"build",
			`--filter=${RELEASE_SITE_PREBUILD_FILTER}`,
		]);
	});

	// Finding 125: the affected form failed with "no merge base found" once
	// main had moved past the commit under release.
	it("never narrows the build to what changed since a base", () => {
		const source = readFileSync(
			join(import.meta.dirname, "..", "ci/build-release-site-prebuild.mts"),
			"utf8",
		);
		expect(source).not.toMatch(/HOBO_RELEASE_TURBO_BASE|\.\.\.HEAD\]/u);
		const workflow = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				".github/workflows/release-hobo.yml",
			),
			"utf8",
		);
		const pages = workflow.slice(
			workflow.indexOf("\n  release-pages:\n"),
			workflow.indexOf("\n  release-tag:\n"),
		);
		expect(pages).toContain('HOBO_RELEASE_TURBO_BASE: ""');
	});
});
