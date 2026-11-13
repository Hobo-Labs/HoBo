/**
 * O42 (design §6.11 `S1_CONTAINER`): every container the box worker starts
 * has all capabilities dropped, `no-new-privileges`, a pids limit, a
 * read-only root with writable scratch only, and the host Docker socket only
 * when the fleet sets `allow_host_docker` on a `DEDICATED` device. Nothing here
 * names a host OCI runtime (`crun`, `runc`, `podman`) or `nsenter`.
 */
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { DeviceClass, FleetPolicySchema, FleetRecordSchema } from "@hobo/fleet";
import { afterEach, describe, expect, it } from "vitest";
import { createCliDockerDriver } from "../src/isolated-worker/cli-docker-driver.js";
import {
	DEFAULT_PIDS_LIMIT,
	hardenedContainerFlags,
	hostDockerAllowed,
} from "../src/isolated-worker/container-flags.js";

const CONTAINER_ID = "c".repeat(64);
const SOCKET = "/var/run/docker.sock:/var/run/docker.sock";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

/** A `docker` that records each invocation's argv, one per line, and prints a container id. */
function fakeDocker() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-container-flags-"));
	directories.push(directory);
	const binary = join(directory, "docker");
	const record = join(directory, "calls");
	writeFileSync(record, "");
	writeFileSync(
		binary,
		`#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a" >> "${record}"; done\nprintf '\\n' >> "${record}"\nprintf '%s\\n' '${CONTAINER_ID}'\n`,
	);
	chmodSync(binary, 0o755);
	return {
		binary,
		calls: () =>
			readFileSync(record, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => line.split("\u001f").filter((arg) => arg.length > 0)),
	};
}

function expectHardened(argv: readonly string[]): void {
	expect(argv).toContain("--cap-drop=ALL");
	expect(argv).toContain("--security-opt=no-new-privileges:true");
	expect(argv).toContain(`--pids-limit=${DEFAULT_PIDS_LIMIT}`);
	expect(argv).toContain("--read-only");
	expect(argv.some((arg) => arg.startsWith("--tmpfs=/tmp:"))).toBe(true);
	expect(argv).not.toContain("--privileged");
	expect(argv.some((arg) => /seccomp=unconfined/u.test(arg))).toBe(false);
	for (const runtime of ["crun", "runc", "podman", "nsenter"])
		expect(argv.join(" ")).not.toMatch(new RegExp(`\\b${runtime}\\b`, "u"));
}

const spec = {
	name: "hobo-lease-1",
	image: "hobo-ci-deps:local",
	timeoutMs: 60_000,
	env: { A: "1" },
	command: ["sleep", "infinity"],
	runAsUser: "1000:1000",
	memoryMb: 1024,
	cpuShares: 512,
} as const;

describe("hardenedContainerFlags", () => {
	it("drops every capability, forbids new privileges, limits pids and keeps the root read-only", () => {
		const flags = hardenedContainerFlags({});
		expectHardened(flags);
		// Writable state is scratch the container owns, never a host path.
		expect(flags).toContain("--mount=type=volume,target=/opt/actions-runner");
		expect(flags).toContain("--mount=type=volume,target=/home/runner");
	});

	it("takes an explicit pids limit and CPU cap", () => {
		const flags = hardenedContainerFlags({ pidsLimit: 256, cpus: 2 });
		expect(flags).toContain("--pids-limit=256");
		expect(flags).toContain("--cpus=2");
	});

	it("refuses a pids limit that is not a positive integer", () => {
		expect(() => hardenedContainerFlags({ pidsLimit: 0 })).toThrow(
			/pids limit/u,
		);
		expect(() => hardenedContainerFlags({ cpus: -1 })).toThrow(/cpu/iu);
	});
});

describe("hostDockerAllowed", () => {
	const fleet = (allowHostDocker: boolean) =>
		create(FleetRecordSchema, {
			fleetId: "hobo",
			policy: create(FleetPolicySchema, { allowHostDocker }),
		});

	it("allows the host socket only on a DEDICATED device of a fleet that sets allow_host_docker", () => {
		expect(hostDockerAllowed(fleet(true), DeviceClass.DEDICATED)).toBe(true);
		expect(hostDockerAllowed(fleet(false), DeviceClass.DEDICATED)).toBe(false);
		expect(hostDockerAllowed(fleet(true), DeviceClass.PERSONAL)).toBe(false);
		expect(hostDockerAllowed(fleet(true), DeviceClass.EPHEMERAL)).toBe(false);
		expect(hostDockerAllowed(undefined, DeviceClass.DEDICATED)).toBe(false);
	});
});

describe("every container the worker starts", () => {
	it("is created hardened and without the host Docker socket by default", async () => {
		const docker = fakeDocker();
		const driver = createCliDockerDriver({
			binary: docker.binary,
			env: {},
			socketGid: () => 998,
		});
		await driver.create(spec);
		const [argv] = docker.calls();
		expect(argv?.[0]).toBe("create");
		expectHardened(argv ?? []);
		expect(argv).not.toContain(SOCKET);
	});

	it("mounts the host Docker socket only while the fleet allows it", async () => {
		const docker = fakeDocker();
		let allowed = true;
		const driver = createCliDockerDriver({
			binary: docker.binary,
			env: {},
			hostDocker: () => allowed,
			socketGid: () => 998,
		});
		await driver.create(spec);
		allowed = false;
		await driver.create({ ...spec, name: "hobo-lease-2" });
		const [withSocket, without] = docker.calls();
		expectHardened(withSocket ?? []);
		expect(withSocket).toContain(SOCKET);
		expect(withSocket).toContain("--group-add");
		expectHardened(without ?? []);
		expect(without).not.toContain(SOCKET);
	});

	it("keeps an environment override from re-enabling the socket", async () => {
		const docker = fakeDocker();
		const driver = createCliDockerDriver({
			binary: docker.binary,
			env: { HOBO_CI_MOUNT_DOCKER_SOCKET: "1" },
			socketGid: () => 998,
		});
		await driver.create(spec);
		expect(docker.calls()[0]).not.toContain(SOCKET);
	});

	it("probes images in a hardened container too", async () => {
		const docker = fakeDocker();
		const driver = createCliDockerDriver({ binary: docker.binary, env: {} });
		await driver.probeImage?.("hobo-ci-deps:local", ["true"], "1000:1000");
		const [argv] = docker.calls();
		expect(argv?.[0]).toBe("run");
		expectHardened(argv ?? []);
		expect(argv).not.toContain(SOCKET);
	});
});
