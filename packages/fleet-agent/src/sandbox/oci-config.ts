/**
 * The OCI runtime configuration (`config.json`) of one sandbox, as design
 * §6.11 sets `S1` out: every capability dropped, the seccomp profile of
 * `seccomp.ts`, `no-new-privileges`, pids, memory and CPU limits, a read-only
 * root with tmpfs work directories, no host mounts except the declared
 * read-only ones, no host Docker socket unless asked for, and a network
 * namespace of its own holding only loopback: the egress proxy and the
 * control endpoint are forwarded into it by the driver, and nothing else is
 * reachable. A user namespace maps the sandbox's root to an unprivileged host
 * id: the invoking user when rootless, a reserved high range when the agent
 * runs as root (assumption A10's fallback, "rootful with user-namespace
 * remapping").
 */
import { type SeccompProfile, seccompProfile } from "./seccomp.js";

/** Host ids a rootful agent maps a sandbox's ids to: far above any login user. */
export const ROOTFUL_ID_BASE = 2_147_418_112;
export const ID_RANGE = 65_536;

/** Writable tmpfs directories inside every sandbox. */
export const WORK_DIRS: readonly string[] = ["/tmp", "/run", "/work"];
/** Where the host Docker socket appears when `hostDocker` is set. */
// public-contract: the in-sandbox path of the host Docker socket for a DEDICATED device's `allow_host_docker` fleets.
export const DOCKER_SOCKET = "/var/run/docker.sock";

// domain-view: the subset of the OCI runtime spec (1.x) this driver writes; field names are the spec's.
export type OciMount = Readonly<{
	destination: string;
	type: string;
	source: string;
	options: readonly string[];
}>;
// domain-view: the OCI `process` object, also written alone for `runtime exec --process`.
export type OciProcess = Readonly<{
	terminal: false;
	user: Readonly<{ uid: number; gid: number }>;
	args: readonly string[];
	env: readonly string[];
	cwd: string;
	capabilities: Readonly<{
		bounding: readonly string[];
		effective: readonly string[];
		permitted: readonly string[];
		inheritable: readonly string[];
		ambient: readonly string[];
	}>;
	rlimits: readonly Readonly<{ type: string; hard: number; soft: number }>[];
	noNewPrivileges: true;
}>;
// domain-view: the OCI runtime `config.json` this driver writes.
export type OciConfig = Readonly<{
	ociVersion: string;
	process: OciProcess;
	root: Readonly<{ path: string; readonly: true }>;
	hostname: string;
	mounts: readonly OciMount[];
	linux: Readonly<{
		uidMappings: readonly IdMapping[];
		gidMappings: readonly IdMapping[];
		namespaces: readonly Readonly<{ type: string }>[];
		cgroupsPath: string;
		resources: Readonly<{
			pids: Readonly<{ limit: number }>;
			memory: Readonly<{ limit: number; swap: number }>;
			cpu: Readonly<{ quota: number; period: number }>;
			devices: readonly Readonly<{ allow: false; access: "rwm" }>[];
		}>;
		seccomp: SeccompProfile;
		maskedPaths: readonly string[];
		readonlyPaths: readonly string[];
	}>;
}>;
export type IdMapping = Readonly<{
	containerID: number;
	hostID: number;
	size: number;
}>;

export type SandboxLimits = Readonly<{
	memoryMb: number;
	cpus: number;
	pids: number;
	diskMb: number;
}>;

export type ConfigInput = Readonly<{
	id: string;
	rootfs: string;
	limits: SandboxLimits;
	readOnlyMounts: readonly Readonly<{ source: string; target: string }>[];
	hostDocker: boolean;
	/** The invoking user's uid and gid when rootless; undefined when the agent runs as root. */
	rootless: Readonly<{ uid: number; gid: number }> | undefined;
	args: readonly string[];
	env: readonly string[];
}>;

const MB = 1024 * 1024;

export function sandboxProcess(
	args: readonly string[],
	env: readonly string[],
	cwd: string,
): OciProcess {
	return {
		terminal: false,
		user: { uid: 0, gid: 0 },
		args,
		env,
		cwd,
		capabilities: {
			bounding: [],
			effective: [],
			permitted: [],
			inheritable: [],
			ambient: [],
		},
		rlimits: [{ type: "RLIMIT_NOFILE", hard: 4096, soft: 4096 }],
		noNewPrivileges: true,
	};
}

export function ociConfig(input: ConfigInput): OciConfig {
	const mapping = (id: number): readonly IdMapping[] =>
		input.rootless === undefined
			? [{ containerID: 0, hostID: ROOTFUL_ID_BASE, size: ID_RANGE }]
			: [{ containerID: 0, hostID: id, size: 1 }];
	const tmpfs = (destination: string, sizeMb: number): OciMount => ({
		destination,
		type: "tmpfs",
		source: "tmpfs",
		options: ["nosuid", "nodev", "mode=1777", `size=${sizeMb}m`],
	});
	// Rootful: host files keep their owners inside the sandbox (an idmapped
	// mount), so a private 0700 source stays readable by the sandbox's root.
	// Rootless sources already belong to the sandbox's root.
	const idmap: readonly string[] =
		input.rootless === undefined ? ["idmap"] : [];
	const mounts: OciMount[] = [
		{ destination: "/proc", type: "proc", source: "proc", options: [] },
		{
			destination: "/dev",
			type: "tmpfs",
			source: "tmpfs",
			options: ["nosuid", "strictatime", "mode=755", "size=65536k"],
		},
		{
			destination: "/dev/pts",
			type: "devpts",
			source: "devpts",
			options: [
				"nosuid",
				"noexec",
				"newinstance",
				"ptmxmode=0666",
				"mode=0620",
			],
		},
		{
			destination: "/dev/shm",
			type: "tmpfs",
			source: "shm",
			options: ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"],
		},
		{
			destination: "/dev/mqueue",
			type: "mqueue",
			source: "mqueue",
			options: ["nosuid", "noexec", "nodev"],
		},
		{
			destination: "/sys",
			type: "sysfs",
			source: "sysfs",
			options: ["nosuid", "noexec", "nodev", "ro"],
		},
		...WORK_DIRS.map((dir) =>
			tmpfs(dir, dir === "/run" ? 16 : Math.max(16, input.limits.diskMb)),
		),
		...input.readOnlyMounts.map(
			(mount): OciMount => ({
				destination: mount.target,
				type: "bind",
				source: mount.source,
				options: ["rbind", "ro", "nosuid", "nodev", ...idmap],
			}),
		),
	];
	if (input.hostDocker)
		mounts.push({
			destination: DOCKER_SOCKET,
			type: "bind",
			source: DOCKER_SOCKET,
			options: ["bind", "nosuid", "nodev", ...idmap],
		});
	return {
		ociVersion: "1.0.2",
		process: sandboxProcess(input.args, input.env, "/work"),
		root: { path: input.rootfs, readonly: true },
		hostname: "sandbox",
		mounts,
		linux: {
			uidMappings: mapping(input.rootless?.uid ?? 0),
			gidMappings: mapping(input.rootless?.gid ?? 0),
			namespaces: [
				{ type: "pid" },
				{ type: "ipc" },
				{ type: "uts" },
				{ type: "mount" },
				{ type: "network" },
				{ type: "user" },
				{ type: "cgroup" },
			],
			cgroupsPath: `/hobo-fleet/${input.id}`,
			resources: {
				pids: { limit: input.limits.pids },
				memory: {
					limit: input.limits.memoryMb * MB,
					swap: input.limits.memoryMb * MB,
				},
				cpu: {
					quota: Math.max(1000, Math.round(input.limits.cpus * 100_000)),
					period: 100_000,
				},
				devices: [{ allow: false, access: "rwm" }],
			},
			seccomp: seccompProfile(),
			maskedPaths: [
				"/proc/acpi",
				"/proc/asound",
				"/proc/kcore",
				"/proc/keys",
				"/proc/latency_stats",
				"/proc/timer_list",
				"/proc/timer_stats",
				"/proc/sched_debug",
				"/proc/scsi",
				"/sys/firmware",
			],
			readonlyPaths: [
				"/proc/bus",
				"/proc/fs",
				"/proc/irq",
				"/proc/sys",
				"/proc/sysrq-trigger",
			],
		},
	};
}
