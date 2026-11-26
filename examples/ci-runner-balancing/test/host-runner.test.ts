import { describe, expect, it } from "vitest";

import {
	pickRunnerAsset,
	registrationTokenPath,
	runnerConfigArgs,
	shouldServeAnotherJob,
} from "../src/host-runner.js";

const ASSETS = [
	{ os: "linux", architecture: "x64", download_url: "u1", filename: "l-x64.tgz" },
	{ os: "linux", architecture: "arm64", download_url: "u2", filename: "l-a64.tgz" },
	{ os: "osx", architecture: "arm64", download_url: "u3", filename: "o-a64.tgz" },
	{ os: "win", architecture: "x64", download_url: "u4", filename: "w-x64.zip" },
];

describe("pickRunnerAsset", () => {
	it("maps linux/x64 and darwin/arm64 onto GitHub's download matrix", () => {
		expect(pickRunnerAsset(ASSETS, "linux", "x64")?.filename).toBe("l-x64.tgz");
		expect(pickRunnerAsset(ASSETS, "darwin", "arm64")?.filename).toBe(
			"o-a64.tgz",
		);
	});

	it("returns undefined for unsupported platforms", () => {
		expect(pickRunnerAsset(ASSETS, "win32", "x64")).toBeUndefined();
		expect(pickRunnerAsset(ASSETS, "linux", "ia32")).toBeUndefined();
	});
});

describe("runnerConfigArgs", () => {
	it("registers ephemeral, unattended, update-disabled with the last-resort label", () => {
		const args = runnerConfigArgs({
			repoUrl: "https://github.com/o/r",
			token: "t",
			name: "n",
			labels: ["hobo-last-resort"],
		});
		expect(args).toContain("--ephemeral");
		expect(args).toContain("--unattended");
		expect(args).toContain("--disableupdate");
		expect(args[args.indexOf("--labels") + 1]).toBe("hobo-last-resort");
	});
});

describe("shouldServeAnotherJob", () => {
	const base = { queued: 0, iteration: 0, maxIterations: 10, once: false };

	it("always serves the first job, even before the queue fills", () => {
		expect(shouldServeAnotherJob(base)).toBe(true);
	});

	it("keeps draining while runs stay queued and stops on an empty queue", () => {
		expect(shouldServeAnotherJob({ ...base, iteration: 3, queued: 2 })).toBe(
			true,
		);
		expect(shouldServeAnotherJob({ ...base, iteration: 3, queued: 0 })).toBe(
			false,
		);
	});

	it("respects --once and the iteration cap", () => {
		expect(shouldServeAnotherJob({ ...base, once: true })).toBe(true);
		expect(
			shouldServeAnotherJob({ ...base, once: true, iteration: 1, queued: 5 }),
		).toBe(false);
		expect(
			shouldServeAnotherJob({ ...base, iteration: 10, queued: 5 }),
		).toBe(false);
	});
});

describe("registrationTokenPath", () => {
	it("targets the repo-scoped registration endpoint", () => {
		expect(registrationTokenPath("o", "r")).toBe(
			"/repos/o/r/actions/runners/registration-token",
		);
	});
});
