import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { depsBuildDockerReserve } from "../../packages/ci-gh-actions/src/isolated-worker/deps-build-budget.js";

describe("deps build headroom defaults", () => {
	it("matches depsBuildDockerReserve for build-deps.sh", () => {
		const reserve = depsBuildDockerReserve();
		const root = process.cwd();
		const run = spawnSync(
			"node",
			[
				"--experimental-strip-types",
				"--no-warnings",
				"--import",
				join(root, "scripts/lib/ts-source-resolve.mts"),
				join(root, "scripts/ci/deps-build-headroom-defaults.mts"),
			],
			{ cwd: root, encoding: "utf8" },
		);
		expect(run.status).toBe(0);
		const [inodes, bytes] = run.stdout.trim().split(/\s+/u);
		expect(Number(inodes)).toBe(reserve.dockerDataRoot);
		expect(Number(bytes)).toBe(reserve.dockerDataRootBytes);
	});
});
