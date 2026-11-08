import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "vitest";

// The temporary directories the composition makes for itself: the default
// runtime's event store (`hobo-yard-*`) when no dataDir is given, and the live
// Pulumi lane's workspace (`hobo-pulumi-live-*`) when HOBO_PULUMI_WORKDIR is
// unset. Each is removed however the process ends; a directory the caller
// names (a dataDir, a HOBO_PULUMI_WORKDIR) is the caller's, used and kept.
// Since the live lane's state is the only record of what it deployed, building
// it on a directory of its own is said on one `hobo:` line.

const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const FIXTURE = fileURLToPath(
	new URL("./fixtures/composed-temp-dirs.mts", import.meta.url),
);
// Each run imports the whole composition from source.
const RUN_TIMEOUT_MS = 180_000;
const SIGNAL_GRACE_MS = 15_000;

/**
 * A TMPDIR of the test's own, so the cases (each a process importing the whole
 * composition, mostly waiting on it) run concurrently without seeing each
 * other's directories.
 */
function scratchFor({ onTestFinished }: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-composed-temp-dirs-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

interface Ended {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	/** The `hobo-pulumi-live-*` directories in TMPDIR once the lane was built. */
	readonly made: readonly string[];
	/** The process's `hobo:` lines on stderr. */
	readonly notices: readonly string[];
}

function run(
	scratch: string,
	mode: string,
	dataDir: string,
	signal?: NodeJS.Signals,
	env: Readonly<Record<string, string>> = {},
): Promise<Ended> {
	const report = join(scratch, "report.json");
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", TSX_LOADER, FIXTURE, mode, report, dataDir],
			{
				env: {
					PATH: process.env.PATH ?? "",
					TMPDIR: scratch,
					NODE_NO_WARNINGS: "1",
					...env,
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		if (signal !== undefined) {
			const poll = setInterval(() => {
				if (!existsSync(report)) return;
				clearInterval(poll);
				child.kill(signal);
				const deadline = setTimeout(
					() => child.kill("SIGKILL"),
					SIGNAL_GRACE_MS,
				);
				child.on("close", () => clearTimeout(deadline));
			}, 50);
			child.on("close", () => clearInterval(poll));
		}
		child.on("close", (code, ended) => {
			if (!existsSync(report)) {
				reject(new Error(`the fixture ended (${code ?? ended}) unready`));
				return;
			}
			// SAFETY: the fixture writes a JSON array of directory names.
			const made = JSON.parse(readFileSync(report, "utf8")) as string[];
			const notices = stderr
				.split("\n")
				.filter((line) => line.startsWith("hobo: "));
			resolve({ code, signal: ended, made, notices });
		});
	});
}

function left(scratch: string, prefix: string): string[] {
	return readdirSync(scratch).filter((name) => name.startsWith(prefix));
}

describe.concurrent("the live Pulumi lane's own workspace", () => {
	for (const [label, mode, signal, expected] of [
		["a normal end", "normal", undefined, { code: 0, signal: null }],
		["an uncaught error", "throw", undefined, { code: 1, signal: null }],
		[
			"SIGTERM, which still ends the process",
			"wait",
			"SIGTERM",
			{ code: null, signal: "SIGTERM" },
		],
	] as const) {
		it(
			`is removed on ${label}`,
			async (context) => {
				const { expect } = context;
				const scratch = scratchFor(context);
				const yard = join(scratch, "kept-yard");
				mkdirSync(yard);
				const ended = await run(scratch, mode, yard, signal);
				expect({ code: ended.code, signal: ended.signal }).toEqual(expected);
				// The lane made its own workspace, and nothing of it is left.
				expect(ended.made).toHaveLength(1);
				expect(left(scratch, "hobo-pulumi-live-")).toEqual([]);
				// Said once: where the state is, and how to keep it.
				expect(ended.notices).toHaveLength(1);
				expect(ended.notices[0]).toContain(join(scratch, ended.made[0] ?? ""));
				expect(ended.notices[0]).toContain("HOBO_PULUMI_WORKDIR");
				// A directory the caller named is the caller's: it is kept.
				expect(existsSync(join(yard, "eventstore.sqlite"))).toBe(true);
			},
			RUN_TIMEOUT_MS,
		);
	}
});

describe.concurrent("the default runtime's own event store", () => {
	for (const [label, mode, signal, expected] of [
		["a normal end", "normal", undefined, { code: 0, signal: null }],
		["an uncaught error", "throw", undefined, { code: 1, signal: null }],
		[
			"SIGTERM, which still ends the process",
			"wait",
			"SIGTERM",
			{ code: null, signal: "SIGTERM" },
		],
	] as const) {
		it(
			`is removed on ${label}, with the live lane's workspace`,
			async (context) => {
				const { expect } = context;
				const scratch = scratchFor(context);
				const ended = await run(scratch, mode, "default", signal);
				expect({ code: ended.code, signal: ended.signal }).toEqual(expected);
				expect(left(scratch, "hobo-yard-")).toEqual([]);
				expect(left(scratch, "hobo-pulumi-live-")).toEqual([]);
			},
			RUN_TIMEOUT_MS,
		);
	}
});

describe.concurrent("a HOBO_PULUMI_WORKDIR the caller names", () => {
	for (const [label, mode, signal, expected] of [
		["a normal end", "normal", undefined, { code: 0, signal: null }],
		["an uncaught error", "throw", undefined, { code: 1, signal: null }],
		[
			"SIGTERM, which still ends the process",
			"wait",
			"SIGTERM",
			{ code: null, signal: "SIGTERM" },
		],
	] as const) {
		it(
			`is the live lane's workspace, kept on ${label}`,
			async (context) => {
				const { expect } = context;
				const scratch = scratchFor(context);
				const yard = join(scratch, "kept-yard");
				mkdirSync(yard);
				const workDir = join(scratch, "kept-pulumi");
				mkdirSync(workDir);
				writeFileSync(join(workDir, "sentinel"), "earlier state");
				const ended = await run(scratch, mode, yard, signal, {
					HOBO_PULUMI_WORKDIR: workDir,
				});
				expect({ code: ended.code, signal: ended.signal }).toEqual(expected);
				// The lane took the caller's directory: it made none of its own,
				// and has nothing to say about it.
				expect(ended.made).toEqual([]);
				expect(ended.notices).toEqual([]);
				expect(left(scratch, "hobo-pulumi-live-")).toEqual([]);
				expect(readFileSync(join(workDir, "sentinel"), "utf8")).toBe(
					"earlier state",
				);
			},
			RUN_TIMEOUT_MS,
		);
	}
});
