import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	materializeWorkerImageVersionTag,
	publishPullRequestWorkerImage,
	pushCiRunnerImageGhcr,
} from "../ci/push-ci-runner-image-ghcr.mts";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const workflow = readFileSync(
	join(root, ".github/workflows/hobo-ci.yml"),
	"utf8",
);

describe("push-ci-runner-image-ghcr", () => {
	it("materializes runner image from GHCR before native build", () => {
		const workflow = readFileSync(
			join(root, ".github/workflows/hobo-ci.yml"),
			"utf8",
		);
		const job = workflow.slice(
			workflow.indexOf("\n  ci-runner-image:"),
			workflow.indexOf("\n  ci-deps-image:"),
		);
		assert.match(job, /ensure-ci-worker-image\.mts --materialize-only/u);
		assert.match(job, /steps\.materialize\.outcome != 'success'/u);
	});

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

	it("tags :latest from the versioned image it pushed, not the box's :local", () => {
		const source = readFileSync(
			join(root, "scripts/ci/push-ci-runner-image-ghcr.mts"),
			"utf8",
		);
		assert.match(source, /run\("docker", \["tag", candidate, latest\]\)/u);
		assert.doesNotMatch(source, /"hobo-ci-worker:local", latest/u);
	});

	function jobBlock(name: string): string {
		const start = workflow.indexOf(`\n  ${name}:\n`);
		assert.ok(start > -1, name);
		const next = workflow.slice(start + 1).search(/\n {2}[a-z_-]+:\n/u);
		return workflow.slice(start, next === -1 ? undefined : start + 1 + next);
	}

	it("shares a same-repository pull request's built image through GHCR, never :latest or a release tag", () => {
		const job = jobBlock("ci-runner-image");
		const step = job.slice(
			job.indexOf("Share this pull request's runner image through GHCR"),
			job.indexOf("Push runner image to GHCR (optional)"),
		);
		assert.match(step, /steps\.ci_runner_image_build\.outcome == 'success'/u);
		assert.match(step, /github\.event_name == 'pull_request'/u);
		assert.match(
			step,
			/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u,
		);
		assert.match(step, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/u);
		assert.match(step, /push-ci-runner-image-ghcr\.mts --pull-request$/mu);
		assert.match(job, /packages: write/u);
	});

	it("runs the cold dev loop after the image job, even when that job fails", () => {
		const job = jobBlock("dev-cold-loop-gate");
		assert.match(job, /needs: \[route, ci-runner-image\]/u);
		assert.match(
			job,
			/if: \$\{\{ !cancelled\(\) && needs\.route\.result == 'success' && github\.event_name == 'pull_request' \}\}/u,
		);
	});

	it("pushes only the pull request's content-keyed tag", () => {
		const calls: string[] = [];
		const outcome = publishPullRequestWorkerImage({
			repository: "Hobo-Labs/HoBo",
			pullRequest: 2953,
			version: "v749d8677addb",
			present: (ref) => ref === "hobo-ci-worker:v749d8677addb",
			run: (cmd, args) => {
				calls.push(`${cmd} ${args.join(" ")}`);
				return 0;
			},
		});
		const remote =
			"ghcr.io/hobo-labs/hobo/hobo-ci-worker:pr-2953-v749d8677addb";
		assert.deepEqual(outcome, { published: remote });
		assert.deepEqual(calls, [
			`docker tag hobo-ci-worker:v749d8677addb ${remote}`,
			`docker push ${remote}`,
		]);
	});

	it("shares nothing for a fork, an absent build, or a failed push", () => {
		const base = {
			repository: "Hobo-Labs/HoBo",
			version: "v749d8677addb",
			present: () => true,
			run: () => 0,
		};
		assert.deepEqual(
			publishPullRequestWorkerImage({ ...base, pullRequest: null }),
			{ skipped: "not-a-same-repository-pull-request" },
		);
		assert.deepEqual(
			publishPullRequestWorkerImage({
				...base,
				pullRequest: 1,
				present: (ref) => ref === "hobo-ci-worker:local",
			}),
			{ skipped: "absent" },
		);
		assert.deepEqual(
			publishPullRequestWorkerImage({
				...base,
				pullRequest: 1,
				run: (_cmd, args) => (args[0] === "push" ? 1 : 0),
			}),
			{ skipped: "push-failed" },
		);
	});

	it("skips the pull request share cleanly outside a pull request", () => {
		const script = join(root, "scripts/ci/push-ci-runner-image-ghcr.mts");
		const result = spawnSync(
			process.execPath,
			["--no-warnings", script, "--pull-request"],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: process.env.HOME ?? "",
					GITHUB_TOKEN: "token-for-test",
					GITHUB_EVENT_NAME: "push",
				},
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Not a same-repository pull request/u);
	});
});
