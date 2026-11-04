import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const dockerfile = read(
	"packages/ci-gh-actions/deploy/ci-runner/deps/Dockerfile",
);
const build = read(
	"packages/ci-gh-actions/deploy/ci-runner/deps/build-deps.sh",
);
const toolchainBuild = read("packages/ci-gh-actions/deploy/ci-runner/build.sh");

describe("CI deps image build contract", () => {
	it("separates the pinned fetch from the offline install and drops the store", () => {
		expect(dockerfile).toContain("FROM ${TOOLCHAIN_IMAGE} AS fetch");
		expect(dockerfile).toContain("RUN pnpm fetch --frozen-lockfile");
		expect(dockerfile).toContain("FROM ${FETCH_IMAGE} AS install");
		expect(dockerfile).toContain(
			"RUN pnpm install --frozen-lockfile --offline --ignore-scripts",
		);
		expect(dockerfile).toContain(
			"pnpm rebuild @ast-grep/cli @bufbuild/buf esbuild protobufjs",
		);
		expect(build).toContain("docker build --network=none");
		expect(dockerfile).toContain("FROM ${TOOLCHAIN_IMAGE} AS final");
		expect(dockerfile).toContain("COPY --from=install --chown=1000:1000");
		expect(dockerfile).toContain(
			"\\( -name node_modules -o -name .git \\) -prune -o -type f -delete",
		);
		expect(dockerfile.split("AS final")[1]).not.toContain("RUN pnpm fetch");
	});

	it("records toolchain, key, workspace, git remote and reproducible epoch", () => {
		expect(dockerfile).toContain("LABEL hobo.ci.deps-key=${DEPS_KEY}");
		expect(dockerfile).toContain("hobo.ci.toolchain=${TOOLCHAIN_VERSION}");
		expect(dockerfile).toContain("ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}");
		expect(dockerfile).toContain("ENV npm_config_store_dir=/pnpm-store");
		expect(dockerfile).toContain("npm_config_package_import_method=copy");
		expect(dockerfile).toContain("git init --quiet");
		expect(dockerfile).toContain(
			"git config remote.origin.url https://github.com/Hobo-Labs/HoBo",
		);
		expect(build).toContain('epoch="$(git log -1 --format=%ct)"');
		expect(build).toContain('candidate="hobo-ci-deps:${key}"');
	});

	it("requires an up-to-date offline contract before local promotion", () => {
		expect(build).toContain(
			"pnpm install --frozen-lockfile --offline --config.confirmModulesPurge=false",
		);
		expect(build).toContain("-e npm_config_ignore_scripts=true");
		const contract = build.indexOf("grep -q 'Already up to date'");
		const promote = build.indexOf('docker tag "$candidate" hobo-ci-deps:local');
		expect(contract).toBeGreaterThan(-1);
		expect(promote).toBeGreaterThan(contract);
		expect(build).toContain("--no-promote");
	});

	it("tries GHCR before building a missing toolchain and revalidates it", () => {
		const pull = toolchainBuild.indexOf('docker pull "${published}"');
		const nativeBuild = toolchainBuild.indexOf("docker build --build-arg");
		expect(pull).toBeGreaterThan(-1);
		expect(pull).toBeLessThan(nativeBuild);
		expect(toolchainBuild).toContain(
			'repository="${GITHUB_REPOSITORY:-Hobo-Labs/HoBo}"',
		);
		expect(toolchainBuild).toContain("if promote_candidate; then");
	});
});

describe("CI deps workflow contract", () => {
	const workflow = read(".github/workflows/hobo-ci.yml");
	const start = workflow.indexOf("  ci-deps-image:");
	const end = workflow.indexOf("  pr-gate:", start);
	const job = workflow.slice(start, end);

	it("builds PR changes without promotion or registry writes", () => {
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		expect(job).toContain("name: CI deps layer (pnpm)");
		expect(job).toContain("needs: ci-runner-image");
		expect(job).toContain("needs.ci-runner-image.result != 'failure'");
		expect(job).toContain("packages/ci-gh-actions/deploy/ci-runner/deps");
		expect(job).toContain("args=(--no-promote)");
		expect(job).toContain("Remove PR candidate tag");
		expect(job).toContain(
			"if: steps.scope.outputs.run == 'true' && github.event_name != 'pull_request' && steps.source.outputs.source != 'build'",
		);
		expect(job).toContain(
			"steps.build.outcome == 'success' && github.repository == 'Hobo-Labs/HoBo'",
		);
	});

	it("does not put the deps image on Main full gate's critical path", () => {
		const mainStart = workflow.indexOf("  main-gate:");
		const mainEnd = workflow.indexOf("  artifact-trust:", mainStart);
		const main = workflow.slice(mainStart, mainEnd);
		expect(main).toContain("needs: ci-runner-image");
		expect(main).not.toContain("ci-deps-image");
		expect(workflow).toContain("Check deps layer match");
	});
});
