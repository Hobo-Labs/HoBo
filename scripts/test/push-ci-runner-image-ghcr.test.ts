import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	materializeWorkerImageVersionTag,
	pushCiRunnerImageGhcr,
} from "../ci/push-ci-runner-image-ghcr.mts";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const workflow = readFileSync(
	join(root, ".github/workflows/hobo-ci.yml"),
	"utf8",
);

describe("push-ci-runner-image-ghcr", () => {
	it("workflow delegates optional push to push-ci-runner-image-ghcr.mts", () => {
		const step = workflow.indexOf("Push runner image to GHCR (optional)");
		assert.ok(step > -1);
		const block = workflow.slice(step, step + 600);
		assert.match(block, /push-ci-runner-image-ghcr\.mts/u);
		assert.doesNotMatch(block, /docker tag "hobo-ci-worker:\$\{version\}"/u);
	});

	it("materializeWorkerImageVersionTag retags :local when the version tag is missing", () => {
		let tagged = "";
		assert.equal(
			materializeWorkerImageVersionTag("vdeadbeefcafe", {
				inspect: (ref) => ref === "hobo-ci-worker:local",
				tagLocalToVersion: (candidate) => {
					tagged = candidate;
					return 0;
				},
			}),
			true,
		);
		assert.equal(tagged, "hobo-ci-worker:vdeadbeefcafe");
	});

	it("skips push cleanly without a GHCR token", () => {
		const priorToken = process.env.GITHUB_TOKEN;
		const priorGhcr = process.env.GHCR_TOKEN;
		delete process.env.GITHUB_TOKEN;
		delete process.env.GHCR_TOKEN;
		try {
			assert.equal(pushCiRunnerImageGhcr(), 0);
		} finally {
			if (priorToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = priorToken;
			if (priorGhcr === undefined) delete process.env.GHCR_TOKEN;
			else process.env.GHCR_TOKEN = priorGhcr;
		}
		const script = join(root, "scripts/ci/push-ci-runner-image-ghcr.mts");
		const result = spawnSync(process.execPath, ["--no-warnings", script], {
			cwd: root,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				USER: process.env.USER ?? "",
			},
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
	});
});
