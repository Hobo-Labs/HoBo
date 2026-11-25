import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("release browser-wit runner smoke", () => {
	it("CI script preflights wit then runs site prebuild and examples:runtime", () => {
		const source = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"ci/build-release-browser-wit-on-runner.mts",
			),
			"utf8",
		);
		expect(source).toMatch(/assertReleasePagesBrowserRuntimeWit/);
		expect(source).toMatch(/releaseSitePrebuildTurboArgs/);
		expect(source).toMatch(/examples:runtime/);
	});

	it("release-hobo workflow runs browser-wit smoke on hobo runner for PRs", () => {
		const workflow = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				".github/workflows/release-hobo.yml",
			),
			"utf8",
		);
		const block = workflow.slice(
			workflow.indexOf("\n  release-pages-browser-wit-smoke:\n"),
			workflow.indexOf("\n  # The offline proof of the release realizer path"),
		);
		expect(block).toMatch(/runs-on: \$\{\{ contains\(fromJSON/);
		expect(block).toContain("'hobo'");
		expect(block).toContain("RELEASE_PAGES_MATERIALIZE_PATHS");
		expect(block).toContain("build-release-browser-wit-on-runner.mts");
		expect(block).toContain("XDG_CACHE_HOME: ${{ runner.temp }}/xdg-cache");
	});

	it("release PR gate requires browser-wit smoke on hobo runner", () => {
		const workflow = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				".github/workflows/release-hobo.yml",
			),
			"utf8",
		);
		const gate = workflow.slice(workflow.indexOf("\n  release-pr-gate:\n"));
		expect(gate).toContain("release-pages-browser-wit-smoke");
		expect(gate).toContain("Pages browser-wit build on hobo runner must pass");
	});
});
