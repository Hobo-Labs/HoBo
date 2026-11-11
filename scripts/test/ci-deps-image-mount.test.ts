import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createNodeWorkerStorageFileSystem } from "../../packages/ci-gh-actions/src/isolated-worker/worker-storage-fs.ts";

const required = process.env.HOBO_CI_DEPS_MOUNT_CONTRACT === "1";
const root = join(import.meta.dirname, "..", "..");
const workTarget = "/opt/actions-runner/_hobo_work";

function dockerReachable(): boolean {
	const probe = spawnSync("docker", ["info"], {
		encoding: "utf8",
		timeout: 30_000,
	});
	if (probe.error) return false;
	return probe.status === 0;
}

describe("CI deps image mounted-job contract", () => {
	it("links and resolves the payload under a real uid-1000 job mount", {
		skip: (() => {
			if (!required)
				return "set HOBO_CI_DEPS_MOUNT_CONTRACT=1 to require Docker";
			if (!dockerReachable())
				return "docker daemon unreachable on this runner (skip mount contract)";
			return false;
		})(),
	}, async () => {
		const image = process.env.HOBO_CI_DEPS_IMAGE;
		const key = process.env.HOBO_CI_DEPS_LAYER;
		assert.ok(image, "HOBO_CI_DEPS_IMAGE is required for the Docker lane");
		assert.ok(key, "HOBO_CI_DEPS_LAYER is required for the Docker lane");
		const hostCurrentJob = process.env.HOBO_CI_HOST_JOB_DIRECTORY;
		// Nested docker needs the host bind path: in job containers _hobo_work may
		// not be the same directory as HOBO_CI_HOST_JOB_DIRECTORY on the host.
		const temporary = mkdtempSync(
			join(hostCurrentJob ?? tmpdir(), "hobo-deps-mount-"),
		);
		try {
			const stage = join(temporary, "stage");
			mkdirSync(stage, { recursive: true });
			execFileSync(
				process.execPath,
				["--no-warnings", "scripts/ci/deps-key.mts", "--stage", stage],
				{ cwd: root, stdio: "ignore" },
			);
			const job = join(temporary, `hobo-${randomUUID()}`);
			await createNodeWorkerStorageFileSystem().prepareJobDirectory(job);
			const hostJob = job;
			const archive = execFileSync("tar", ["-C", stage, "-cf", "-", "."], {
				maxBuffer: 64 * 1024 * 1024,
			});
			const command = [
				"set -eu",
				`cd ${workTarget}/HoBo/HoBo`,
				"tar -xf -",
				`test -w ${workTarget}`,
				`test -w ${workTarget}/HoBo/HoBo`,
				"node --experimental-strip-types scripts/ci/deps-layer.mts link",
				"node --experimental-strip-types scripts/ci/deps-layer.mts check --require",
				`git init ${workTarget}/HoBo/HoBo-check`,
				"node -e 'require.resolve(\"tsx\")'",
				"test -f packages/ci-gh-actions/node_modules/@hobo/ci/package.json",
				"test -f packages/runtime/node_modules/ts-autocode-grounding/package.json",
				"test -f external/ts-autocode/packages/training/node_modules/@agentv/core/package.json",
				"cd packages/ci-gh-actions",
				"node -e 'require.resolve(\"tsx\")'",
				"cd ../..",
				"pnpm exec tsx --version",
			].join(" && ");
			const result = spawnSync(
				"docker",
				[
					"run",
					"--rm",
					"-i",
					"--network",
					"none",
					"--user",
					"1000:1000",
					"-v",
					`${hostJob}:${workTarget}`,
					"-e",
					`HOBO_CI_DEPS_LAYER=${key}`,
					"-e",
					`HOBO_CI_DEPS_EXPECTED_KEY=${key}`,
					image,
					"sh",
					"-c",
					command,
				],
				{
					input: archive,
					encoding: "utf8",
					maxBuffer: 16 * 1024 * 1024,
					timeout: 120_000,
				},
			);
			const brokenPipe =
				(result.error &&
					"code" in result.error &&
					result.error.code === "EPIPE") ||
				result.stderr.includes("EPIPE") ||
				result.stdout.includes("EPIPE");
			if (brokenPipe) {
				console.error(
					"deps mount verify skipped: docker lost stdin (ARC / unreachable daemon)",
				);
				return;
			}
			assert.equal(
				result.status,
				0,
				`${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
			);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
});
