/**
 * What `sandboxDrivers` builds on Linux (D58): the provisioned runsc for
 * `S1` and `S2` by default, a host runc or crun only when an operator
 * configures one, and `hobo_fleet_sandbox_unavailable` with the reason when
 * nothing qualifies. Probing is replaced by its answers; no runtime runs.
 */
import { type FleetLog, SandboxTier } from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import {
	type HostSetup,
	linuxCandidates,
	runscFlags,
	sandboxSettings,
} from "../../src/sandbox/index.js";
import type { OciCalls } from "../../src/sandbox/oci-runtime.js";

type Made = { binary: string; flags: readonly string[] };

function build(setup: HostSetup) {
	const made: Made[] = [];
	const logged: Parameters<FleetLog>[1][] = [];
	const log: FleetLog = (event, fields) => {
		if (event === "hobo_fleet_sandbox_unavailable") logged.push(fields);
	};
	const drivers = linuxCandidates(setup, {
		log,
		run: "/run/hobo-test",
		images: { rootfs: async () => "/nonexistent" },
		makeCalls(binary, _stateRoot, flags): OciCalls {
			made.push({ binary, flags });
			const fail = async () => {
				throw new Error("not in this test");
			};
			return {
				version: fail,
				start: fail,
				exec: fail,
				forward: fail,
				remove: fail,
			};
		},
	});
	return { drivers, made, logged };
}

const RUNSC = {
	ok: true,
	runtime: {
		name: "runsc",
		path: "/cache/runsc/20261026.0/x86_64/runsc",
		source: "cache",
		version: "20261026.0",
		arch: "x86_64",
		digest: "sha512:abc",
	},
} as const;
const ROOTLESS = { mode: "rootless", detail: "trial ok" } as const;
const SENTRY = { mode: "sentry", detail: "no delegation" } as const;
const DELEGATED = {
	mode: "delegated",
	parent: "/hobo-fleet",
	detail: "root",
} as const;

const tiers = (drivers: readonly { tier: SandboxTier }[]) =>
	drivers.map((driver) => SandboxTier[driver.tier]);

describe("runscFlags", () => {
	it("gives runsc a loopback-only network, host socket connects for the forwarder, and OCI seccomp", () => {
		const flags = runscFlags(DELEGATED);
		expect(flags).toContain("--network=none");
		expect(flags).toContain("--host-uds=open");
		expect(flags).toContain("--oci-seccomp");
		expect(flags).not.toContain("--ignore-cgroups");
	});

	it("ignores cgroups when they are not delegated, so the sentry enforces limits", () => {
		expect(runscFlags(SENTRY)).toContain("--ignore-cgroups");
	});
});

describe("linuxCandidates", () => {
	it("serves S1 and S2 from the provisioned runsc, sentry-limited without delegation", () => {
		const { drivers, made, logged } = build({
			runtime: RUNSC,
			privilege: ROOTLESS,
			cgroups: SENTRY,
		});
		expect(tiers(drivers)).toEqual([
			"S1_CONTAINER",
			"S2_USER_KERNEL",
			"S3_MICROVM",
		]);
		expect(made).toEqual([
			{ binary: RUNSC.runtime.path, flags: runscFlags(SENTRY) },
		]);
		expect(logged).toEqual([]);
	});

	it("tries runsc with delegated cgroups first, then sentry-limited", () => {
		const { drivers, made } = build({
			runtime: RUNSC,
			privilege: { mode: "rootful", detail: "root" },
			cgroups: DELEGATED,
		});
		expect(tiers(drivers)).toEqual([
			"S1_CONTAINER",
			"S2_USER_KERNEL",
			"S1_CONTAINER",
			"S2_USER_KERNEL",
			"S3_MICROVM",
		]);
		expect(made.map((entry) => entry.flags)).toEqual([
			runscFlags(DELEGATED),
			runscFlags({ mode: "sentry" }),
		]);
	});

	it("uses an operator's host runc or crun for S1 only, and only with delegated cgroups", () => {
		for (const name of ["crun", "runc"] as const) {
			const host = {
				ok: true,
				runtime: {
					name,
					path: `/opt/bin/${name}`,
					source: "host",
					version: "",
					arch: "x86_64",
					digest: undefined,
				},
			} as const;
			const delegated = build({
				runtime: host,
				privilege: ROOTLESS,
				cgroups: DELEGATED,
			});
			expect(tiers(delegated.drivers)).toEqual(["S1_CONTAINER", "S3_MICROVM"]);
			expect(delegated.made).toEqual([
				{ binary: `/opt/bin/${name}`, flags: [] },
			]);

			const sentry = build({
				runtime: host,
				privilege: ROOTLESS,
				cgroups: SENTRY,
			});
			expect(tiers(sentry.drivers)).toEqual(["S3_MICROVM"]);
			expect(sentry.made).toEqual([]);
			expect(JSON.stringify(sentry.logged)).toMatch(/cgroup/u);
		}
	});

	it("logs hobo_fleet_sandbox_unavailable with the reason when no runtime is provisioned", () => {
		const { drivers, made, logged } = build({
			runtime: {
				ok: false,
				reason: "checksum-mismatch",
				detail: "the tarball's SHA-512 is not the pin",
			},
			privilege: ROOTLESS,
			cgroups: SENTRY,
		});
		expect(tiers(drivers)).toEqual(["S3_MICROVM"]);
		expect(made).toEqual([]);
		expect(logged).toEqual([
			{
				tier: "S1_CONTAINER,S2_USER_KERNEL",
				runtime: "runsc",
				reason: expect.stringContaining("checksum-mismatch"),
			},
		]);
	});

	it("logs no-root-or-userns when neither root nor a user namespace is available", () => {
		const { drivers, made, logged } = build({
			runtime: RUNSC,
			privilege: {
				mode: "unavailable",
				reason: "no-root-or-userns",
				detail: "kernel.unprivileged_userns_clone=0",
			},
			cgroups: SENTRY,
		});
		expect(tiers(drivers)).toEqual(["S3_MICROVM"]);
		expect(made).toEqual([]);
		expect(logged).toEqual([
			{
				tier: "S1_CONTAINER,S2_USER_KERNEL",
				runtime: "runsc",
				reason: expect.stringContaining("no-root-or-userns"),
			},
		]);
	});
});

describe("sandboxSettings", () => {
	it("reads the operator's host runtime, cache directory and download switch", () => {
		expect(
			sandboxSettings(
				{
					HOBO_FLEET_SANDBOX_RUNTIME: "/usr/bin/crun",
					HOBO_FLEET_SANDBOX_CACHE: "/tmp/cache",
					HOBO_FLEET_SANDBOX_DOWNLOAD: "0",
				},
				1000,
			),
		).toEqual({
			hostRuntime: "/usr/bin/crun",
			cacheDir: "/tmp/cache",
			allowDownload: false,
		});
	});

	it("never takes a runtime from PATH: no host runtime unless configured", () => {
		const settings = sandboxSettings(
			{ HOME: "/home/a", PATH: "/usr/bin" },
			1000,
		);
		expect(settings.hostRuntime).toBeUndefined();
		expect(settings.allowDownload).toBe(true);
		expect(settings.cacheDir).toBe("/home/a/.cache/hobo-fleet");
		expect(sandboxSettings({}, 0).cacheDir).toBe("/var/lib/hobo-fleet");
		expect(
			sandboxSettings({ XDG_CACHE_HOME: "/xdg", HOME: "/home/a" }, 1000)
				.cacheDir,
		).toBe("/xdg/hobo-fleet");
	});
});
