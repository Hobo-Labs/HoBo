import { describe, expect, it } from "vitest";

import {
	classifyFailedJobs,
	isRunnerInfrastructureFailure,
} from "../src/classify.js";
import { parseRegistryDocument } from "../src/parse.js";
import { DEFAULT_REGISTRY_DOCUMENT } from "../src/registry.js";

const REGISTRY = parseRegistryDocument(DEFAULT_REGISTRY_DOCUMENT);

describe("isRunnerInfrastructureFailure", () => {
	it("matches a spending-limit annotation", () => {
		expect(
			isRunnerInfrastructureFailure({
				conclusion: "failure",
				labels: ["ubuntu-latest"],
				texts: [
					"The job was not started because the spending limit for Actions has been reached.",
				],
				startedStepCount: 3,
			}),
		).toBe(true);
	});

	it("treats a failure with zero started steps as a runner pickup failure", () => {
		expect(
			isRunnerInfrastructureFailure({
				conclusion: "failure",
				labels: ["ubuntu-latest"],
				texts: [],
				startedStepCount: 0,
			}),
		).toBe(true);
	});

	it("ignores ordinary build failures", () => {
		expect(
			isRunnerInfrastructureFailure({
				conclusion: "failure",
				labels: ["ubuntu-latest"],
				texts: ["Process completed with exit code 1."],
				startedStepCount: 4,
			}),
		).toBe(false);
	});

	it("ignores non-failure conclusions", () => {
		expect(
			isRunnerInfrastructureFailure({
				conclusion: "cancelled",
				labels: ["ubuntu-latest"],
				texts: ["spending limit"],
				startedStepCount: 0,
			}),
		).toBe(false);
	});
});

describe("classifyFailedJobs", () => {
	it("maps evidence to a provider-wide hard block via runs-on labels", () => {
		const signals = classifyFailedJobs(REGISTRY, [
			{
				conclusion: "failure",
				labels: ["blacksmith-2vcpu-ubuntu-2404"],
				texts: ["No runners matching the requested labels are available."],
				startedStepCount: 0,
			},
		]);
		expect(signals).toHaveLength(1);
		expect(signals[0]?.providerId).toBe("blacksmith");
		expect(signals[0]?.resource).toBe("");
	});

	it("dedupes multiple failed jobs on the same provider", () => {
		const job = {
			conclusion: "failure",
			labels: ["ubuntu-latest"],
			texts: ["spending limit reached"],
			startedStepCount: 0,
		};
		const signals = classifyFailedJobs(REGISTRY, [job, job, job]);
		expect(signals).toHaveLength(1);
		expect(signals[0]?.providerId).toBe("github_hosted");
	});

	it("drops evidence whose labels match no registered provider", () => {
		const signals = classifyFailedJobs(REGISTRY, [
			{
				conclusion: "failure",
				labels: ["some-unknown-runner"],
				texts: ["spending limit reached"],
				startedStepCount: 0,
			},
		]);
		expect(signals).toHaveLength(0);
	});
});
