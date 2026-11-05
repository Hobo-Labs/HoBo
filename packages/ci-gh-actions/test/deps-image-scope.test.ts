import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..", "..");
const workflow = parse(
	readFileSync(join(root, ".github/workflows/hobo-ci.yml"), "utf8"),
);
const publisher = parse(
	readFileSync(join(root, ".github/workflows/ci-deps-publish.yml"), "utf8"),
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

	it("skips resolution, promotion and building when the local label already matches", () => {
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
		]) {
			const step = depsJob.steps.find((candidate) => candidate.name === name);
			expect(step.if).toContain("steps.current.outputs.current != 'true'");
		}
	});

	it("keeps all registry writes out of HoBo CI", () => {
		expect(depsJob.permissions).toEqual({
			contents: "read",
			packages: "read",
		});
		expect(JSON.stringify(depsJob)).not.toContain("docker push");
		expect(JSON.stringify(depsJob)).not.toContain("--cache-to");
	});

	it("logs in for the read-only cache only when a token exists", () => {
		const login = depsJob.steps.find(
			(step) => step.name === "Login to GHCR for read-only cache",
		);
		const build = depsJob.steps.find(
			(step) => step.name === "Build deps image and verify offline install",
		);
		expect(login.if).not.toContain("env.GHCR_TOKEN");
		expect(login.if).toContain("steps.source.outputs.source == 'build'");
		expect(login.env.GHCR_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
		expect(login.run).toContain("docker login ghcr.io");
		expect(login.run).toContain("--password-stdin");
		expect(depsJob.steps.indexOf(login)).toBe(depsJob.steps.indexOf(build) - 1);
	});

	it("publishes from a separate bounded workflow on the same runner labels", () => {
		expect(publisher.on.workflow_run).toEqual({
			workflows: ["HoBo CI Fabric"],
			types: ["completed"],
			branches: ["main"],
		});
		expect(publisher.on.workflow_dispatch).toBeNull();
		expect(publisher.concurrency).toEqual({
			group: "ci-deps-publish-${{ github.repository }}",
			"cancel-in-progress": true,
		});
		const job = publisher.jobs.publish;
		expect(job["timeout-minutes"]).toBe(5);
		expect(job["runs-on"]).toBe(depsJob["runs-on"]);
		expect(job.permissions).toEqual({ contents: "read", packages: "write" });
		expect(job.if).toContain(
			"github.event.workflow_run.conclusion == 'success'",
		);
		expect(job.steps[0].with.ref).toContain(
			"github.event.workflow_run.head_sha",
		);
		expect(job.steps[1].run).toBe(
			"bash packages/ci-gh-actions/deploy/ci-runner/deps/publish-deps.sh",
		);
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
			const payload = job.steps.find((step) => step.name === "Link deps layer");
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
