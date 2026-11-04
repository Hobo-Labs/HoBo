import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const dockerfile = read(
	"packages/ci-gh-actions/deploy/ci-runner/deps/Dockerfile",
);
const build = read(
	"packages/ci-gh-actions/deploy/ci-runner/deps/build-deps.sh",
);
const toolchainBuild = read("packages/ci-gh-actions/deploy/ci-runner/build.sh");

function includes(text: string, expected: string): void {
	assert.ok(text.includes(expected), `missing: ${expected}`);
}

describe("CI deps image build contract", () => {
	it("reuses the host store and copies only node_modules and the git skeleton", () => {
		includes(dockerfile, "FROM ${TOOLCHAIN_IMAGE} AS fetch");
		const cacheMount =
			"--mount=type=cache,id=hobo-pnpm-store,target=/pnpm-store,uid=1000,gid=1000";
		assert.equal(dockerfile.split(cacheMount).length, 3);
		includes(dockerfile, "pnpm fetch --frozen-lockfile");
		includes(dockerfile, "FROM fetch AS install");
		includes(dockerfile, `RUN --network=none ${cacheMount}`);
		includes(
			dockerfile,
			"pnpm install --frozen-lockfile --offline --ignore-scripts",
		);
		includes(
			dockerfile,
			"pnpm rebuild @ast-grep/cli @bufbuild/buf esbuild protobufjs",
		);
		includes(dockerfile, "FROM ${TOOLCHAIN_IMAGE} AS final");
		includes(dockerfile, "/opt/actions-runner/_hobo_work/deps/");
		includes(dockerfile, "-type d -name node_modules -prune -exec");
		assert.ok(!dockerfile.includes("-delete"));
		assert.ok(!dockerfile.includes("FETCH_IMAGE"));
		assert.ok(!build.includes("hobo-ci-deps-fetch"));
		assert.ok(!dockerfile.split("AS final")[1]?.includes("RUN pnpm fetch"));
	});

	it("partitions the store into reproducible linked layers and a residual layer", () => {
		includes(
			dockerfile,
			"node --experimental-strip-types scripts/ci/deps-layer-buckets.mts partition",
		);
		includes(dockerfile, '-exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +');
		assert.equal(
			dockerfile.match(/^COPY --link --from=install --chown=1000:1000/gm)
				?.length,
			65,
		);
		includes(dockerfile, "deps-buckets/00/");
		includes(dockerfile, "deps-buckets/63/");
		includes(
			build,
			"node --experimental-strip-types scripts/ci/deps-layer-buckets.mts --check",
		);
		includes(build, "build_command=(docker build)");
		includes(build, "build_command=(docker buildx build --load)");
		includes(build, "rewrite_args=(--rewrite-timestamp=true)");
		includes(build, "grep -q -- '--rewrite-timestamp'");
	});

	it("records toolchain, key, workspace, git remote and reproducible epoch", () => {
		includes(dockerfile, "LABEL hobo.ci.deps-key=${DEPS_KEY}");
		includes(dockerfile, "hobo.ci.toolchain=${TOOLCHAIN_VERSION}");
		includes(dockerfile, "ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}");
		includes(dockerfile, "ENV npm_config_store_dir=/pnpm-store");
		includes(dockerfile, "npm_config_package_import_method=copy");
		includes(dockerfile, "git init --quiet");
		includes(
			dockerfile,
			"git config remote.origin.url https://github.com/Hobo-Labs/HoBo",
		);
		includes(build, "epoch=0");
		includes(build, 'candidate="hobo-ci-deps:${key}"');
	});

	it("falls back to the local worker toolchain and keys the candidate with it", () => {
		const computed = build.indexOf(
			'toolchain="$(node --no-warnings scripts/ci-runner-image-version.mts)"',
		);
		const fallback = build.indexOf(
			"docker image inspect hobo-ci-worker:local --format",
		);
		const key = build.indexOf('--toolchain "${toolchain}"');
		assert.ok(computed > -1);
		assert.ok(fallback > computed);
		assert.ok(key > fallback);
		includes(build, "^hobo-ci-worker:(v[0-9a-f]{12})$");
		includes(build, "Using toolchain image");
	});

	it("returns on a keyed or matching-local hit without building", () => {
		const localKey = build.indexOf("local_key=");
		const restore = build.indexOf('docker tag hobo-ci-deps:local "$candidate"');
		const hit = build.indexOf('if docker image inspect "$candidate"', restore);
		const exit = build.indexOf("exit 0", hit);
		const buildCommand = build.indexOf('"${build_command[@]}" \\');
		assert.ok(localKey > -1);
		assert.ok(restore > localKey);
		assert.ok(hit > restore);
		assert.ok(exit > hit);
		assert.ok(buildCommand > exit);
		includes(build, '[ "$local_key" = "$key" ]');
	});

	it("requires an up-to-date offline contract before promoting a new build", () => {
		includes(
			build,
			"pnpm install --frozen-lockfile --offline --config.confirmModulesPurge=false",
		);
		includes(build, "-e npm_config_ignore_scripts=true");
		includes(build, "--tmpfs /pnpm-store:rw,uid=1000,gid=1000,mode=0755");
		const contract = build.indexOf("grep -q 'Already up to date'");
		const promote = build.lastIndexOf(
			'docker tag "$candidate" hobo-ci-deps:local',
		);
		assert.ok(contract > -1);
		assert.ok(promote > contract);
		includes(build, "--no-promote");
	});

	it("lets the worker cap build and verification memory", () => {
		includes(
			build,
			'docker_memory_args=(--memory "${HOBO_CI_DEPS_BUILD_MEMORY_MB}m")',
		);
		assert.equal(build.split('"${docker_memory_args[@]}"').length, 3);
		includes(build, "invalid HOBO_CI_DEPS_BUILD_MEMORY_MB");
	});

	it("collects old keyed and fetch images through the tested selection helper", () => {
		const gc = read("scripts/ci-runner-image-gc.mts");
		const command =
			'node --experimental-strip-types --no-warnings scripts/ci-runner-image-gc.mts "$candidate"';
		assert.equal(build.split(command).length, 3);
		includes(
			gc,
			"selectWorkerImagesForDeletion(inventoryWithUsage, currentDepsTag)",
		);
		includes(gc, '"{{.Image}}"');
		includes(gc, '["image", "prune", "-f"]');
		const promote = build.lastIndexOf(
			'docker tag "$candidate" hobo-ci-deps:local',
		);
		assert.ok(build.lastIndexOf(command) > promote);
	});

	it("tries GHCR before building a missing toolchain and revalidates it", () => {
		const pull = toolchainBuild.indexOf('docker pull "${published}"');
		const nativeBuild = toolchainBuild.indexOf("docker build --build-arg");
		assert.ok(pull > -1);
		assert.ok(pull < nativeBuild);
		includes(
			toolchainBuild,
			'repository="${GITHUB_REPOSITORY:-Hobo-Labs/HoBo}"',
		);
		includes(toolchainBuild, "if promote_candidate; then");
		includes(toolchainBuild, 'if [[ -n "${GHCR_TOKEN:-}" ]]; then');
		includes(
			toolchainBuild,
			"GHCR_TOKEN is unavailable; skipping published runner image pull",
		);
	});
});

describe("CI deps workflow contract", () => {
	const workflow = read(".github/workflows/hobo-ci.yml");
	const start = workflow.indexOf("  ci-deps-image:");
	const end = workflow.indexOf("  pr-gate:", start);
	const job = workflow.slice(start, end);

	it("builds PR misses without promoting the new candidate or writing GHCR", () => {
		assert.ok(start > -1);
		assert.ok(end > start);
		includes(job, "name: CI deps layer (pnpm)");
		includes(job, "needs: ci-runner-image");
		includes(job, "needs.ci-runner-image.result != 'failure'");
		includes(job, "packages/ci-gh-actions/deploy/ci-runner/deps");
		includes(job, "scripts/ci/deps-layer-buckets.mts");
		includes(job, "args=(--no-promote)");
		includes(job, "Remove PR candidate tag");
		assert.ok(!job.includes("docker push"));
		assert.ok(!job.includes("GHCR_TOKEN"));
		assert.ok(!job.includes("packages: write"));
	});

	it("reuses local or GHCR hits on every event without building", () => {
		const local = job.indexOf('if docker image inspect "$candidate"');
		const manifest = job.indexOf('docker manifest inspect "$remote"');
		const pull = job.indexOf('docker pull "$remote"');
		const buildStep = job.indexOf(
			"if: steps.scope.outputs.run == 'true' && steps.current.outputs.current != 'true' && steps.source.outputs.source == 'build'",
		);
		assert.ok(local > -1);
		assert.ok(manifest > local);
		assert.ok(pull > manifest);
		assert.ok(buildStep > pull);
		includes(
			job,
			"if: steps.scope.outputs.run == 'true' && steps.current.outputs.current != 'true' && steps.source.outputs.source != 'build'",
		);
		includes(
			job,
			'node --experimental-strip-types --no-warnings scripts/ci-runner-image-gc.mts "$candidate"',
		);
		assert.ok(
			!job.includes('if [ "${{ github.event_name }}" != "pull_request" ]'),
		);
	});

	it("does not put the deps image on Main full gate's critical path", () => {
		const mainStart = workflow.indexOf("  main-gate:");
		const mainEnd = workflow.indexOf("  artifact-trust:", mainStart);
		const main = workflow.slice(mainStart, mainEnd);
		includes(main, "needs: ci-runner-image");
		assert.ok(!main.includes("ci-deps-image"));
		includes(workflow, "Check deps layer match");
	});
});

describe("CI deps publisher contract", () => {
	const workflow = read(".github/workflows/ci-deps-publish.yml");
	const publish = read(
		"packages/ci-gh-actions/deploy/ci-runner/deps/publish-deps.sh",
	);

	it("runs only after a successful main fabric run or manually", () => {
		includes(workflow, 'workflows: ["HoBo CI Fabric"]');
		includes(workflow, "types: [completed]");
		includes(workflow, "branches: [main]");
		includes(workflow, "workflow_dispatch:");
		includes(workflow, "timeout-minutes: 5");
		includes(workflow, "cancel-in-progress: true");
		includes(workflow, "github.event.workflow_run.conclusion == 'success'");
		includes(workflow, "github.event.workflow_run.head_sha");
	});

	it("skips absent local images and existing GHCR tags", () => {
		includes(publish, 'key="$(node --no-warnings scripts/ci/deps-key.mts)"');
		includes(publish, 'candidate="hobo-ci-deps:${key}"');
		includes(publish, "docker image inspect hobo-ci-deps:local");
		includes(publish, '{{ index .Config.Labels "hobo.ci.deps-key" }}');
		includes(publish, 'source="hobo-ci-deps:local"');
		const manifest = publish.indexOf('docker manifest inspect "$image"');
		const tag = publish.indexOf('docker tag "$source" "$image"');
		const push = publish.indexOf("docker push");
		assert.ok(manifest > -1);
		assert.ok(tag > manifest);
		assert.ok(push > tag);
		includes(publish, "GHCR already has ${image}; skipping push");
	});

	it("bounds the push and keeps the token on stdin", () => {
		includes(
			publish,
			"timeout --signal=TERM --kill-after=15s 240s docker push",
		);
		includes(
			publish,
			'printf \'%s\' "$GHCR_TOKEN" | docker login ghcr.io -u "${GITHUB_ACTOR:?GITHUB_ACTOR is required}" --password-stdin',
		);
		assert.ok(!publish.includes('echo "$GHCR_TOKEN"'));
		assert.ok(!publish.includes('echo "${{ secrets.GITHUB_TOKEN }}'));
	});
});
