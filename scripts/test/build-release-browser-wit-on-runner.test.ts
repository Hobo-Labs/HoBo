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
		expect(source).toMatch(/exitSpawnFailClosed/);
		expect(source).toMatch(/purgeColdComponentizeState/);
		expect(source).toMatch(/assertComponentizeProof/);
		expect(source).toMatch(/HOBO_BROWSER_WIT_FORCE_COMPONENTIZE/);
		expect(source).not.toMatch(/build\.status \?\? 0/);
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
		expect(block.slice(0, block.indexOf("    env:"))).toContain(
			"timeout-minutes: 45",
		);
		expect(block).toContain("RELEASE_PAGES_MATERIALIZE_PATHS");
		expect(block).toContain("build-release-browser-wit-on-runner.mts");
		const layer = block.indexOf("Link Pages deps layer");
		const decompression = block.indexOf("Prepare cache decompression");
		const store = block.indexOf("Restore pnpm store when available");
		const install = block.indexOf("Install Pages dependencies");
		const cacheRestore = block.indexOf("uses: $/.github/actions/turbo-cache");
		const componentize = block.indexOf("Componentize browser WIT runtime");
		expect(layer).toBeGreaterThan(0);
		expect(decompression).toBeGreaterThan(layer);
		expect(store).toBeGreaterThan(decompression);
		expect(install).toBeGreaterThan(store);
		expect(cacheRestore).toBeGreaterThan(install);
		expect(cacheRestore).toBeLessThan(componentize);
		expect(block.slice(store, install)).toContain("timeout-minutes: 5");
		expect(block.slice(store, install)).toContain("continue-on-error: true");
		expect(block.slice(store, install)).toContain(
			'cold-self-hosted-cache: "true"',
		);
		expect(block.slice(store, cacheRestore)).toContain(
			"steps.pages-deps-layer.outputs.match != 'true'",
		);
		expect(block.slice(cacheRestore, componentize)).toContain(
			'main-build: "true"',
		);
		for (const required of [
			"hobo-site...",
			"hobo-design",
			"ts-autocode-training...",
			"@hobo/example-try-site...",
			"@hobo/runtime-wasm...",
		])
			expect(block).toContain(required);
		expect(block).not.toContain("XDG_CACHE_HOME");
		const recoveryUse = block.indexOf(
			"uses: $/.github/actions/ci-deps-recovery",
		);
		expect(recoveryUse).toBeGreaterThan(0);
		expect(recoveryUse).toBeLessThan(layer);
		const recoveryStep = block.slice(recoveryUse, layer);
		expect(recoveryStep).toContain("continue-on-error: true");
		expect(recoveryStep).toContain("token: ${{ secrets.GITHUB_TOKEN }}");
		expect(recoveryStep).not.toContain("env.GITHUB_TOKEN");
		expect(block).toMatch(/packages: read/);
		const recovery = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				".github/actions/ci-deps-recovery/action.yml",
			),
			"utf8",
		);
		expect(recovery).toMatch(/materialize-ghcr-deps-layer\.mts/);
		expect(recovery).toMatch(/GITHUB_TOKEN: \$\{\{ inputs\.token \}\}/);
		expect(recovery).not.toMatch(/\$\{\{ env\.GITHUB_TOKEN \}\}/);
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
