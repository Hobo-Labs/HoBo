/**
 * The `S1` flag set of design §6.11 in the OCI configuration every OCI
 * sandbox starts from.
 */
import { describe, expect, it } from "vitest";
import {
	DOCKER_SOCKET,
	FORWARDER_HOST_UID,
	forwarderConfig,
	forwarderHostUid,
	forwarderUid,
	hostPidsBackstop,
	ID_RANGE,
	ociConfig,
	POD_CONTAINER_TYPE,
	POD_SANDBOX_ID,
	ROOTFUL_ID_BASE,
	sandboxRlimits,
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

describe("ociConfig under runsc (D58)", () => {
	const runsc = { ...base, flavor: "runsc" as const };

	it("puts the workload in its forwarder's pod, as a container (so in a pid namespace below the forwarder's)", () => {
		expect(ociConfig({ ...runsc, pod: "hobofwd-test" }).annotations).toEqual({
			[POD_CONTAINER_TYPE]: "container",
			[POD_SANDBOX_ID]: "hobofwd-test",
		});
		expect(ociConfig(base).annotations).toEqual({});
	});

	it("caps the process count inside the sentry with RLIMIT_NPROC, in every process", () => {
		const config = ociConfig(runsc);
		expect(config.process.rlimits).toContainEqual({
			type: "RLIMIT_NPROC",
			hard: 128,
			soft: 128,
		});
		// A host runtime counts RLIMIT_NPROC per host uid, which every rootful sandbox shares.
		expect(
			ociConfig(base).process.rlimits.map((limit) => limit.type),
		).not.toContain("RLIMIT_NPROC");
	});

	it("names no cgroup in sentry mode, where runsc would still write one for a sub-container", () => {
		expect(
			ociConfig({ ...runsc, cgroups: { mode: "sentry" } }).linux.cgroupsPath,
		).toBe("");
		expect(
			ociConfig({ ...base, cgroups: { mode: "sentry" } }).linux.cgroupsPath,
		).toBe("/hobo-fleet/hobo-test");
	});

	it("places the sandbox's cgroup under the delegated parent", () => {
		const config = ociConfig({
			...runsc,
			cgroups: { mode: "delegated", parent: "/user.slice/app.slice" },
		});
		expect(config.linux.cgroupsPath).toBe("/user.slice/app.slice/hobo-test");
	});

	it("bounds each process's address space by the memory limit when the sentry enforces limits", () => {
		const limits = sandboxRlimits(base.limits, "runsc", { mode: "sentry" });
		expect(limits).toContainEqual({
			type: "RLIMIT_AS",
			hard: 512 * 1024 * 1024,
			soft: 512 * 1024 * 1024,
		});
		expect(
			sandboxRlimits(base.limits, "runsc", {
				mode: "delegated",
				parent: "/hobo-fleet",
			}).map((limit) => limit.type),
		).not.toContain("RLIMIT_AS");
		expect(
			ociConfig({ ...runsc, cgroups: { mode: "sentry" } }).process.rlimits,
		).toEqual(limits);
	});
});

describe("forwarderConfig (D58: the forwarder is a second container, no host namespace tool)", () => {
	const routes = [
		{ port: 20001, socket: "/run/hobo/sandbox/hobo-test/sock/egress.sock" },
		{ port: 20002, socket: "/run/hobo/sandbox/hobo-test/sock/control.sock" },
	];
	const input = {
		id: "hobofwd-test",
		limits: base.limits,
		socketDir: "/run/hobo/sandbox/hobo-test/sock",
		routes,
		node: "/usr/bin/node",
		script: "console.log('ready')",
		workloadPid: 4242,
		rootless: { uid: 1001, gid: 1002 },
	};

	it("runs the host's node from the host root, read-only, with only the socket directory bound", () => {
		const config = forwarderConfig({ ...input, flavor: "runsc" });
		expect(config.root).toEqual({ path: "/", readonly: true });
		expect(config.process.args).toEqual([
			"/usr/bin/node",
			"-e",
			"console.log('ready')",
			JSON.stringify(routes),
		]);
		const binds = config.mounts.filter((mount) => mount.type === "bind");
		expect(binds).toEqual([
			{
				destination: "/run/hobo/sandbox/hobo-test/sock",
				type: "bind",
				source: "/run/hobo/sandbox/hobo-test/sock",
				options: ["rbind", "ro", "nosuid", "nodev"],
			},
		]);
		expect(config.process.noNewPrivileges).toBe(true);
		expect(config.process.env.join(" ")).not.toMatch(/proxy/iu);
	});

	it("under runsc, is the pod's sandbox container, sized for the workload too, as a uid the workload cannot signal", () => {
		const config = forwarderConfig({ ...input, flavor: "runsc" });
		expect(config.annotations).toEqual({
			[POD_CONTAINER_TYPE]: "sandbox",
			[POD_SANDBOX_ID]: "hobofwd-test",
		});
		// The pod's cgroup, when delegated, holds the workload and the forwarder.
		expect(config.linux.resources.memory.limit).toBe((512 + 256) * 1024 * 1024);
		// The pids limit holds in the sentry (RLIMIT_NPROC); the host cgroup only backstops it.
		expect(config.linux.resources.pids.limit).toBe(hostPidsBackstop(128 + 64));
		expect(hostPidsBackstop(128)).toBeGreaterThan(2 * 128);
		const caps = config.process.capabilities;
		expect([
			...caps.bounding,
			...caps.effective,
			...caps.permitted,
			...caps.inheritable,
			...caps.ambient,
		]).toEqual([]);
		expect(config.linux.namespaces.map((entry) => entry.type)).toContain("pid");
		expect(
			config.linux.namespaces.every((entry) => entry.path === undefined),
		).toBe(true);
		expect(config.linux.uidMappings).toEqual([
			{ containerID: 0, hostID: 1001, size: 1 },
		]);
	});

	it("runs as a uid the workload cannot signal, owning its sockets on the host", () => {
		// Rootful: a host uid of its own (runsc's gofer connects to a host socket as the caller's uid).
		const rootful = forwarderConfig({
			...input,
			flavor: "runsc",
			rootless: undefined,
		});
		expect(rootful.process.user).toEqual({
			uid: FORWARDER_HOST_UID,
			gid: FORWARDER_HOST_UID,
		});
		expect(forwarderHostUid(undefined)).toBe(FORWARDER_HOST_UID);
		expect(FORWARDER_HOST_UID).toBeLessThan(ROOTFUL_ID_BASE);
		expect(FORWARDER_HOST_UID).toBeGreaterThan(65_535);
		// Rootless: only the agent's id is mapped; a pid namespace the workload cannot see keeps it out of reach.
		expect(forwarderUid(input.rootless)).toBe(0);
		expect(forwarderHostUid(input.rootless)).toBeUndefined();
	});

	it("under rootful runsc, has no user namespace: the sentry is the boundary and host files keep their owners", () => {
		const config = ociConfig({ ...base, flavor: "runsc", rootless: undefined });
		expect(config.linux.namespaces.map((entry) => entry.type)).not.toContain(
			"user",
		);
		expect(config.linux.uidMappings).toEqual([]);
		expect(
			config.mounts.find((mount) => mount.destination === "/cache")?.options,
		).not.toContain("idmap");
		const forwarder = forwarderConfig({
			...input,
			flavor: "runsc",
			rootless: undefined,
		});
		expect(forwarder.linux.namespaces.map((entry) => entry.type)).not.toContain(
			"user",
		);
	});

	it("under a host runc or crun, joins the workload's network namespace (and user namespace, rootless) by path", () => {
		const rootless = forwarderConfig({ ...input, flavor: "oci" });
		expect(rootless.annotations).toEqual({});
		expect(rootless.linux.namespaces).toContainEqual({
			type: "network",
			path: "/proc/4242/ns/net",
		});
		expect(rootless.linux.namespaces).toContainEqual({
			type: "user",
			path: "/proc/4242/ns/user",
		});
		expect(rootless.linux.uidMappings).toEqual([]);
		expect(rootless.process.capabilities.effective).toEqual([]);

		const rootful = forwarderConfig({
			...input,
			flavor: "oci",
			rootless: undefined,
		});
		expect(rootful.linux.namespaces).toContainEqual({
			type: "network",
			path: "/proc/4242/ns/net",
		});
		expect(rootful.linux.namespaces.map((entry) => entry.type)).not.toContain(
			"user",
		);
		// A host uid outside the range the workload's ids map to.
		expect(rootful.process.user).toEqual({
			uid: FORWARDER_HOST_UID,
			gid: FORWARDER_HOST_UID,
		});
		expect(FORWARDER_HOST_UID).toBeLessThan(ROOTFUL_ID_BASE);
	});
});
