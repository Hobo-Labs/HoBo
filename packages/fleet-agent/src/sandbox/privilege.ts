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

function onPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

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
