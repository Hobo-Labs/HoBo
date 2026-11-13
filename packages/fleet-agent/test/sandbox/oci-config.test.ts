/**
 * The `S1` flag set of design §6.11 in the OCI configuration every OCI
 * sandbox starts from.
 */
import { describe, expect, it } from "vitest";
import {
	DOCKER_SOCKET,
	ID_RANGE,
	ociConfig,
	ROOTFUL_ID_BASE,
	WORK_DIRS,
} from "../../src/sandbox/oci-config.js";
import { REFUSED_SYSCALLS } from "../../src/sandbox/seccomp.js";

const base = {
	id: "hobo-test",
	rootfs: "/images/busybox",
	limits: { memoryMb: 512, cpus: 1.5, pids: 128, diskMb: 1024 },
	readOnlyMounts: [{ source: "/srv/cache", target: "/cache" }],
	hostDocker: false,
	rootless: { uid: 1001, gid: 1002 },
	args: ["sleep", "2147483647"],
	env: ["PATH=/usr/bin:/bin"],
};

describe("ociConfig", () => {
	const config = ociConfig(base);

	it("drops every capability and sets no-new-privileges", () => {
		const caps = config.process.capabilities;
		expect([
			...caps.bounding,
			...caps.effective,
			...caps.permitted,
			...caps.inheritable,
			...caps.ambient,
		]).toEqual([]);
		expect(config.process.noNewPrivileges).toBe(true);
	});

	it("applies the default seccomp profile", () => {
		const refused = config.linux.seccomp.syscalls.flatMap((rule) => rule.names);
		for (const name of [
			"mount",
			"unshare",
			"setns",
			"ptrace",
			"bpf",
			"keyctl",
			"clone3",
		])
			expect(refused).toContain(name);
		expect(REFUSED_SYSCALLS).not.toContain("clone");
		expect(
			config.linux.seccomp.syscalls.filter((rule) =>
				rule.names.includes("clone"),
			).length,
		).toBe(8);
	});

	it("limits pids, memory and CPU", () => {
		expect(config.linux.resources.pids.limit).toBe(128);
		expect(config.linux.resources.memory).toEqual({
			limit: 512 * 1024 * 1024,
			swap: 512 * 1024 * 1024,
		});
		expect(config.linux.resources.cpu).toEqual({
			quota: 150_000,
			period: 100_000,
		});
		expect(config.linux.cgroupsPath).toBe("/hobo-fleet/hobo-test");
	});

	it("has a read-only root, tmpfs work directories and only the declared host mount", () => {
		expect(config.root).toEqual({ path: "/images/busybox", readonly: true });
		for (const dir of WORK_DIRS)
			expect(
				config.mounts.find((mount) => mount.destination === dir)?.type,
			).toBe("tmpfs");
		const binds = config.mounts.filter((mount) => mount.type === "bind");
		expect(binds).toEqual([
			{
				destination: "/cache",
				type: "bind",
				source: "/srv/cache",
				options: ["rbind", "ro", "nosuid", "nodev"],
			},
		]);
		expect(
			config.mounts.some((mount) => mount.destination === DOCKER_SOCKET),
		).toBe(false);
	});

	it("gives the sandbox its own network, pid, mount, ipc, uts, cgroup and user namespaces", () => {
		expect(config.linux.namespaces.map((entry) => entry.type).sort()).toEqual([
			"cgroup",
			"ipc",
			"mount",
			"network",
			"pid",
			"user",
			"uts",
		]);
	});

	it("maps the sandbox's root to the invoking user when rootless", () => {
		expect(config.linux.uidMappings).toEqual([
			{ containerID: 0, hostID: 1001, size: 1 },
		]);
		expect(config.linux.gidMappings).toEqual([
			{ containerID: 0, hostID: 1002, size: 1 },
		]);
	});

	it("maps the sandbox's ids to a reserved high range, and idmaps declared mounts, when rootful", () => {
		const rootful = ociConfig({ ...base, rootless: undefined });
		expect(rootful.linux.uidMappings).toEqual([
			{ containerID: 0, hostID: ROOTFUL_ID_BASE, size: ID_RANGE },
		]);
		expect(ROOTFUL_ID_BASE + ID_RANGE).toBeLessThanOrEqual(2 ** 31);
		expect(
			rootful.mounts.find((mount) => mount.destination === "/cache")?.options,
		).toContain("idmap");
	});

	it("binds the host Docker socket only when asked", () => {
		const withDocker = ociConfig({ ...base, hostDocker: true });
		expect(
			withDocker.mounts.find((mount) => mount.destination === DOCKER_SOCKET)
				?.source,
		).toBe(DOCKER_SOCKET);
	});
});
