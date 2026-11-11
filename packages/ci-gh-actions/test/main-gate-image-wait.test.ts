import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
	readFileSync(
		new URL("../../../.github/workflows/hobo-ci.yml", import.meta.url),
		"utf8",
	),
);
const imageJob = workflow.jobs["ci-runner-image"];
const mainGate = workflow.jobs["main-gate"];
const mainFinish = workflow.jobs["main_gate_finish"];
const imageInputPrefixes = [
	"mise.toml",
	"mise.lock",
	"packages/ci-gh-actions/deploy/ci-runner/",
	"scripts/lib/ci-runner-contract.mts",
	"scripts/ci-runner-preflight.mts",
	"scripts/test/ci-runner-image-contract.test.ts",
];

describe("Main full gate image dependency", () => {
	it("keeps the push condition and Detect regex on the same image-input paths", () => {
		const containsPaths = [
			...imageJob.if.matchAll(/contains\(format\(.*?\), '"([^']+)'\)/gu),
		].map((match) => match[1]);
		expect(containsPaths).toEqual(imageInputPrefixes);

		const detect = imageJob.steps.find(
			(step) => step.name === "Detect runner image inputs changed",
		);
		const pattern = detect.run.match(/if grep -qE \\\n\s+'([^']+)'/u)?.[1];
		expect(pattern).toBe(
			"^(mise\\.(toml|lock)|packages/ci-gh-actions/deploy/ci-runner/|scripts/(lib/ci-runner-contract\\.mts|ci-runner-preflight\\.mts|test/ci-runner-image-contract\\.test\\.ts))",
		);
		const detectRegex = new RegExp(pattern);
		for (const path of imageInputPrefixes) {
			expect(detectRegex.test(path), path).toBe(true);
		}

		const payload =
			"format('{0}{1}{2}', toJSON(github.event.commits.*.added), toJSON(github.event.commits.*.modified), toJSON(github.event.commits.*.removed))";
		expect(imageJob.if.split(payload)).toHaveLength(
			imageInputPrefixes.length + 1,
		);
		expect(imageJob.if).toContain("github.event_name != 'merge_group'");
		expect(imageJob.if).toContain("github.event_name != 'push'");
		expect(imageJob.if).toContain("github.event.commits[0] == null");
		expect(imageJob.if).toContain("github.event.forced == true");
	});

	it("covers every ciRunnerImageVersion input", () => {
		const versionInputs = [
			"mise.lock",
			"mise.toml",
			"packages/ci-gh-actions/deploy/ci-runner/system-packages.txt",
			"packages/ci-gh-actions/deploy/ci-runner/base/Dockerfile",
			"packages/ci-gh-actions/deploy/ci-runner/build.sh",
		];
		for (const input of versionInputs) {
			expect(
				imageInputPrefixes.some((prefix) => input.startsWith(prefix)),
				input,
			).toBe(true);
		}
	});

	it("runs full-history secret scans in main_gate_finish, never the image job", () => {
		const mainNames = mainGate.steps.map((step) => step.name);
		const finishNames = mainFinish.steps.map((step) => step.name);
		const imageNames = imageJob.steps.map((step) => step.name);
		const checkout = "Checkout (sparse S0, full history)";
		const wait = "Secret scan (full history)";
		const checkoutIndex = mainGate.steps.findIndex(
			(step) =>
				step.name === checkout &&
				step.uses === "./.github/actions/hobo-checkout",
		);
		const preflightIndex = mainGate.steps.findIndex(
			(step) => step.uses === "./.github/actions/ci-runner-preflight",
		);
		expect(checkoutIndex).toBeGreaterThanOrEqual(0);
		expect(preflightIndex).toBe(checkoutIndex + 1);
		expect(mainNames).not.toContain(wait);
		expect(mainNames).not.toContain("Workspace tests");
		expect(finishNames).toContain(wait);
		const waitStep = mainFinish.steps.find((step) => step.name === wait);
		expect(waitStep?.run).toContain("gitleaks-main-scan.mts --background");
		expect(waitStep?.run).toContain("gitleaks-main-scan.mts --wait");
		expect(imageNames).not.toContain(wait);
		expect(imageJob.steps[0].with["fetch-depth"]).toBe(2);
	});

	it("still builds the image before main-gate when image inputs change", () => {
		expect(mainGate.needs).toEqual(["ci-runner-image"]);
		expect(mainGate.if).toContain("!cancelled()");
	});
});
