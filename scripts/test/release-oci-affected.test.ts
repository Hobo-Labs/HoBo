import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { affectedReleaseOciImages } from "../ci/release-oci-affected.mts";
import { loadReleaseOciManifest } from "../lib/release-oci-contract.mts";

const root = join(import.meta.dirname, "..", "..");
const manifest = loadReleaseOciManifest(root);
const allIds = [
	"hobo-sdk",
	"hobo-codegen",
	"hobo-cli",
	"hobo-mcp",
	"hobo-ci-serve",
	"hobo-site",
];

function affected(...paths: string[]): string[] {
	return affectedReleaseOciImages(manifest, paths);
}

describe("affected release OCI images", () => {
	it("skips empty and unrelated diffs", () => {
		expect(affected()).toEqual([]);
		expect(affected("docs/release/pipelines.md")).toEqual([]);
	});

	it("selects an image for its Dockerfile and image directory", () => {
		expect(affected("deploy/release-images/hobo-site/Dockerfile")).toEqual([
			"hobo-site",
		]);
		expect(affected("deploy/release-images/hobo-ci-serve/README.md")).toEqual([
			"hobo-ci-serve",
		]);
	});

	it.each([
		"mise.toml",
		"mise.lock",
		"pnpm-lock.yaml",
		"package.json",
	])("selects every image when shared input %s changes", (path) => {
		expect(affected(path)).toEqual(allIds);
	});

	it.each([
		"release/oci-images.json",
		"scripts/ci/build-release-oci-image.mts",
		"scripts/ci/release-oci-affected.mts",
		"scripts/lib/release-oci-contract.mts",
	])("selects every image for release-wide input %s", (path) => {
		expect(affected(path)).toEqual(allIds);
	});

	it("keeps hobo-cli before its hobo-mcp dependent", () => {
		expect(affected("deploy/release-images/hobo-cli/Dockerfile")).toEqual([
			"hobo-cli",
			"hobo-mcp",
		]);
		expect(affected("deploy/release-images/hobo-mcp/Dockerfile")).toEqual([
			"hobo-mcp",
		]);
	});

	it("maps package and site inputs to their consuming images", () => {
		expect(affected("packages/core/src/index.ts")).toEqual([
			"hobo-sdk",
			"hobo-codegen",
			"hobo-cli",
			"hobo-mcp",
			"hobo-site",
		]);
		expect(affected("packages/ci/src/server.ts")).toEqual([
			"hobo-sdk",
			"hobo-cli",
			"hobo-mcp",
			"hobo-ci-serve",
			"hobo-site",
		]);
		expect(affected("site/src/pages/index.astro")).toEqual(["hobo-site"]);
	});

	it.each([
		"release/npm-scope-map.json",
		"scripts/ci/npm-publish-scope.mts",
		"scripts/ci/stage-sdk-artifacts.mts",
	])("selects only the SDK image for SDK staging input %s", (path) => {
		expect(affected(path)).toEqual(["hobo-sdk"]);
	});
});
