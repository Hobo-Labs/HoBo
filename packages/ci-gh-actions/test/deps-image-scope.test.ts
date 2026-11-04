import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..", "..");
const workflow = parse(
	readFileSync(join(root, ".github/workflows/hobo-ci.yml"), "utf8"),
);
const depsJob = workflow.jobs["ci-deps-image"];
const prGate = workflow.jobs["pr-gate"];
const mainGate = workflow.jobs["main-gate"];

describe("CI deps image push scope", () => {
	it("runs on every main push without commit file-list filtering", () => {
		expect(depsJob.if).toContain(
			"(github.event_name == 'push' && github.ref == 'refs/heads/main') ||",
		);
		expect(depsJob.if).not.toContain("github.event.commits");
		expect(depsJob.if).not.toContain("contains(format(");
		expect(depsJob.if).toContain("github.event_name == 'schedule'");
		expect(depsJob.if).toContain("github.event_name == 'workflow_dispatch'");
		expect(depsJob.if).toContain("github.event_name == 'pull_request'");
		expect(depsJob.if).not.toContain("github.event_name == 'merge_group'");
	});

	it("skips resolution and promotion when the local label already matches", () => {
		const names = depsJob.steps.map((step) => step.name);
		expect(names.indexOf("Check current local deps image")).toBe(
			names.indexOf("Compute deps key") + 1,
		);
		const current = depsJob.steps.find(
			(step) => step.name === "Check current local deps image",
		);
		expect(current.run).toContain("docker image inspect hobo-ci-deps:local");
		expect(current.run).toContain("hobo.ci.deps-key");
		expect(current.run).toContain('echo "current=${current}"');
		for (const name of [
			"Resolve local or GHCR deps image",
			"Build deps image and verify offline install",
			"Verify deps image under job mount",
			"Promote verified deps image",
			"Push deps image to GHCR",
		]) {
			const step = depsJob.steps.find((candidate) => candidate.name === name);
			expect(step.if).toContain("steps.current.outputs.current != 'true'");
		}
	});

	it("does not make either gate wait for the deps image", () => {
		expect(mainGate.needs).toBe("ci-runner-image");
		expect(prGate.needs).toBe("ci-runner-image");
		expect(depsJob.needs).toBe("ci-runner-image");
	});
});

describe("exact deps layer matches", () => {
	it("skips install in both gates, verifies sibling links, and installs on misses", () => {
		for (const job of [prGate, mainGate]) {
			const payload = job.steps.find(
				(step) => step.name === "Link deps layer",
			);
			const report = job.steps.find(
				(step) => step.name === "Check deps layer match",
			);
			const links = job.steps.find(
				(step) => step.name === "Verify deps layer sibling links",
			);
			const install = job.steps.find(
				(step) => step.name === "Install dependencies",
			);
			expect(payload.run).toBe(
				"node --experimental-strip-types scripts/ci/deps-layer.mts link",
			);
			expect(report.id).toBe("deps-layer");
			expect(report.run).toBe(
				"node --experimental-strip-types scripts/ci/deps-layer.mts check",
			);
			expect(links.if).toBe("steps.deps-layer.outputs.match == 'true'");
			expect(links.run).toBe(
				"node --import tsx scripts/ensure-ts-autocode-links.mts",
			);
			expect(install.if).toContain("steps.deps-layer.outputs.match != 'true'");
			expect(install.run).toBe(
				"node --experimental-strip-types --no-warnings scripts/ci/pnpm-install.mts --frozen-lockfile --config.confirmModulesPurge=false",
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
