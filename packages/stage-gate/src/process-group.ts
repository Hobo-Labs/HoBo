/**
 * Stopping ai-bdd's process group (ADR-0172, src/ai-bdd-process.ts): a signal
 * to all of it, SIGKILL to what is left after the grace period, and a typed
 * answer of how the stop ended: gone, killed, or unconfirmed with a reason.
 * kill answering ESRCH means the kernel found no member; EPERM or EACCES
 * means it found members this process may not signal (another user's, or a
 * security module said no), which no later signal can help with.
 *
 * Between the two, each poll asks the kernel first, with kill(-pgid, 0), and
 * reads the Linux process table only while the kernel still finds a member: a
 * group that is gone costs no scan. kill(-pgid, 0) finds a zombie as readily
 * as a live process, and a PID 1 or subreaper that never reaps would otherwise
 * hold every stop for the whole grace period: a group the table shows holding
 * only zombies is SIGKILLed at once.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** process.kill's shape (it throws what the kernel answers); a test passes one that answers as the kernel would. */
export type Kill = (pid: number, signal: NodeJS.Signals | 0) => void;

/** kill refused the signal: EPERM, EACCES, or another error that is not ESRCH. */
export interface Refused {
	readonly kind: "refused";
	readonly code: string;
}

/** What one signal to the group did. */
export type GroupSignal =
	| { readonly kind: "sent" }
	| { readonly kind: "gone" }
	| Refused;

/** What the kernel, then /proc, say of the group between signals. */
export type GroupProbe =
	| { readonly kind: "gone" }
	| { readonly kind: "zombies" }
	| { readonly kind: "live" }
	| Refused;

/** How a stop ended. */
export type GroupStop =
	| { readonly kind: "gone" }
	| { readonly kind: "killed" }
	| { readonly kind: "unconfirmed"; readonly reason: string };

/** A process group as a stop sees it: how to signal it, and how to ask what is left of it. */
export interface StopTarget {
	/** What the reasons name: "process group 1234". */
	readonly label: string;
	readonly signal: (signal: NodeJS.Signals) => GroupSignal;
	readonly probe: () => GroupProbe;
}

export interface GroupSeams {
	/** process.kill unless set. */
	readonly kill?: Kill;
	/** The process table to read (Linux); without one, a member the kernel finds is live. */
	readonly procRoot?: string;
}

/** Between two probes of a group being stopped. */
export const POLL_MS = 100;
/** How long SIGKILL has to land before the stop says it cannot confirm the group ended. */
export const KILL_CONFIRM_MS = 1000;

/** The errno code of what kill or a read threw ("unknown" when it has none). */
function codeOf(cause: unknown): string {
	return cause instanceof Error && "code" in cause && cause.code !== undefined
		? String(cause.code)
		: "unknown";
}

/**
 * The fields of `<procRoot>/<pid>/stat` after its comm; "gone" once the
 * process is (ENOENT, ESRCH), and "unreadable" for any other error, which
 * cannot tell whether it is a member (EACCES for another user's process under
 * hidepid=1, EMFILE at the fd limit). "pid (comm) state ppid pgrp ...": comm
 * may hold spaces and parentheses, so the fields start after the last ")".
 */
function statFields(
	procRoot: string,
	pid: string,
): string[] | "gone" | "unreadable" {
	let stat: string;
	try {
		stat = readFileSync(join(procRoot, pid, "stat"), "utf8");
	} catch (cause) {
		const code = codeOf(cause);
		return code === "ENOENT" || code === "ESRCH" ? "gone" : "unreadable";
	}
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

/**
 * Whether the table at `procRoot` is this process's PID namespace's: its
 * `self` names this process. Another namespace's shows pids of its own, and
 * nothing in it can be matched to ai-bdd's group.
 */
function ownTable(procRoot: string): boolean {
	try {
		return readlinkSync(join(procRoot, "self")) === String(process.pid);
	} catch {
		return false;
	}
}

/**
 * What the process table at `procRoot` shows of `group`, counting as members
 * only the processes of its pgid that are in its session:
 * - "zombies" when it shows at least one member and every member it shows is
 *   a zombie of one thread (state Z, num_threads 1);
 * - "elsewhere" when it shows no member but processes of that pgid in another
 *   session: the group is gone and its number now leads a stranger's;
 * - "live" otherwise. A process whose main thread exited while its other
 *   threads run shows Z with num_threads above 1. An entry whose stat cannot
 *   be read may be a member it cannot see. A /proc of another PID namespace,
 *   or one that cannot be read, shows nothing that can be matched, although
 *   the kernel has just found a member.
 */
export function scanGroup(
	{ pgid, sid }: ProcessGroup,
	procRoot: string,
): "zombies" | "elsewhere" | "live" {
	if (!ownTable(procRoot)) return "live";
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch {
		return "live";
	}
	let members = 0;
	let strangers = 0;
	for (const entry of entries) {
		if (!/^\d+$/u.test(entry)) continue;
		const fields = statFields(procRoot, entry);
		if (fields === "unreadable") return "live";
		// state is field 3, pgrp field 5, session field 6 and num_threads field 20 of the line.
		if (fields === "gone" || Number(fields[2]) !== pgid) continue;
		if (Number(fields[3]) !== sid) {
			strangers += 1;
			continue;
		}
		members += 1;
		if (fields[0] !== "Z" || Number(fields[17]) !== 1) return "live";
	}
	if (members > 0) return "zombies";
	return strangers > 0 ? "elsewhere" : "live";
}

/** `signal` (0 only asks) to every member of group `pgid`. */
function signalPgid(
	kill: Kill,
	pgid: number,
	signal: NodeJS.Signals | 0,
): GroupSignal {
	try {
		kill(-pgid, signal);
	} catch (cause) {
		const code = codeOf(cause);
		return code === "ESRCH" ? { kind: "gone" } : { kind: "refused", code };
	}
	return { kind: "sent" };
}

/** A process group (POSIX), as ai-bdd's is when it is spawned. */
export interface ProcessGroup {
	readonly pgid: number;
	/** The session it is in, recorded at spawn: a process that later takes the pgid's number is not in it. */
	readonly sid: number;
}

/** How a stop signals `group`, and asks what is left of it. */
export function groupTarget(
	group: ProcessGroup,
	seams: GroupSeams = {},
): StopTarget {
	const { pgid } = group;
	const kill = seams.kill ?? process.kill;
	const { procRoot } = seams;
	return {
		label: `process group ${pgid}`,
		signal: (signal) => signalPgid(kill, pgid, signal),
		probe() {
			const asked = signalPgid(kill, pgid, 0);
			if (asked.kind !== "sent") return asked;
			if (procRoot === undefined) return { kind: "live" };
			const scan = scanGroup(group, procRoot);
			// The number is a stranger's now: none of ours is left, and nothing more is sent.
			return scan === "elsewhere" ? { kind: "gone" } : { kind: scan };
		},
	};
}

const sleep = (ms: number) =>
	new Promise<void>((done) => {
		setTimeout(done, ms);
	});

/** The stop's answer when kill refused: no signal of this process can reach what is left. */
function refusedStop(target: StopTarget, { code }: Refused): GroupStop {
	const why =
		code === "EPERM"
			? "members this check may not signal (another user's) are left"
			: code === "EACCES"
				? "a security module refused the signal, so members are left"
				: "members may be left";
	return {
		kind: "unconfirmed",
		reason: `${target.label}: kill answered ${code}: ${why}`,
	};
}

/** SIGKILL to the group, then probes until it has landed, for KILL_CONFIRM_MS at most. */
async function killGroup(target: StopTarget): Promise<GroupStop> {
	const sent = target.signal("SIGKILL");
	if (sent.kind === "gone") return { kind: "gone" };
	if (sent.kind === "refused") return refusedStop(target, sent);
	const deadline = Date.now() + KILL_CONFIRM_MS;
	for (;;) {
		const probe = target.probe();
		if (probe.kind === "gone" || probe.kind === "zombies") {
			return { kind: "killed" };
		}
		if (probe.kind === "refused") return refusedStop(target, probe);
		if (Date.now() >= deadline) {
			return {
				kind: "unconfirmed",
				// Not "SIGKILL did not kill them": without CAP_KILL it skips another user's members, and
				// with one of ours left a zombie beside them kill(-pgid, 0) never answers EPERM.
				reason: `${target.label}: members were still running ${KILL_CONFIRM_MS} ms after SIGKILL was sent to the group (SIGKILL cannot reach another user's members unless the check has CAP_KILL, and may not have ended the rest yet)`,
			};
		}
		await sleep(POLL_MS);
	}
}

/**
 * Stop a group: `signal` to all of it, then SIGKILL to what is left after
 * graceMs, or at once when /proc shows only zombies. Resolves gone when the
 * kernel finds no member, killed once SIGKILL has landed, and unconfirmed
 * when kill is refused or members are still running after SIGKILL.
 */
export async function stopGroup(
	target: StopTarget,
	signal: NodeJS.Signals,
	graceMs: number,
): Promise<GroupStop> {
	const first = target.signal(signal);
	if (first.kind === "gone") return { kind: "gone" };
	if (first.kind === "refused") return refusedStop(target, first);
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		await sleep(POLL_MS);
		const probe = target.probe();
		if (probe.kind === "gone") return { kind: "gone" };
		if (probe.kind === "refused") return refusedStop(target, probe);
		// The scan can miss a member forked while it ran. The kernel's group signal
		// cannot: it is atomic with fork, it reaches that member, and zombies ignore it.
		if (probe.kind === "zombies") break;
	}
	return killGroup(target);
}
