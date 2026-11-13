/**
 * Privilege and cgroup probes (D58, A10). A sandbox's mode is probed, never
 * assumed:
 *
 * - **rootful** when the agent's effective uid is 0 (each sandbox still runs
 *   in a user namespace mapped to a reserved high id range);
 * - **rootless** when an unprivileged user namespace can be created: the
 *   kernel switches that would refuse it are read first, then a trial runs
 *   (the provisioned `runsc do true` with a one-id mapping, else `unshare -U
 *   true` if the host happens to have it); with neither, the runtime's own
 *   self-test decides;
 * - otherwise **unavailable**, reason `no-root-or-userns`, with the kernel
 *   setting that refused it when one did.
 *
 * Limits: **delegated** when the agent can create cgroups with the memory and
 * pids controllers (root on a writable hierarchy, or a user whose cgroup's
 * parent is writable and enables both for its children); otherwise
 * **sentry**: the runtime runs with `--ignore-cgroups` and the limits are
 * enforced inside gVisor (`oci-config.ts`).
 */
import { spawn } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** The few host facts the probes read, behind a port so tests substitute them. */
export type HostFacts = Readonly<{
	readFile(path: string): string | undefined;
	exists(path: string): boolean;
	writable(path: string): boolean;
}>;

export const REAL_HOST: HostFacts = {
	readFile(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
	exists: existsSync,
	writable(path) {
		try {
			accessSync(path, constants.W_OK);
			return true;
		} catch {
			return false;
		}
	},
};

export type Privilege =
	| Readonly<{ mode: "rootful" | "rootless"; detail: string }>
	| Readonly<{
			mode: "unavailable";
			reason: "no-root-or-userns";
			detail: string;
	  }>;

export type TrialAnswer = Readonly<{ ok: boolean; detail: string }>;

/** Kernel settings that refuse unprivileged user namespaces, with the value that refuses. */
const USERNS_SWITCHES: readonly Readonly<{
	path: string;
	sysctl: string;
	refuses: string;
}>[] = [
	{
		path: "/proc/sys/user/max_user_namespaces",
		sysctl: "user.max_user_namespaces",
		refuses: "0",
	},
	{
		path: "/proc/sys/kernel/unprivileged_userns_clone",
		sysctl: "kernel.unprivileged_userns_clone",
		refuses: "0",
	},
	{
		path: "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
		sysctl: "kernel.apparmor_restrict_unprivileged_userns",
		refuses: "1",
	},
];

const NO_USERNS = "no-root-or-userns" as const;

export async function probePrivilege(
	input: Readonly<{
		euid: number;
		host: HostFacts;
		/** Creates an unprivileged user namespace; undefined when nothing on this host can try. */
		trial: (() => Promise<TrialAnswer>) | undefined;
	}>,
): Promise<Privilege> {
	if (input.euid === 0)
		return { mode: "rootful", detail: "the agent runs as root" };
	for (const knob of USERNS_SWITCHES) {
		const value = input.host.readFile(knob.path)?.trim();
		if (value === knob.refuses)
			return {
				mode: "unavailable",
				reason: NO_USERNS,
				detail: `not root, and the kernel refuses unprivileged user namespaces (${knob.sysctl}=${value})`,
			};
	}
	if (input.trial === undefined)
		return {
			mode: "rootless",
			detail:
				"not root; no user-namespace trial ran, so the runtime's self-test decides",
		};
	const answer = await input.trial();
	if (answer.ok) return { mode: "rootless", detail: answer.detail };
	return {
		mode: "unavailable",
		reason: NO_USERNS,
		detail: `not root, and an unprivileged user namespace could not be created: ${answer.detail}`,
	};
}

export type Cgroups =
	| Readonly<{
			mode: "delegated";
			/** The cgroup each sandbox's cgroup is made under. */
			parent: string;
			detail: string;
	  }>
	| Readonly<{ mode: "sentry"; detail: string }>;

const ROOT = "/sys/fs/cgroup";

export function probeCgroups(euid: number, host: HostFacts): Cgroups {
	const lines = (host.readFile("/proc/self/cgroup") ?? "").split("\n");
	const unified = host.exists(`${ROOT}/cgroup.controllers`);
	if (euid === 0) {
		if (unified && host.writable(ROOT))
			return {
				mode: "delegated",
				parent: "/hobo-fleet",
				detail: "root on a writable cgroup v2 hierarchy",
			};
		if (
			!unified &&
			host.writable(`${ROOT}/memory`) &&
			host.writable(`${ROOT}/pids`)
		)
			return {
				mode: "delegated",
				parent: "/hobo-fleet",
				detail: "root on writable cgroup v1 memory and pids hierarchies",
			};
		return {
			mode: "sentry",
			detail: "root, but the cgroup hierarchy is not writable",
		};
	}
	const own = lines
		.find((line) => line.startsWith("0::"))
		?.slice(3)
		.trim();
	if (!unified || own === undefined || own === "" || own === "/")
		return { mode: "sentry", detail: "no cgroup v2 delegation for this user" };
	const parent = dirname(own);
	const enabled = (
		host.readFile(`${ROOT}${parent}/cgroup.subtree_control`) ?? ""
	)
		.trim()
		.split(/\s+/u);
	if (
		host.writable(`${ROOT}${parent}`) &&
		enabled.includes("memory") &&
		enabled.includes("pids")
	)
		return {
			mode: "delegated",
			parent,
			detail: `cgroup v2 delegated at ${parent}`,
		};
	return {
		mode: "sentry",
		detail: `no cgroup v2 delegation at ${parent} (needs write access and memory, pids in its cgroup.subtree_control)`,
	};
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
): Promise<TrialAnswer> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ ok: false, detail: String(error) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				ok: code === 0,
				detail:
					code === 0
						? `${command} ${args.join(" ")}`
						: `${command} exited ${code}: ${stderr.trim().slice(0, 300)}`,
			});
		});
	});
}

/** An executable named `name` on PATH, if any; used only for the optional `unshare` trial. */
function onPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not here.
		}
	}
	return undefined;
}

/**
 * The real user-namespace trial: the provisioned `runsc` running `true` in a
 * sandbox whose root is this user (no `newuidmap` needed), else `unshare -U`
 * when the host has it, else undefined.
 */
export function userNamespaceTrial(
	runsc: string | undefined,
): (() => Promise<TrialAnswer>) | undefined {
	const uid = process.getuid?.() ?? 0;
	const gid = process.getgid?.() ?? 0;
	if (runsc !== undefined)
		return async () => {
			const state = mkdtempSync(join(tmpdir(), "hobo-userns-"));
			try {
				return await run(
					runsc,
					[
						"--root",
						state,
						"--ignore-cgroups",
						"--network=none",
						"do",
						"--quiet",
						"--uid-map",
						`0 ${uid} 1`,
						"--gid-map",
						`0 ${gid} 1`,
						"true",
					],
					"/",
				);
			} finally {
				rmSync(state, { recursive: true, force: true });
			}
		};
	const unshare = onPath("unshare");
	if (unshare === undefined) return undefined;
	return () => run(unshare, ["--user", "true"], "/");
}
