/**
 * `src/cli/sandbox-provision.ts` (D58): the one code path CI and devices use
 * to provision the pinned runtime and probe the host. Its JSON report and
 * exit code, with the host probes and the self-test replaced by answers.
 */
import { describe, expect, it } from "vitest";
import {
	type ProvisionDeps,
	runSandboxProvision,
} from "../../src/cli/sandbox-provision.js";
import type { HostSetup, SandboxSettings } from "../../src/sandbox/index.js";

const RUNSC = {
	ok: true,
	runtime: {
		name: "runsc",
		path: "/cache/runsc/20261026.0/x86_64/runsc",
		source: "download",
		version: "20261026.0",
		arch: "x86_64",
		digest: "sha512:26e4a327",
	},
} as const;

function deps(
	setup: HostSetup,
	selfTest: ProvisionDeps["selfTest"] = async () => ({
		ok: true,
		cgroups: setup.cgroups.mode,
	}),
) {
	const seen: SandboxSettings[] = [];
	let selfTests = 0;
	const value: ProvisionDeps = {
		platform: "linux",
		env: { HOME: "/home/ci" },
		euid: 1001,
		async probeHost(settings) {
			seen.push(settings);
			return setup;
		},
		async selfTest(probed, settings) {
			selfTests += 1;
			return selfTest(probed, settings);
		},
	};
	return { value, seen, selfTests: () => selfTests };
}

const ROOTLESS_SENTRY: HostSetup = {
	runtime: RUNSC,
	privilege: { mode: "rootless", detail: "runsc do true" },
	cgroups: { mode: "sentry", detail: "no delegation" },
};

describe("runSandboxProvision", () => {
	it("provisions into --cache and reports the runtime and mode, exit 0", async () => {
		const host = deps(ROOTLESS_SENTRY);
		const answer = await runSandboxProvision(
			["--cache", "/runner/tmp/hobo-sandbox"],
			host.value,
		);
		expect(host.seen[0]?.cacheDir).toBe("/runner/tmp/hobo-sandbox");
		expect(host.seen[0]?.hostRuntime).toBeUndefined();
		expect(answer.code).toBe(0);
		expect(JSON.parse(answer.output)).toEqual({
			runtime: "runsc",
			version: "20261026.0",
			arch: "x86_64",
			digest: "sha512:26e4a327",
			mode: "rootless",
			cgroups: "sentry",
		});
		expect(host.selfTests()).toBe(0);
	});

	it("exits 3 with the reason when the runtime cannot be provisioned", async () => {
		const host = deps({
			...ROOTLESS_SENTRY,
			runtime: {
				ok: false,
				reason: "checksum-mismatch",
				detail: "the tarball is not the pinned one",
			},
		});
		const answer = await runSandboxProvision([], host.value);
		expect(answer.code).toBe(3);
		const report = JSON.parse(answer.output);
		expect(report.mode).toBe("unavailable");
		expect(report.runtime).toBe("runsc");
		expect(report.version).toBe("20261026.0");
		expect(report.digest).toBeNull();
		expect(report.reason).toMatch(/^checksum-mismatch: /u);
	});

	it("exits 3 naming the kernel capability when neither root nor a user namespace is available", async () => {
		const host = deps({
			...ROOTLESS_SENTRY,
			privilege: {
				mode: "unavailable",
				reason: "no-root-or-userns",
				detail: "kernel.apparmor_restrict_unprivileged_userns=1",
			},
		});
		const answer = await runSandboxProvision(["--probe"], host.value);
		expect(answer.code).toBe(3);
		const report = JSON.parse(answer.output);
		expect(report.mode).toBe("unavailable");
		expect(report.reason).toBe(
			"no-root-or-userns: kernel.apparmor_restrict_unprivileged_userns=1",
		);
		expect(host.selfTests()).toBe(0);
	});

	it("with --probe, runs the sandbox self-test and reports where limits ended up", async () => {
		const host = deps(
			{
				...ROOTLESS_SENTRY,
				privilege: { mode: "rootful", detail: "root" },
				cgroups: { mode: "delegated", parent: "/hobo-fleet", detail: "root" },
			},
			async () => ({ ok: true, cgroups: "sentry" }),
		);
		const answer = await runSandboxProvision(["--probe"], host.value);
		expect(answer.code).toBe(0);
		expect(JSON.parse(answer.output)).toMatchObject({
			mode: "rootful",
			cgroups: "sentry",
		});
		expect(host.selfTests()).toBe(1);
	});

	it("with --probe, exits 3 when the self-test fails", async () => {
		const host = deps(ROOTLESS_SENTRY, async () => ({
			ok: false,
			reason: "the trial sandbox failed: EPERM",
		}));
		const answer = await runSandboxProvision(["--probe"], host.value);
		expect(answer.code).toBe(3);
		expect(JSON.parse(answer.output)).toMatchObject({
			mode: "unavailable",
			reason: "the trial sandbox failed: EPERM",
		});
	});

	it("is unavailable off Linux, and refuses unknown arguments with exit 2", async () => {
		const host = deps(ROOTLESS_SENTRY);
		const mac = await runSandboxProvision([], {
			...host.value,
			platform: "darwin",
		});
		expect(mac.code).toBe(3);
		expect(JSON.parse(mac.output).reason).toMatch(/linux/iu);
		for (const argv of [["--cache"], ["--nope"]]) {
			const answer = await runSandboxProvision(argv, host.value);
			expect(answer.code, argv.join(" ")).toBe(2);
			expect(answer.output).toMatch(/usage/iu);
		}
	});
});
