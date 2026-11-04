import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CI_RUNNER_IMAGE_VERSION_INPUTS } from "../../../scripts/lib/ci-runner-contract.mts";
import { depsContextPaths } from "../../../scripts/lib/deps-key.mts";

const root = join(import.meta.dirname, "..", "..", "..");
const workflow = parse(
	readFileSync(join(root, ".github/workflows/hobo-ci.yml"), "utf8"),
);
const depsJob = workflow.jobs["ci-deps-image"];
const imageJob = workflow.jobs["ci-runner-image"];
const prGate = workflow.jobs["pr-gate"];
const mainGate = workflow.jobs["main-gate"];
const payload =
	"format('{0}{1}{2}', toJSON(github.event.commits.*.added), toJSON(github.event.commits.*.modified), toJSON(github.event.commits.*.removed))";
const depsInputFilters = [
	'"pnpm-lock.yaml',
	'"pnpm-workspace.yaml',
	'".npmrc',
	'".pnpmfile.cjs',
	'package.json"',
	'"patches/',
	'"mise.toml',
	'"mise.lock',
	'"packages/ci-gh-actions/deploy/ci-runner/deps/',
	'"scripts/ci/deps-key.mts',
	'"scripts/lib/deps-key.mts',
];

function filtersFor(job: { if: string }): string[] {
	return [...job.if.matchAll(/contains\(format\(.*?\), '([^']+)'\)/gu)].map(
		(match) => match[1],
	);
}

function matchesFilter(path: string, filter: string): boolean {
	return JSON.stringify(path).includes(filter);
}

describe("CI deps image push scope", () => {
	it("runs only for deps inputs, a runner image build, or a fail-safe push", () => {
		expect(filtersFor(depsJob)).toEqual(depsInputFilters);
		expect(depsJob.if.split(payload)).toHaveLength(depsInputFilters.length + 1);
		expect(depsJob.if).toContain(
			"(github.event_name == 'push' && github.ref == 'refs/heads/main' && (",
		);
		expect(depsJob.if).toContain("needs.ci-runner-image.result == 'success'");
		expect(depsJob.if).toContain("github.event.commits[0] == null");
		expect(depsJob.if).toContain("github.event.forced == true");
		expect(depsJob.if).toContain("github.event_name == 'schedule'");
		expect(depsJob.if).toContain("github.event_name == 'workflow_dispatch'");
		expect(depsJob.if).toContain("github.event_name == 'pull_request'");
	});

	it("covers every file read into the deps key", () => {
		const inputs = new Set([
			...depsContextPaths(root),
			".npmrc",
			".pnpmfile.cjs",
			"mise.lock",
		]);
		for (const path of inputs) {
			expect(
				depsInputFilters.some((filter) => matchesFilter(path, filter)),
				path,
			).toBe(true);
		}
	});

	it("covers every toolchain input directly or by running ci-runner-image", () => {
		const imageFilters = filtersFor(imageJob);
		for (const path of [
			...CI_RUNNER_IMAGE_VERSION_INPUTS,
			"scripts/lib/ci-runner-contract.mts",
		]) {
			expect(
				depsInputFilters.some((filter) => matchesFilter(path, filter)) ||
					imageFilters.length === 0 ||
					imageFilters.some((filter) => matchesFilter(path, filter)),
				path,
			).toBe(true);
		}
	});

	it("does not make Main full gate wait for the deps image", () => {
		expect(mainGate.needs).toBe("ci-runner-image");
		expect(depsJob.needs).toBe("ci-runner-image");
	});
});

describe("exact deps layer matches", () => {
	it("skips install in both gates, verifies sibling links, and installs on misses", () => {
		for (const job of [prGate, mainGate]) {
			const report = job.steps.find(
				(step) => step.name === "Check deps layer match",
			);
			const links = job.steps.find(
				(step) => step.name === "Verify deps layer sibling links",
			);
			const install = job.steps.find(
				(step) => step.name === "Install dependencies",
			);
			expect(report.id).toBe("deps-layer");
			expect(report.run).toContain('echo "match=${match}" >> "$GITHUB_OUTPUT"');
			expect(report.run).toContain('"$expected" != unavailable');
			expect(links.if).toBe("steps.deps-layer.outputs.match == 'true'");
			expect(links.run).toBe(
				"node --import tsx scripts/ensure-ts-autocode-links.mts",
			);
			expect(install.if).toContain("steps.deps-layer.outputs.match != 'true'");
			expect(install.run).toBe(
				"pnpm install --frozen-lockfile --config.confirmModulesPurge=false",
			);
		}
	});

	it("keeps the daily scheduled Main gate as the install verifier", () => {
		expect(workflow.on.schedule).toEqual([{ cron: "17 3 * * *" }]);
		const install = mainGate.steps.find(
			(step) => step.name === "Install dependencies",
		);
		expect(install.if).toContain("github.event_name == 'schedule'");
	});
});
