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
const prValidation = workflow.jobs.pr_gate_validation;
const workspaceTests = workflow.jobs.workspace_tests;
const prAffected = workflow.jobs.pr_affected;
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
		expect(login.if).not.toContain("env.GHCR_TOKEN");
		expect(login.if).toContain("steps.scope.outputs.run == 'true'");
		expect(login.if).toContain("steps.current.outputs.current != 'true'");
		const resolve = depsJob.steps.find(
			(step) => step.name === "Resolve local or GHCR deps image",
		);
		expect(login.env.GHCR_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
		expect(login.run).toContain("docker login ghcr.io");
		expect(login.run).toContain("--password-stdin");
		expect(depsJob.steps.indexOf(login)).toBe(
			depsJob.steps.indexOf(resolve) - 1,
		);
	});

	it("publishes from a separate bounded workflow on the same runner labels", () => {
		expect(publisher.on.workflow_run).toEqual({
			workflows: ["HoBo CI Fabric"],
			types: ["completed"],
			branches: ["main"],
		});
		expect(publisher.on.workflow_dispatch).toBeNull();
		const job = publisher.jobs.publish;
		// Per job, so the worker image build is never cancelled with it. Keyed by
		// the CI run's conclusion (finding 113): a skipped completion must not
		// cancel a publish a green run started.
		expect(publisher.concurrency).toBeUndefined();
		expect(job.concurrency).toEqual({
			group:
				"ci-deps-publish-${{ github.repository }}-${{ github.event.workflow_run.conclusion || 'dispatch' }}",
			"cancel-in-progress": true,
		});
		expect(job["timeout-minutes"]).toBe(20);
		// The publisher pushes the fleet's own image and the deps job builds
		// it in the box's Docker context, so neither is routed: both ask for
		// the fleet's label.
		expect(depsJob["runs-on"]).toBe(job["runs-on"]);
		expect(depsJob["runs-on"]).not.toContain("needs.route.outputs.runner");
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

	it("publishes the worker image after a green main run when GHCR lacks it", () => {
		// Finding 113: a dropped main push's image change is built by no later
		// push, and release jobs on ARC pull the worker from GHCR.
		const job = publisher.jobs["runner-image"];
		expect(job.if).toContain(
			"github.event.workflow_run.conclusion == 'success'",
		);
		expect(job.concurrency["cancel-in-progress"]).toBe(false);
		expect(job["runs-on"]).toBe(publisher.jobs.publish["runs-on"]);
		expect(job.permissions).toEqual({ contents: "read", packages: "write" });
		expect(job.steps[0].with.ref).toContain(
			"github.event.workflow_run.head_sha",
		);
		const named = (name: string) =>
			job.steps.find((step: { name?: string }) => step.name === name);
		expect(named("Ask GHCR for this commit's worker image").run).toBe(
			"node --no-warnings scripts/ci/ensure-ci-worker-image.mts --published-status",
		);
		const build = named(
			"Build the worker image from this commit and publish it",
		);
		expect(build.if).toBe("steps.status.outputs.ghcr != 'true'");
		// Never publish an image a pull request left under this tag on the box:
		// force the untag, and stop if the tag survives.
		expect(build.run).toContain('docker image rm -f "$tag"');
		expect(build.run.indexOf("docker image rm -f")).toBeLessThan(
			build.run.indexOf("ensure-ci-worker-image.mts"),
		);
		expect(build.run).toContain("Worker image tag still present");
		// A cold build outlasts ensure-ci-worker-image's 10-minute default.
		expect(build.env.HOBO_CI_WORKER_BUILD_BUDGET_SEC).toBe("1500");
		// The deps build waits, so it pulls the image instead of racing build.sh.
		expect(publisher.jobs.publish.needs).toEqual(["runner-image"]);
		expect(publisher.jobs.publish.if).toMatch(
			/^!cancelled\(\) && needs\.runner-image\.result != 'cancelled' &&/u,
		);
		expect(build.run).toContain("HOBO_CI_SKIP_GHCR_PULL=1");
		expect(named("Fail unless GHCR now has it").run).toContain("ghcr=true");
	});

	it("does not make either gate wait for the deps image", () => {
		expect(mainGate.needs).toEqual(["ci-runner-image"]);
		expect(prValidation.needs).toEqual(["route", "ci-runner-image"]);
		expect(prGate.needs).toEqual([
			"route",
			"pr_gate_validation",
			"workspace_tests",
			"pr_affected",
		]);
		expect(workspaceTests.needs).toEqual(["route", "pr_gate_validation"]);
		expect(prAffected.needs).toEqual(["route", "pr_gate_validation"]);
		expect(mainGate.needs).not.toContain("ci-deps-image");
		expect(prValidation.needs).not.toContain("ci-deps-image");
		expect(prGate.needs).not.toContain("ci-deps-image");
		// The deps job is not routed: it builds in the box's Docker context and
		// starts from route so it can overlap runner image materialize (#1872).
		expect(depsJob.needs).toEqual(["route"]);
	});
});

describe("exact deps layer matches", () => {
	it("skips install on a matching deps layer in every test job", () => {
		for (const job of [prValidation, workspaceTests, prAffected, mainGate]) {
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
