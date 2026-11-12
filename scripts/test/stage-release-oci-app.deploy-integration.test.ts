import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	installSdkTarballsIntoApp,
	nodeModulesPathForPackageName,
	releaseOciDeployArgs,
	releasePnpmStore,
} from "../ci/stage-release-oci-app.mts";
import { stageSdkArtifactsDir } from "../ci/stage-sdk-artifacts.mts";

const root = join(import.meta.dirname, "..", "..");

function runQuiet(cwd: string, command: string, args: readonly string[]): void {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	expect(
		result.status,
		`${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`,
	).toBe(0);
}

/** Full pnpm deploy of @hobo/hobo — too slow for release contract (17m+ on box runners). */
describe("release OCI SDK deploy integration", () => {
	it("overlays SDK tarballs into a pnpm-deploy app without npm install", () => {
		const previousSemver = process.env.HOBO_RELEASE_SEMVER;
		const fixtureRoot = mkdtempSync(join(tmpdir(), "hobo-sdk-overlay-"));
		const appDir = join(fixtureRoot, "app");
		const artifactsDir = join(fixtureRoot, "artifacts");
		try {
			process.env.HOBO_RELEASE_SEMVER = "0.0.0-pr.test";
			mkdirSync(appDir, { recursive: true });
			runQuiet(
				root,
				"pnpm",
				releaseOciDeployArgs("@hobo/hobo", appDir, releasePnpmStore(root)),
			);
			stageSdkArtifactsDir(artifactsDir);
			installSdkTarballsIntoApp(appDir, artifactsDir);
			const cliPath = nodeModulesPathForPackageName(appDir, "@hobo-labs/cli");
			expect(readFileSync(join(cliPath, "package.json"), "utf8")).toMatch(
				/"name"\s*:\s*"@hobo-labs\/cli"/,
			);
			const probe = spawnSync(
				"node",
				[
					"--input-type=module",
					"-e",
					"import('@hobo-labs/core').then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); })",
				],
				{ cwd: appDir, encoding: "utf8" },
			);
			expect(probe.status, probe.stderr || probe.stdout).toBe(0);
		} finally {
			if (previousSemver === undefined) delete process.env.HOBO_RELEASE_SEMVER;
			else process.env.HOBO_RELEASE_SEMVER = previousSemver;
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	}, 360_000);
});
