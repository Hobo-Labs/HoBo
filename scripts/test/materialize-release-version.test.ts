import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	releaseMaterializedEnvLines,
	shouldTrustGateReleaseVersion,
} from "../ci/materialize-release-version.mts";
import { parseReleaseRef } from "../lib/release-version.mts";

describe("shouldTrustGateReleaseVersion", () => {
	it("trusts main-train gate ref under nbgv mode (skip shallow height recompute)", () => {
		expect(
			shouldTrustGateReleaseVersion({
				HOBO_RELEASE_VERSION_MODE: "nbgv",
				HOBO_RELEASE_VERSION: "v0.0.0-alpha.8",
			}),
		).toBe(true);
	});

	it("does not trust nbgv mode without a parsed full-train ref", () => {
		expect(
			shouldTrustGateReleaseVersion({
				HOBO_RELEASE_VERSION_MODE: "nbgv",
				HOBO_RELEASE_VERSION: "",
			}),
		).toBe(false);
		expect(
			shouldTrustGateReleaseVersion({
				HOBO_RELEASE_VERSION_MODE: "nbgv",
				HOBO_RELEASE_VERSION: "sdk-v0.0.0-alpha.1",
			}),
		).toBe(false);
	});

	it("does not trust tag-ref mode (resolve path, no git height)", () => {
		expect(
			shouldTrustGateReleaseVersion({
				HOBO_RELEASE_VERSION_MODE: "tag-ref",
				HOBO_RELEASE_VERSION: "v0.0.0-alpha.8",
			}),
		).toBe(false);
	});
});

describe("releaseMaterializedEnvLines", () => {
	it("matches compute-release-version HOBO_RELEASE_* shape", () => {
		const parsed = parseReleaseRef("v0.0.0-alpha.8");
		expect(releaseMaterializedEnvLines(parsed)).toEqual([
			"HOBO_RELEASE_VERSION=v0.0.0-alpha.8",
			"HOBO_RELEASE_SEMVER=0.0.0-alpha.8",
			"HOBO_RELEASE_NPM_DIST_TAG=alpha",
			"HOBO_RELEASE_GHCR_TAG=v0.0.0-alpha.8",
			"HOBO_RELEASE_TRAIN=full",
		]);
	});
});

describe("materialize-release-version (gate trust integration)", () => {
	it("writes HOBO_RELEASE_* from gate ref without spawning compute-release-version", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-materialize-"));
		const githubEnv = join(dir, "github.env");
		try {
			writeFileSync(githubEnv, "");
			const { spawnSync } = await import("node:child_process");
			const result = spawnSync(
				"node",
				["--no-warnings", "scripts/ci/materialize-release-version.mts"],
				{
					cwd: join(import.meta.dirname, "..", ".."),
					env: {
						...process.env,
						GITHUB_ENV: githubEnv,
						HOBO_RELEASE_VERSION_MODE: "nbgv",
						HOBO_RELEASE_VERSION: "v0.0.0-alpha.8",
						HOBO_RELEASE_CHECKOUT_REF: "deadbeef",
					},
					encoding: "utf8",
				},
			);
			expect(result.status, result.stderr).toBe(0);
			const written = readFileSync(githubEnv, "utf8");
			expect(written).toContain("HOBO_RELEASE_VERSION=v0.0.0-alpha.8");
			expect(written).toContain("HOBO_RELEASE_SEMVER=0.0.0-alpha.8");
			expect(written).not.toContain("compute-release-version");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
