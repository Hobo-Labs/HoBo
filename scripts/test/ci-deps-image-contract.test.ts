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
	it("reuses the host store and stages only node_modules outside the work dir", () => {
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
		includes(dockerfile, 'target="/opt/hobo-deps/${source#./}"');
		includes(dockerfile, "-type d -name node_modules -prune -exec");
		assert.ok(!dockerfile.includes("git init"));
		assert.ok(!dockerfile.includes("-delete"));
		assert.ok(!dockerfile.includes("FETCH_IMAGE"));
		assert.ok(!build.includes("hobo-ci-deps-fetch"));
		assert.ok(!dockerfile.split("AS final")[1]?.includes("RUN pnpm fetch"));
	});

	it("creates the install payload as root before the uid-1000 install stage", () => {
		const fetch = dockerfile.split("FROM fetch AS install")[0];
		assert.ok(fetch);
		const rootStep = fetch.indexOf("USER root");
		const create = fetch.indexOf(
			"RUN mkdir -p /pnpm-store /opt/actions-runner/_hobo_work/HoBo/HoBo /opt/hobo-deps \\",
		);
		const ownership = fetch.indexOf(
			"&& chown -R 1000:1000 /pnpm-store /opt/actions-runner/_hobo_work /opt/hobo-deps",
			create,
		);
		const installUser = fetch.indexOf("USER 1000:1000", ownership);
		assert.ok(rootStep > -1);
		assert.ok(create > rootStep);
		assert.ok(ownership > create);
		assert.ok(installUser > ownership);
		includes(dockerfile, "'set -e; for source do");
	});

	it("creates an owned payload destination without creating a work dir", () => {
		const final = dockerfile.split("FROM ${TOOLCHAIN_IMAGE} AS final")[1];
		assert.ok(final);
		const ownership = final.indexOf(
			"RUN install -d -o 1000 -g 1000 /opt/hobo-deps",
		);
		const copy = final.indexOf(
			"COPY --from=install --chown=1000:1000 /opt/hobo-deps/ /opt/hobo-deps/",
		);
		assert.ok(ownership > -1);
		assert.ok(copy > ownership);
		assert.ok(!final.includes("_hobo_work"));
		assert.ok(!final.includes("WORKDIR"));
		includes(final.slice(0, ownership), "USER root");
	});

	it("records toolchain, payload key and reproducible epoch without a git skeleton", () => {
		includes(dockerfile, "LABEL hobo.ci.deps-key=${DEPS_KEY}");
		includes(dockerfile, "hobo.ci.toolchain=${TOOLCHAIN_VERSION}");
		includes(dockerfile, "ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}");
		includes(dockerfile, "ENV npm_config_store_dir=/pnpm-store");
		includes(dockerfile, "npm_config_package_import_method=copy");
		includes(dockerfile, "/opt/hobo-deps/.hobo-ci-deps-key");
		assert.ok(!dockerfile.includes("remote.origin.url"));
		includes(build, 'epoch="$(git log -1 --format=%ct)"');
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

	it("returns on a local keyed hit without building", () => {
		const hit = build.indexOf('if docker image inspect "$candidate"');
		const exit = build.indexOf("exit 0", hit);
		const buildCommand = build.indexOf("docker build \\");
		assert.ok(hit > -1);
		assert.ok(exit > hit);
		assert.ok(buildCommand > exit);
	});

	it("requires an up-to-date offline contract before promoting a new build", () => {
		includes(
			build,
			"pnpm install --frozen-lockfile --offline --config.confirmModulesPurge=false",
		);
		includes(build, "-e npm_config_ignore_scripts=true");
		includes(build, "--tmpfs /pnpm-store:rw,uid=1000,gid=1000,mode=0755");
		const contract = build.indexOf("grep -q 'Already up to date'");
		const mount = build.lastIndexOf("verify_mount_contract");
		const promote = build.lastIndexOf(
			'docker tag "$candidate" hobo-ci-deps:local',
		);
		assert.ok(contract > -1);
		assert.ok(mount > contract);
		assert.ok(promote > mount);
		includes(build, "scripts/test/ci-deps-image-mount.test.ts");
		includes(build, "--import ./scripts/lib/ts-source-resolve.mts");
		assert.doesNotMatch(build, /--import tsx/);
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
		includes(job, "build-deps.sh --no-promote");
		includes(job, "Remove PR candidate tag");
		includes(
			job,
			"steps.build.outcome == 'success' && github.repository == 'Hobo-Labs/HoBo'",
		);
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
			"if: steps.scope.outputs.run == 'true' && steps.current.outputs.current != 'true' && github.event_name != 'pull_request'",
		);
		includes(
			job,
			'node --experimental-strip-types --no-warnings scripts/ci-runner-image-gc.mts "$candidate"',
		);
		assert.ok(
			!job.includes('if [ "${{ github.event_name }}" != "pull_request" ]'),
		);
	});

	it("proves every candidate under a job mount before promotion", () => {
		const buildStep = job.indexOf(
			"- name: Build deps image and verify offline install",
		);
		const mount = job.indexOf("- name: Verify deps image under job mount");
		const promote = job.indexOf("- name: Promote verified deps image");
		assert.ok(buildStep > -1);
		assert.ok(mount > buildStep);
		assert.ok(promote > mount);
		includes(job, "HOBO_CI_DEPS_MOUNT_CONTRACT: '1'");
		includes(
			job,
			"node --experimental-strip-types --no-warnings --import ./scripts/lib/ts-source-resolve.mts --test scripts/test/ci-deps-image-mount.test.ts",
		);
		assert.doesNotMatch(job, /--import tsx/);
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
