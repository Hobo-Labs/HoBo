import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { readStationSidecars } from "../src/station-sidecars.js";
import {
	drainEvidenceSidecarsForHomes,
	killProcessGroup,
	listLeakedEvidenceSidecarPids,
	readProcessHoboHome,
	trackChild,
} from "./subprocess-cleanup.js";

// hobo-code composes HoBo in process: a `/hobo <verb>` in its shell loads
// @hobo/hobo's composition, whose default runtime keeps its event store in a
// `hobo-yard-*` directory under TMPDIR. However hobo-code is ended, that store
// must not be left behind, and the process holding it must not outlive
// hobo-code. The shell needs a terminal, so it runs under util-linux script(1):
// a shell there starts the package's own bin, as a person does at a prompt,
// and keeps the terminal open after hobo-code ends, as that person's would.
//
// That bin is a launcher. It runs the shell as a child in a session of its
// own, which neither the terminal's hangup nor a signal sent to hobo-code
// reaches unless the launcher passes it on.

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(pkgRoot, "bin", "hobo-code.mjs");
const ESC = String.fromCharCode(0x1b);
/** The alternate screen proves the TUI is ready for keyboard input. */
const SHELL_DRAWN = `${ESC}[?1049h`;
/** The successful `/hobo recipes` result proves the verb and composition ended. */
const VERB_ENDED = "hobo recipes:";
/** Terminal control sequences, left out of the screen a failure shows. */
const CONTROL_SEQUENCES = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "gu");
const VERB_DEADLINE_MS = 150_000;
const SIGNAL_GRACE_MS = 30_000;
/** How long hobo-code's child gets to end once hobo-code has. */
const CHILD_GRACE_MS = 20_000;
const RUN_TIMEOUT_MS = 120_000;

/** Why the pseudo-terminal cases cannot run here, or false when they can. */
function noUtilLinuxScript(): string | false {
	const needs = "needs util-linux script(1) for a pseudo-terminal";
	const probe = spawnSync("script", ["--version"], { encoding: "utf8" });
	if (probe.error !== undefined) return `${needs}: ${probe.error.message}`;
	const said = `${probe.stdout}${probe.stderr}`.trim().replace(/\s+/gu, " ");
	if (!/util-linux/u.test(said))
		return `${needs}; \`script --version\` said: ${said || `exit ${probe.status}`}`;
	return false;
}
const skipReason = noUtilLinuxScript();

/** The fields of /proc/<pid>/stat after the command name: state, ppid, ... */
function statOf(pid: number): readonly string[] | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	} catch {
		return undefined;
	}
}

/** The process exists and is not a zombie. */
function running(pid: number): boolean {
	const stat = statOf(pid);
	return stat !== undefined && stat[0] !== "Z";
}

function childrenOf(pid: number): number[] {
	return readdirSync("/proc")
		.filter((name) => /^\d+$/u.test(name))
		.map(Number)
		.filter((candidate) => statOf(candidate)?.[1] === String(pid));
}

/** Poll until `done`, for at most `ms`; whether it came true. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!done()) {
		if (Date.now() > deadline) return false;
		await sleep(100);
	}
	return true;
}

const roots: string[] = [];
/** Children of hobo-code a case looked at: none may outlive the case. */
const children: number[] = [];
afterEach(async () => {
	for (const pid of children.splice(0)) {
		if (running(pid)) killProcessGroup(pid);
	}
	for (const root of roots.splice(0)) {
		const home = join(root, "home");
		const pidFile = join(root, "evidence-sidecar.pid");
		if (existsSync(pidFile)) {
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) killProcessGroup(pid);
		}
		const evidencePid = readStationSidecars(home, "station:local")?.evidencePid;
		if (evidencePid !== undefined) killProcessGroup(evidencePid);
		rmSync(root, { recursive: true, force: true });
		await drainEvidenceSidecarsForHomes([home]);
		await until(
			() => !listRunningSidecarsUnder(root).some((pid) => running(pid)),
			3_000,
		);
	}
});

function listRunningSidecarsUnder(root: string): number[] {
	return listLeakedEvidenceSidecarPids().filter((pid) => {
		const home = hoboHomeForTestPid(pid);
		return home?.startsWith(root);
	});
}

function hoboHomeForTestPid(pid: number): string | undefined {
	return readProcessHoboHome(pid);
}

/** How a case ends hobo-code once a `/hobo` verb has left its runtime holding a store. */
type Ending =
	| {
			readonly signal: NodeJS.Signals;
			/** hobo-code is the launcher; its child holds the store. */
			readonly to: "hobo-code" | "its child";
	  }
	/** script(1) is killed and the pseudo-terminal goes, as when its window closes. */
	| "close the terminal";

interface Ended {
	/** hobo-code's status as its shell saw it (128+n after signal n); null when the terminal went first. */
	readonly code: number | null;
	readonly made: readonly string[];
	readonly left: readonly string[];
	/** Whether hobo-code's child, which held the store, has ended. */
	readonly childEnded: boolean;
	/**
	 * Whether that child was still running when the terminal's shell had
	 * hobo-code's status, and the terminal, back. hobo-code that waits for its
	 * child hands the terminal back once the child has restored it.
	 */
	readonly childOutlivedIt: boolean;
	/**
	 * Whether the terminal was as it found it when its shell got it back: off
	 * the alternate screen, the cursor shown, and the line settings the same.
	 */
	readonly terminalRestored: boolean;
	readonly screen: string;
}

/** The line settings a terminal left raw differs in: `-icanon -echo ...`. */
function lineSettings(sttyAll: string): string {
	return ["icanon", "echo", "isig", "icrnl", "opost"]
		.map((flag) =>
			new RegExp(`(^|\\s)-${flag}(\\s|$)`, "u").test(sttyAll)
				? `-${flag}`
				: flag,
		)
		.join(" ");
}

function stores(dir: string): string[] {
	return readdirSync(dir).filter((name) => name.startsWith("hobo-yard-"));
}

/**
 * Start hobo-code's shell and run `/hobo recipes` in it, which fails outside a
 * HoBo project once the composition and its store are made. With the shell
 * idle again, end hobo-code as `ending` says, and give the child that holds
 * the store time to end while the terminal stays open.
 */
async function endTheShell(ending: Ending): Promise<Ended> {
	const root = mkdtempSync(join(tmpdir(), "hobo-code-signals-"));
	roots.push(root);
	const tmp = join(root, "tmp");
	mkdirSync(tmp);
	const at = (name: string): string => join(root, name);
	// An inner sh writes its own pid and becomes hobo-code, so that pid is
	// hobo-code's. The outer one, the terminal's shell, records its status,
	// whether hobo-code's child is still running at that moment and the line
	// settings, and keeps the terminal open until the case is done.
	const command = [
		"stty cols 120 rows 40",
		`stty -a > '${at("stty-before")}'`,
		`sh -c "echo \\$\\$ > '${at("pid")}'; exec '${process.execPath}' '${launcher}'"`,
		`echo $? > '${at("status")}'`,
		`kill -0 "$(cat '${at("child")}')" 2>/dev/null && echo > '${at("outlived")}'`,
		`stty -a > '${at("stty-after")}'`,
		`while [ ! -e '${at("done")}' ]; do sleep 0.1; done`,
	].join("; ");
	const sidecarPidFile = at("evidence-sidecar.pid");
	const script = spawn("script", ["-qfec", command, "/dev/null"], {
		detached: true,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: root,
			HOBO_HOME: join(root, "home"),
			TMPDIR: tmp,
			TERM: "xterm-256color",
			HOBO_CODE_ENGINE: "none",
			HOBO_CODE_FROM_SOURCE: "0",
			HOBO_CODE_SKIP_STALE_REBUILD: "1",
			HOBO_CODE_REDUCED_MOTION: "1",
			HOBO_CODE_SIDECAR_PIDFILE: sidecarPidFile,
			// The shell's Station Evidence sidecar outlives it by design, until its
			// HOBO_HOME is gone: the cleanup removes that, and the sidecar notices
			// within a moment.
			HOBO_CODE_SIDECAR_POLL_MS: "250",
			HOBO_CODE_SIDECAR_MAX_MS: "120000",
			NODE_NO_WARNINGS: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	trackChild(script);
	let screen = "";
	const draw = (chunk: Buffer): void => {
		screen = `${screen}${chunk.toString("utf8")}`.slice(-64 * 1024);
	};
	script.stdout.on("data", draw);
	script.stderr.on("data", draw);
	let closed = false;
	const close = new Promise<void>((resolve, reject) => {
		script.once("error", reject);
		script.once("close", () => {
			closed = true;
			resolve();
		});
	});
	let child: number | undefined;
	try {
		await until(() => closed || screen.includes(SHELL_DRAWN), VERB_DEADLINE_MS);
		if (!closed) {
			script.stdin.write("/hobo recipes");
			await sleep(500);
			script.stdin.write("\r");
		}
		await until(
			() =>
				closed ||
				(stores(tmp).length > 0 &&
					screen.replace(CONTROL_SEQUENCES, "").includes(VERB_ENDED)),
			VERB_DEADLINE_MS,
		);
		const made = stores(tmp);
		if (made.length > 0 && !closed) {
			const hoboCode = Number(readFileSync(at("pid"), "utf8"));
			child = childrenOf(hoboCode)[0];
			if (child !== undefined) {
				children.push(child);
				writeFileSync(at("child"), String(child));
			}
			if (ending === "close the terminal") script.kill("SIGKILL");
			else {
				const target = ending.to === "hobo-code" ? hoboCode : child;
				if (target === undefined) throw new Error("hobo-code has no child");
				process.kill(target, ending.signal);
			}
			await until(() => closed || existsSync(at("status")), SIGNAL_GRACE_MS);
			await until(() => child === undefined || !running(child), CHILD_GRACE_MS);
		}
		if (
			made.length > 0 &&
			ending !== "close the terminal" &&
			ending.to === "hobo-code" &&
			ending.signal !== "SIGKILL"
		) {
			// The outer shell can write its status before the final terminal bytes
			// reach this parent. Wait for the restore output, not only the status.
			await until(
				() =>
					screen.lastIndexOf(`${ESC}[?1049l`) >
						screen.lastIndexOf(`${ESC}[?1049h`) &&
					screen.lastIndexOf(`${ESC}[?25h`) >
						screen.lastIndexOf(`${ESC}[?25l`) &&
					existsSync(at("stty-after")),
				SIGNAL_GRACE_MS,
			);
		}
		const status = at("status");
		const settings = (name: string): string =>
			existsSync(at(name)) ? lineSettings(readFileSync(at(name), "utf8")) : "";
		const last = (sequence: string): number =>
			screen.lastIndexOf(`${ESC}[?${sequence}`);
		return {
			code: existsSync(status)
				? Number(readFileSync(status, "utf8").trim())
				: null,
			made,
			left: stores(tmp),
			childEnded: child !== undefined && !running(child),
			childOutlivedIt: existsSync(at("outlived")),
			terminalRestored:
				last("1049l") > last("1049h") &&
				last("25h") > last("25l") &&
				settings("stty-after") !== "" &&
				settings("stty-after") === settings("stty-before"),
			screen: screen.replace(CONTROL_SEQUENCES, ""),
		};
	} finally {
		writeFileSync(at("done"), "");
		if (!(await until(() => closed, SIGNAL_GRACE_MS))) {
			if (script.pid !== undefined) killProcessGroup(script.pid);
			else script.kill("SIGKILL");
		}
		await close;
	}
}

/** The store was made, and is gone with the child that held it. */
function expectRemoved(ended: Ended): void {
	expect(ended.made, ended.screen.slice(-2000)).toHaveLength(1);
	expect(ended.left).toEqual([]);
	expect(ended.childEnded).toBe(true);
}

/**
 * As expectRemoved, and hobo-code passed the signal on and outlived its
 * child, whose shell quit: the terminal restored, and the status the quit's.
 */
function expectQuit(ended: Ended): void {
	expectRemoved(ended);
	expect(ended.childOutlivedIt).toBe(false);
	expect(ended.terminalRestored, ended.screen.slice(-2000)).toBe(true);
	expect(ended.code).toBe(0);
}

describe.skipIf(skipReason !== false)(
	`hobo-code ended while its runtime holds a hobo-yard-* store${skipReason === false ? "" : ` (${skipReason})`}`,
	() => {
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
			it(
				`${signal}, passed on to the shell, which quits: removed, the terminal restored, and the status the quit's`,
				async () => {
					expectQuit(await endTheShell({ signal, to: "hobo-code" }));
				},
				RUN_TIMEOUT_MS,
			);
		}

		it(
			"the terminal closing, which hangs up hobo-code and nothing else: removed",
			async () => {
				expectRemoved(await endTheShell("close the terminal"));
			},
			RUN_TIMEOUT_MS,
		);

		it(
			"SIGKILL, which hobo-code cannot pass on: its child sees it go, quits, and the store is removed",
			async () => {
				const ended = await endTheShell({ signal: "SIGKILL", to: "hobo-code" });
				expectRemoved(ended);
				expect(ended.code).toBe(137);
			},
			RUN_TIMEOUT_MS,
		);

		it(
			"its child killed outright: hobo-code's status is 128 plus the signal's number",
			async () => {
				// Nothing can remove the store here; what is held is the status.
				const ended = await endTheShell({ signal: "SIGKILL", to: "its child" });
				expect(ended.made, ended.screen.slice(-2000)).toHaveLength(1);
				expect(ended.childEnded).toBe(true);
				expect(ended.code).toBe(137);
			},
			RUN_TIMEOUT_MS,
		);
	},
);
