import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "../ci/ensure-ci-worker-image.mts");

describe("ensure-ci-worker-image", () => {
	it("refuses build.sh when published worker is required", () => {
		const result = spawnSync(process.execPath, ["--no-warnings", script], {
			encoding: "utf8",
			env: {
				...process.env,
				HOBO_CI_REQUIRE_PUBLISHED_WORKER: "1",
				HOBO_CI_SKIP_GHCR_PULL: "1",
				GITHUB_REPOSITORY: "hobo-labs/hobo",
			},
		});
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(
			/refusing local build\.sh/u,
		);
	});
});
