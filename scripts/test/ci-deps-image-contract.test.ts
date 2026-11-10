import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const WORKER_STORAGE_FS =
	"packages/ci-gh-actions/src/isolated-worker/worker-storage-fs.ts";
const STORAGE_ADMISSION =
	"packages/ci-gh-actions/src/isolated-worker/storage-admission.ts";
const HOST_CAPACITY =
	"packages/ci-gh-actions/src/isolated-worker/host-capacity.ts";
const MOUNT_TEST = "scripts/test/ci-deps-image-mount.test.ts";

function importSpecifiers(source: string): readonly string[] {
	return [
		...source.matchAll(
			/^import\s+(?:type\s+)?[\s\w{},*]*\s+from\s+["']([^"']+)["']/gm,
		),
	].map((match) => match[1]!);
}

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

	it("partitions the store in the install RUN into reproducible linked layers and a residual layer", () => {
		assert.equal(dockerfile.match(/^RUN --network=none/gm)?.length, 1);
		const installRun = dockerfile.slice(
			dockerfile.indexOf("RUN --network=none"),
			dockerfile.indexOf("FROM ${TOOLCHAIN_IMAGE} AS final"),
		);
		includes(
			installRun,
			"node --experimental-strip-types scripts/ci/deps-layer-buckets.mts partition",
		);
		includes(installRun, '-exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +');
		includes(installRun, 'cp -al "$source" "$target"');
		const move = installRun.indexOf("'set -e; for source do");
		const partition = installRun.indexOf(
			"node --experimental-strip-types scripts/ci/deps-layer-buckets.mts partition",
		);
		const touch = installRun.indexOf(
			'-exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +',
		);
		assert.ok(move > -1);
		assert.ok(partition > move);
		assert.ok(touch > partition);
		assert.equal(
			dockerfile.match(/^COPY --link --from=install --chown=1000:1000/gm)
				?.length,
			64,
		);
		includes(dockerfile, "/opt/hobo-deps-buckets/00/");
		includes(dockerfile, "/opt/hobo-deps-buckets/63/");
		includes(
			dockerfile,
			"COPY --from=install --chown=1000:1000 /opt/hobo-deps/ /opt/hobo-deps/",
		);
		includes(
			build,
			"node --experimental-strip-types scripts/ci/deps-layer-buckets.mts --check",
		);
		includes(build, "build_command=(docker build)");
		includes(build, "prune_command=(docker builder prune)");
		assert.ok(!build.includes("--load"));
		assert.ok(!build.includes("docker buildx create"));
		assert.ok(!build.includes("--builder"));
		includes(build, "rewrite_args=(--rewrite-timestamp=true)");
		includes(build, 'build_help="$(docker build --help 2>/dev/null)"');
		includes(build, "grep -q -- '--rewrite-timestamp'");
	});

	it("creates the install payload as root before the uid-1000 install stage", () => {
		const fetch = dockerfile.split("FROM fetch AS install")[0];
		assert.ok(fetch);
		const rootStep = fetch.indexOf("USER root");
		const create = fetch.indexOf(
			"RUN mkdir -p /pnpm-store /opt/actions-runner/_hobo_work/HoBo/HoBo /opt/hobo-deps /opt/hobo-deps-buckets \\",
		);
		const ownership = fetch.indexOf(
			"&& chown -R 1000:1000 /pnpm-store /opt/actions-runner/_hobo_work /opt/hobo-deps /opt/hobo-deps-buckets",
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
		const chown = final.indexOf(
			"RUN chown 1000:1000 /opt/hobo-deps /opt/hobo-deps/node_modules /opt/hobo-deps/node_modules/.pnpm",
		);
		assert.ok(ownership > -1);
		assert.ok(copy > ownership);
		assert.ok(chown > copy);
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
		const install = dockerfile.slice(
			dockerfile.indexOf("FROM fetch AS install"),
			dockerfile.indexOf("FROM ${TOOLCHAIN_IMAGE} AS final"),
		);
		includes(install, "npm_config_package_import_method=hardlink");
		includes(dockerfile, "/opt/hobo-deps/.hobo-ci-deps-key");
		assert.ok(!dockerfile.includes("remote.origin.url"));
		includes(build, "epoch=0");
		includes(build, 'candidate="hobo-ci-deps:${key}"');
	});

	it("falls back to the local worker toolchain and keys the candidate with it", () => {
		const computed = build.indexOf(
			'toolchain="$(node --no-warnings scripts/ci-runner-image-version.mts)"',
		);
		const ensure = build.indexOf("scripts/ci/ensure-ci-worker-image.mts");
		const fallback = build.indexOf(
			"docker image inspect hobo-ci-worker:local --format",
		);
		const key = build.indexOf('--toolchain "${toolchain}"');
		assert.ok(computed > -1);
		assert.ok(ensure > computed);
		assert.ok(fallback > ensure);
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

	it("imports the registry cache only with the containerd image store", () => {
		includes(build, "deps_uses_containerd_image_store()");
		includes(build, "docker info --format '{{json .DriverStatus}}'");
		includes(build, "*io.containerd.snapshotter*");
		const detection = build.indexOf(
			"if deps_uses_containerd_image_store; then",
		);
		const cacheImport = build.indexOf(
			'cache_args=(--cache-from "type=registry,ref=ghcr.io/${GITHUB_REPOSITORY,,}/hobo-ci-deps:buildcache")',
		);
		assert.ok(detection > -1);
		assert.ok(cacheImport > detection);
		includes(build, '"${cache_args[@]}"');
		includes(build, "deps registry cache import skipped: classic image store");
		assert.ok(!build.includes("--cache-to"));
	});

	it("stages the link verification script in the deps context for mount verify", () => {
		const key = read("scripts/lib/deps-key.mts");
		includes(
			key,
			'export const DEPS_LAYER_SCRIPT_PATH = "scripts/ci/deps-layer.mts"',
		);
		includes(key, "DEPS_LAYER_BUCKET_SCRIPT_PATH,");
		includes(key, "DEPS_LAYER_SCRIPT_PATH,");
		const bucket = key.indexOf("DEPS_LAYER_BUCKET_SCRIPT_PATH,");
		const link = key.lastIndexOf("DEPS_LAYER_SCRIPT_PATH,");
		assert.ok(bucket > -1);
		assert.ok(link > bucket);
	});

	it("stages the link verification script outside the Docker build context", () => {
		includes(build, 'verification="$(mktemp -d)"');
		includes(build, 'rm -rf "$context" "$verification" "$contract_log"');
		includes(build, 'cp -a "$context/." "$verification/"');
		includes(build, 'mkdir -p "$verification/scripts/ci"');
		includes(
			build,
			'cp scripts/ci/deps-layer.mts "$verification/scripts/ci/deps-layer.mts"',
		);
		includes(build, 'tar -C "$verification" -cf - .');
		assert.ok(!build.includes('tar -C "$context" -cf - .'));
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

	it("guards Docker inode and disk headroom before a deps rebuild", () => {
		includes(
			build,
			'inode_headroom="${HOBO_CI_DEPS_BUILD_INODE_HEADROOM:-400000}"',
		);
		includes(
			build,
			'byte_headroom="${HOBO_CI_DEPS_BUILD_BYTE_HEADROOM:-8589934592}"',
		);
		includes(build, "invalid HOBO_CI_DEPS_BUILD_INODE_HEADROOM");
		includes(build, "invalid HOBO_CI_DEPS_BUILD_BYTE_HEADROOM");
		includes(build, "df --output=iavail");
		includes(build, "df -B1 --output=avail");
		assert.ok(!build.includes("df -P --output"));
		includes(build, "resolve_deps_headroom_sample_path");
		includes(build, "HOBO_CI_HOST_JOB_DIRECTORY");
		includes(build, "docker_data_root_device");
		includes(build, "ensure_deps_build_headroom");
		includes(build, "docker builder prune -f --keep-storage");
		includes(
			build,
			"refusing deps rebuild: Docker data root still below headroom after builder prune",
		);
		includes(build, "cannot sample Docker data root for deps build headroom");
		assert.ok(!build.includes("docker image prune -af"));
		assert.ok(!build.includes("docker image prune -a"));
		const guard = build.indexOf("ensure_deps_build_headroom");
		const call = build.lastIndexOf("ensure_deps_build_headroom");
		const buildCommand = build.indexOf('"${build_command[@]}" \\');
		const preBuildGc = build.indexOf(
			'scripts/ci-runner-image-gc.mts "$candidate" || true',
		);
		assert.ok(guard > -1);
		assert.ok(call > guard);
		assert.ok(buildCommand > call);
		assert.ok(preBuildGc > -1);
		assert.ok(preBuildGc < call);
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
		assert.equal(build.split(command).length, 4);
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
	const end = workflow.indexOf("  pr_gate_validation:", start);
	const job = workflow.slice(start, end);
	const buildCondition =
		"if: steps.scope.outputs.run == 'true' && steps.current.outputs.current != 'true' && steps.source.outputs.source == 'build' && github.event_name == 'pull_request'";
	const deferCondition =
		"if: steps.scope.outputs.run == 'true' && steps.current.outputs.current != 'true' && steps.source.outputs.source == 'build' && github.event_name != 'pull_request'";
	const verifyCondition =
		"if: steps.scope.outputs.run == 'true' && steps.current.outputs.current != 'true' && (steps.source.outputs.source != 'build' || github.event_name == 'pull_request')";
	const promoteCondition =
		"if: steps.scope.outputs.run == 'true' && steps.current.outputs.current != 'true' && steps.source.outputs.source != 'build' && github.event_name != 'pull_request'";

	it("logs in before resolving and builds PR misses without writing GHCR", () => {
		assert.ok(start > -1);
		assert.ok(end > start);
		includes(job, "name: CI deps layer (pnpm)");
		includes(job, "needs: [route, ci-runner-image]");
		includes(job, "needs.ci-runner-image.result != 'failure'");
		includes(job, "packages/ci-gh-actions/deploy/ci-runner/deps");
		includes(job, "scripts/ci/deps-layer-buckets.mts");
		includes(
			job,
			"run: bash packages/ci-gh-actions/deploy/ci-runner/deps/build-deps.sh --no-promote",
		);
		includes(job, buildCondition);
		includes(job, "Remove PR candidate tag");
		assert.ok(!job.includes("docker push"));
		assert.ok(!job.includes("--cache-to"));
		assert.ok(!job.includes("packages: write"));
		includes(job, "packages: read");
		includes(job, "Login to GHCR for read-only cache");
		assert.ok(!job.includes("env.GHCR_TOKEN != ''"));
		includes(job, "GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
		const login = job.indexOf("- name: Login to GHCR for read-only cache");
		const resolve = job.indexOf("- name: Resolve local or GHCR deps image");
		const buildStep = job.indexOf(
			"- name: Build deps image and verify offline install",
		);
		assert.ok(login > -1);
		assert.ok(resolve > login);
		assert.ok(buildStep > resolve);
	});

	it("reuses local or GHCR hits on every event without building", () => {
		const local = job.indexOf('if docker image inspect "$candidate"');
		const manifest = job.indexOf('docker manifest inspect "$remote"');
		const pull = job.indexOf('docker pull "$remote"');
		const buildStep = job.indexOf(
			"- name: Build deps image and verify offline install",
		);
		assert.ok(local > -1);
		assert.ok(manifest > local);
		assert.ok(pull > manifest);
		assert.ok(buildStep > pull);
		includes(job, promoteCondition);
		includes(
			job,
			'node --experimental-strip-types --no-warnings scripts/ci-runner-image-gc.mts "$candidate"',
		);
		assert.ok(
			!job.includes('if [ "${{ github.event_name }}" != "pull_request" ]'),
		);
	});

	it("defers a non-PR miss without building, verifying, or promoting", () => {
		const defer = job.indexOf("- name: Defer non-PR deps image miss");
		const verify = job.indexOf("- name: Verify deps image under job mount");
		assert.ok(defer > -1);
		assert.ok(verify > defer);
		const deferredStep = job.slice(defer, verify);
		includes(deferredStep, deferCondition);
		includes(
			deferredStep,
			"Key miss deferred to CI deps image publisher and the daemon ensure loop; skipping Fabric rebuild",
		);
		assert.ok(!deferredStep.includes("build-deps.sh"));
		includes(job, buildCondition);
		includes(job, verifyCondition);
		includes(job, promoteCondition);
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
		includes(job, verifyCondition);
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
		includes(main, "needs: [route, ci-runner-image]");
		assert.ok(!main.includes("ci-deps-image"));
		includes(workflow, "Check deps layer match");
	});
});

describe("CI deps mount probe contract", () => {
	it("mount verify imports worker-storage-fs only (not storage-admission)", () => {
		const mount = read(MOUNT_TEST);
		includes(mount, WORKER_STORAGE_FS);
		assert.ok(
			!mount.includes(STORAGE_ADMISSION),
			"mount verify must not load storage-admission (zod and admission graph)",
		);
	});

	it("worker-storage-fs imports only node built-ins", () => {
		for (const specifier of importSpecifiers(read(WORKER_STORAGE_FS))) {
			assert.match(
				specifier,
				/^node:/u,
				`worker-storage-fs must not import ${specifier}`,
			);
		}
	});

	it("host-capacity stays node-only when present (safe for future mount probes)", () => {
		if (!existsSync(join(root, HOST_CAPACITY))) return;
		for (const specifier of importSpecifiers(read(HOST_CAPACITY))) {
			assert.match(
				specifier,
				/^node:/u,
				`host-capacity must not import ${specifier} on the mount path`,
			);
		}
	});

	it("storage-admission mount probe runs with no workspace node_modules", () => {
		const probeCwd = mkdtempSync(join(tmpdir(), "hobo-deps-mount-probe-"));
		const jobDir = join(probeCwd, "hobo-00000000-0000-4000-8000-000000000099");
		try {
			const modulePath = join(root, WORKER_STORAGE_FS);
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--import",
					join(root, "scripts/lib/ts-source-resolve.mts"),
					"-e",
					[
						`import { createNodeWorkerStorageFileSystem } from ${JSON.stringify(modulePath)};`,
						`await createNodeWorkerStorageFileSystem().prepareJobDirectory(${JSON.stringify(jobDir)});`,
					].join(" "),
				],
				{
					cwd: probeCwd,
					env: {
						PATH: process.env.PATH ?? "",
						HOME: process.env.HOME ?? "",
						USER: process.env.USER ?? "",
						LANG: process.env.LANG ?? "C.UTF-8",
					},
					encoding: "utf8",
				},
			);
			const combined = `${result.stdout}\n${result.stderr}`;
			assert.equal(result.status, 0, combined);
			assert.doesNotMatch(combined, /ERR_MODULE_NOT_FOUND.*['"]zod['"]/u);
			assert.ok(existsSync(join(jobDir, "HoBo", "HoBo")));
		} finally {
			rmSync(probeCwd, { recursive: true, force: true });
		}
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
		includes(workflow, "timeout-minutes: 20");
		includes(workflow, "cancel-in-progress: true");
		includes(workflow, "github.event.workflow_run.conclusion == 'success'");
		includes(workflow, "github.event.workflow_run.head_sha");
	});

	it("skips an existing GHCR tag and builds only after a confirmed miss", () => {
		includes(publish, 'export GITHUB_TOKEN="${GITHUB_TOKEN:-${GHCR_TOKEN:-}}"');
		includes(publish, 'key="$(node --no-warnings scripts/ci/deps-key.mts)"');
		includes(publish, 'candidate="hobo-ci-deps:${key}"');
		includes(publish, "docker image inspect hobo-ci-deps:local");
		includes(publish, '{{ index .Config.Labels "hobo.ci.deps-key" }}');
		includes(publish, 'source="hobo-ci-deps:local"');
		const login = publish.indexOf("docker login ghcr.io");
		const manifest = publish.indexOf('docker manifest inspect "$image"');
		const local = publish.indexOf("docker image inspect hobo-ci-deps:local");
		includes(workflow, "scripts/ci/wait-deps-build-window.mts");
		includes(publish, "scripts/ci/wait-deps-build-window.mts");
		const build = publish.indexOf(
			"bash packages/ci-gh-actions/deploy/ci-runner/deps/build-deps.sh",
		);
		const tag = publish.indexOf('docker tag "$source" "$image"');
		const push = publish.indexOf("docker push");
		assert.ok(login > -1);
		assert.ok(manifest > login);
		assert.ok(local > manifest);
		assert.ok(build > local);
		assert.ok(tag > build);
		assert.ok(push > tag);
		includes(publish, "GHCR already has ${image}; skipping push");
		assert.ok(
			!publish.includes(
				"No local deps image for ${key}; skipping GHCR publish",
			),
		);
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

	it("exports mode=min cache after the push only with the containerd image store", () => {
		const push = publish.indexOf(
			"timeout --signal=TERM --kill-after=15s 240s docker push",
		);
		const detection = publish.indexOf(
			"if ! deps_uses_containerd_image_store; then",
		);
		const exportCache = publish.indexOf(
			'--cache-to "type=registry,ref=${cache_image},mode=min"',
		);
		assert.ok(push > -1);
		assert.ok(detection > push);
		assert.ok(exportCache > detection);
		includes(publish, "docker info --format '{{json .DriverStatus}}'");
		includes(publish, "*io.containerd.snapshotter*");
		includes(
			publish,
			"deps registry cache export skipped: classic image store",
		);
		includes(
			publish,
			"timeout --signal=TERM --kill-after=15s 120s docker buildx build",
		);
		includes(publish, '--cache-from "type=registry,ref=${cache_image}"');
		includes(publish, "if ! docker buildx version >/dev/null 2>&1; then");
		includes(
			publish,
			'buildx_help="$(docker buildx build --help 2>&1 || true)"',
		);
		includes(
			publish,
			"docker buildx is unavailable; skipping deps buildcache export",
		);
		assert.ok(
			!publish.includes(
				'if ! buildx_help="$(docker buildx build --help 2>/dev/null)"',
			),
		);
		includes(
			publish,
			"docker push uploads only blobs the registry lacks, so unchanged bucket layers are skipped",
		);
		assert.ok(!publish.includes("mode=max"));
		assert.ok(!publish.includes("--load"));
		assert.ok(!publish.includes("docker buildx create"));
		assert.ok(!publish.includes("--builder"));
	});
});
