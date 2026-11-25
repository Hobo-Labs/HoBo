import { type SeccompProfile, seccompProfile } from "./seccomp.js";

export const ROOTFUL_ID_BASE = 2_147_418_112;
export const ID_RANGE = 65_536;

// public-contract: the uid of the forwarder container when the agent runs as root.
export const FORWARDER_HOST_UID = ROOTFUL_ID_BASE - 1;

// public-contract: the CRI annotation runsc reads for a container's role in its pod (sandbox or container).
export const POD_CONTAINER_TYPE = "io.kubernetes.cri.container-type";
// public-contract: the CRI annotation naming the pod (its sandbox container's id) a runsc container joins.
export const POD_SANDBOX_ID = "io.kubernetes.cri.sandbox-id";

export const WORK_DIRS: readonly string[] = ["/tmp", "/run", "/work"];
// public-contract: the in-sandbox path of the host Docker socket for a DEDICATED device's `allow_host_docker` fleets.
export const DOCKER_SOCKET = "/var/run/docker.sock";

export type RuntimeFlavor = "runsc" | "oci";

export type CgroupPlacement =
	| Readonly<{ mode: "delegated"; parent: string }>
	| Readonly<{ mode: "sentry" }>;

const DEFAULT_CGROUPS: CgroupPlacement = {
	mode: "delegated",
	parent: "/hobo-fleet",
};

// domain-view: the subset of the OCI runtime spec (1.x) this driver writes; field names are the spec's.
export type OciMount = Readonly<{
	destination: string;
	type: string;
	source: string;
	options: readonly string[];
}>;
// domain-view: one OCI `process.rlimits` entry.
export type Rlimit = Readonly<{ type: string; hard: number; soft: number }>;
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
	rlimits: readonly Rlimit[];
	noNewPrivileges: true;
}>;
// domain-view: one OCI `linux.namespaces` entry; `path` joins an existing namespace.
export type OciNamespace = Readonly<{ type: string; path?: string }>;
// domain-view: the OCI runtime `config.json` this driver writes.
export type OciConfig = Readonly<{
	ociVersion: string;
	process: OciProcess;
	root: Readonly<{ path: string; readonly: true }>;
	hostname: string;
	mounts: readonly OciMount[];
	annotations: Readonly<Record<string, string>>;
	linux: Readonly<{
		uidMappings: readonly IdMapping[];
		gidMappings: readonly IdMapping[];
		namespaces: readonly OciNamespace[];
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

type Rootless = Readonly<{ uid: number; gid: number }> | undefined;

export type ConfigInput = Readonly<{
	id: string;
	rootfs: string;
	limits: SandboxLimits;
	readOnlyMounts: readonly Readonly<{ source: string; target: string }>[];
	hostDocker: boolean;
	rootless: Rootless;
	args: readonly string[];
	env: readonly string[];
	flavor?: RuntimeFlavor;
	cgroups?: CgroupPlacement;
	pod?: string | undefined;
}>;

const MB = 1024 * 1024;
const NO_CAPABILITIES = {
	bounding: [],
	effective: [],
	permitted: [],
	inheritable: [],
	ambient: [],
} as const;

export function sandboxRlimits(
	limits: SandboxLimits,
	flavor: RuntimeFlavor,
	cgroups: CgroupPlacement,
): readonly Rlimit[] {
	const rlimits: Rlimit[] = [{ type: "RLIMIT_NOFILE", hard: 4096, soft: 4096 }];
	if (flavor === "runsc")
		rlimits.push({
			type: "RLIMIT_NPROC",
			hard: limits.pids,
			soft: limits.pids,
		});
	if (flavor === "runsc" && cgroups.mode === "sentry")
		rlimits.push({
			type: "RLIMIT_AS",
			hard: limits.memoryMb * MB,
			soft: limits.memoryMb * MB,
		});
	return rlimits;
}

export function sandboxProcess(
	args: readonly string[],
	env: readonly string[],
	cwd: string,
	rlimits: readonly Rlimit[] = [
		{ type: "RLIMIT_NOFILE", hard: 4096, soft: 4096 },
	],
): OciProcess {
	return {
		terminal: false,
		user: { uid: 0, gid: 0 },
		args,
		env,
		cwd,
		capabilities: NO_CAPABILITIES,
		rlimits,
		noNewPrivileges: true,
	};
}

const MASKED_PATHS: readonly string[] = [
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
];
const READONLY_PATHS: readonly string[] = [
	"/proc/bus",
	"/proc/fs",
	"/proc/irq",
	"/proc/sys",
	"/proc/sysrq-trigger",
];

function userNamespaced(flavor: RuntimeFlavor, rootless: Rootless): boolean {
	return !(flavor === "runsc" && rootless === undefined);
}

function idMappings(
	flavor: RuntimeFlavor,
	rootless: Rootless,
	id: number,
): readonly IdMapping[] {
	if (!userNamespaced(flavor, rootless)) return [];
	return rootless === undefined
		? [{ containerID: 0, hostID: ROOTFUL_ID_BASE, size: ID_RANGE }]
		: [{ containerID: 0, hostID: id, size: 1 }];
}

export function cgroupsPath(
	flavor: RuntimeFlavor,
	cgroups: CgroupPlacement,
	id: string,
): string {
	if (cgroups.mode === "delegated") return `${cgroups.parent}/${id}`;
	return flavor === "runsc" ? "" : `/hobo-fleet/${id}`;
}

export function hostPidsBackstop(pids: number): number {
	return 4 * pids + 1024;
}

function podAnnotations(
	flavor: RuntimeFlavor,
	type: "sandbox" | "container",
	sandboxId: string,
): Readonly<Record<string, string>> {
	return flavor === "runsc"
		? { [POD_CONTAINER_TYPE]: type, [POD_SANDBOX_ID]: sandboxId }
		: {};
}

export function ociConfig(input: ConfigInput): OciConfig {
	const flavor = input.flavor ?? "oci";
	const cgroups = input.cgroups ?? DEFAULT_CGROUPS;
	const tmpfs = (destination: string, sizeMb: number): OciMount => ({
		destination,
		type: "tmpfs",
		source: "tmpfs",
		options: ["nosuid", "nodev", "mode=1777", `size=${sizeMb}m`],
	});
	const idmap: readonly string[] =
		input.rootless === undefined && flavor === "oci" ? ["idmap"] : [];
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
		process: sandboxProcess(
			input.args,
			input.env,
			"/work",
			sandboxRlimits(input.limits, flavor, cgroups),
		),
		root: { path: input.rootfs, readonly: true },
		hostname: "sandbox",
		mounts,
		annotations:
			input.pod === undefined
				? podAnnotations(flavor, "sandbox", input.id)
				: podAnnotations(flavor, "container", input.pod),
		linux: {
			uidMappings: idMappings(flavor, input.rootless, input.rootless?.uid ?? 0),
			gidMappings: idMappings(flavor, input.rootless, input.rootless?.gid ?? 0),
			namespaces: [
				{ type: "pid" },
				{ type: "ipc" },
				{ type: "uts" },
				{ type: "mount" },
				{ type: "network" },
				...(userNamespaced(flavor, input.rootless) ? [{ type: "user" }] : []),
				{ type: "cgroup" },
			],
			cgroupsPath: cgroupsPath(flavor, cgroups, input.id),
			resources: {
				pids: {
					limit:
						flavor === "runsc"
							? hostPidsBackstop(input.limits.pids)
							: input.limits.pids,
				},
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
			maskedPaths: MASKED_PATHS,
			readonlyPaths: READONLY_PATHS,
		},
	};
}

export type ForwarderInput = Readonly<{
	id: string;
	limits: SandboxLimits;
	flavor: RuntimeFlavor;
	socketDir: string;
	routes: readonly Readonly<{ port: number; socket: string }>[];
	node: string;
	script: string;
	workloadPid: number;
	rootless: Rootless;
	cgroups?: CgroupPlacement;
}>;

const FORWARDER_MEMORY_MB = 256;
const FORWARDER_PIDS = 64;

export function forwarderUid(rootless: Rootless): number {
	return rootless === undefined ? FORWARDER_HOST_UID : 0;
}

export function forwarderHostUid(rootless: Rootless): number | undefined {
	return rootless === undefined ? FORWARDER_HOST_UID : undefined;
}

export function forwarderConfig(input: ForwarderInput): OciConfig {
	const runsc = input.flavor === "runsc";
	const cgroups = input.cgroups ?? DEFAULT_CGROUPS;
	const uid = forwarderUid(input.rootless);
	const own = (type: string): OciNamespace => ({ type });
	const join = (type: string, ns: string): OciNamespace => ({
		type,
		path: `/proc/${input.workloadPid}/ns/${ns}`,
	});
	const namespaces: OciNamespace[] = [
		own("pid"),
		own("ipc"),
		own("uts"),
		own("mount"),
	];
	if (runsc) {
		namespaces.push(own("network"));
		if (userNamespaced(input.flavor, input.rootless))
			namespaces.push(own("user"));
	} else {
		namespaces.push(join("network", "net"));
		if (input.rootless !== undefined) namespaces.push(join("user", "user"));
	}
	const mappings = (id: number): readonly IdMapping[] =>
		runsc ? idMappings(input.flavor, input.rootless, id) : [];
	return {
		ociVersion: "1.0.2",
		process: {
			terminal: false,
			user: { uid, gid: uid },
			args: [input.node, "-e", input.script, JSON.stringify(input.routes)],
			env: [
				"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			],
			cwd: "/",
			capabilities: NO_CAPABILITIES,
			rlimits: [{ type: "RLIMIT_NOFILE", hard: 4096, soft: 4096 }],
			noNewPrivileges: true,
		},
		root: { path: "/", readonly: true },
		hostname: "forwarder",
		mounts: [
			{ destination: "/proc", type: "proc", source: "proc", options: [] },
			{
				destination: "/dev",
				type: "tmpfs",
				source: "tmpfs",
				options: ["nosuid", "strictatime", "mode=755", "size=65536k"],
			},
			{
				destination: "/tmp",
				type: "tmpfs",
				source: "tmpfs",
				options: ["nosuid", "nodev", "mode=1777", "size=16m"],
			},
			{
				destination: input.socketDir,
				type: "bind",
				source: input.socketDir,
				options: ["rbind", "ro", "nosuid", "nodev"],
			},
		],
		annotations: podAnnotations(input.flavor, "sandbox", input.id),
		linux: {
			uidMappings: mappings(input.rootless?.uid ?? 0),
			gidMappings: mappings(input.rootless?.gid ?? 0),
			namespaces,
			cgroupsPath: cgroupsPath(input.flavor, cgroups, input.id),
			resources: runsc
				? {
						pids: {
							limit: hostPidsBackstop(input.limits.pids + FORWARDER_PIDS),
						},
						memory: {
							limit: (input.limits.memoryMb + FORWARDER_MEMORY_MB) * MB,
							swap: (input.limits.memoryMb + FORWARDER_MEMORY_MB) * MB,
						},
						cpu: {
							quota: Math.max(1000, Math.round(input.limits.cpus * 100_000)),
							period: 100_000,
						},
						devices: [{ allow: false, access: "rwm" }],
					}
				: {
						pids: { limit: FORWARDER_PIDS },
						memory: {
							limit: FORWARDER_MEMORY_MB * MB,
							swap: FORWARDER_MEMORY_MB * MB,
						},
						cpu: { quota: 50_000, period: 100_000 },
						devices: [{ allow: false, access: "rwm" }],
					},
			seccomp: seccompProfile(),
			maskedPaths: MASKED_PATHS,
			readonlyPaths: READONLY_PATHS,
		},
	};
}
