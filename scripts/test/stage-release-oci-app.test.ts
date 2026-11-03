import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RELEASE_OCI_STAGE_SPECS,
	releaseOciDockerignore,
	stageReleaseOciApp,
} from "../ci/stage-release-oci-app.mts";
import { SDK_PACKAGES } from "../ci/stage-sdk-artifacts.mts";
import { loadReleaseOciManifest } from "../lib/release-oci-contract.mts";

const root = join(import.meta.dirname, "..", "..");

describe("release OCI app staging", () => {
	it("covers exactly the image ids in the release manifest", () => {
		const manifest = loadReleaseOciManifest(root);
		expect(Object.keys(RELEASE_OCI_STAGE_SPECS).sort()).toEqual(
			manifest.images.map((image) => image.id).sort(),
		);
	});

	it.each([
		["hobo-cli", "@hobo/hobo", "@hobo/hobo..."],
		["hobo-code", "@hobo/code", "@hobo/code..."],
		["hobo-codegen", "@hobo/schema-tools", "@hobo/schema-tools..."],
		["hobo-ci-serve", "@hobo/ci-gh-actions", "@hobo/ci-gh-actions"],
	])("stages %s as a deployed app", (imageId, packageName, buildFilter) => {
		expect(
			Object.entries(RELEASE_OCI_STAGE_SPECS).find(
				([id]) => id === imageId,
			)?.[1],
		).toMatchObject({
			kind: "deploy",
			packageName,
			buildFilter,
			appPath: "app",
		});
	});

	it("stages executable wrappers for package entrypoints", () => {
		expect(RELEASE_OCI_STAGE_SPECS["hobo-cli"]).toMatchObject({
			wrappers: [
				{ name: "hobo", entrypoint: "dist/bin/hobo.js" },
				{ name: "hobo-mcp", entrypoint: "dist/bin/hobo-mcp.js" },
			],
		});
		expect(RELEASE_OCI_STAGE_SPECS["hobo-code"]).toMatchObject({
			wrappers: [{ name: "hobo-code", entrypoint: "dist/bin/hobo-code.js" }],
		});
		expect(RELEASE_OCI_STAGE_SPECS["hobo-codegen"]).toMatchObject({
			wrappers: [{ name: "hobo-codegen", entrypoint: "dist/cli.js" }],
		});
	});

	it("stages SDK tarballs, site output, and the MCP dependency marker", () => {
		expect(RELEASE_OCI_STAGE_SPECS["hobo-sdk"]).toEqual({
			kind: "sdk",
			artifactsPath: "artifacts",
		});
		expect(RELEASE_OCI_STAGE_SPECS["hobo-site"]).toEqual({
			kind: "site",
			distPath: "dist",
			serverPath: "server.mjs",
		});
		expect(RELEASE_OCI_STAGE_SPECS["hobo-mcp"]).toEqual({
			kind: "mcp",
			markerPath: ".hobo-cli-candidate",
		});
	});

	it("allowlists only staged artifacts in each docker context", () => {
		expect(releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-cli"])).toBe(
			"*\n!.dockerignore\n!app/\n!app/**\n!app/bin/\n!app/bin/**\n",
		);
		expect(releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-sdk"])).toBe(
			"*\n!.dockerignore\n!artifacts/\n!artifacts/**\n",
		);
		expect(releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-site"])).toBe(
			"*\n!.dockerignore\n!dist/\n!dist/**\n!server.mjs\n",
		);
		expect(releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-mcp"])).toBe(
			"*\n!.dockerignore\n!.hobo-cli-candidate\n",
		);
	});

	it("writes .dockerignore into the staged context", () => {
		const stagingRoot = mkdtempSync(join(tmpdir(), "hobo-release-stage-"));
		try {
			stageReleaseOciApp("hobo-mcp", stagingRoot, { root });
			expect(readFileSync(join(stagingRoot, ".dockerignore"), "utf8")).toBe(
				releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-mcp"]),
			);
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	});

	it("builds every allowlisted SDK package", () => {
		expect(SDK_PACKAGES).toEqual([
			"@hobo/core",
			"@hobo/bindles",
			"@hobo/contracts",
			"@hobo/contract-harness",
			"@hobo/runtime",
			"@hobo/runtime-local",
			"@hobo/storage-sqlite",
			"@hobo/wit",
			"@hobo/cli",
		]);
	});
});
