/**
 * runAiBdd on its own (ADR-0172): how one ai-bdd command is stopped. The
 * release-gate suites drive it through the gate; these give it commands that
 * misbehave in one way each.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { runAiBdd } from "../src/ai-bdd-process.js";
import { killQuietly, REPO_ROOT } from "./helpers/release-gate.js";

const STOP_SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"helpers",
	"stop-ai-bdd.mts",
);

const ACTIVE_RESOURCES_SCRIPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"helpers",
	"report-active-resources.mts",
);

function nodeCommand(source: string): readonly string[] {
	return [process.execPath, "-e", source];
}

describe("runAiBdd stops a command that outlives its bound", () => {
	it("with SIGTERM to its group, then SIGKILL once the grace period ends", async () => {
		const started = Date.now();
		const run = await runAiBdd(
			{
				command: nodeCommand(
					"process.on('SIGTERM', () => console.log('SIGTERM ignored')); setInterval(() => {}, 1000)",
				),
				cwd: tmpdir(),
				env: process.env,
				timeoutMs: 500,
				graceMs: 1500,
				relay: () => undefined,
			},
			[],
		);
		const took = Date.now() - started;
		expect(run.timedOut).toBe(true);
		expect(run.status).toBeNull();
		// It was asked first, and killed only when it did not go.
		expect(run.tail).toContain("SIGTERM ignored");
		expect(took).toBeGreaterThanOrEqual(1900);
		expect(took).toBeLessThan(10_000);
	}, 30_000);
});

describe("runAiBdd settles when the command exits", () => {
	it("although a process outside its group still holds its output open", async () => {
		const started = Date.now();
		const run = await runAiBdd(
			{
				// It exits at once, leaving a detached child that inherited its stdout and stderr.
				command: nodeCommand(
					"const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'inherit' }); console.log('holder ' + c.pid); c.unref()",
				),
				cwd: tmpdir(),
				env: process.env,
				timeoutMs: 20_000,
				graceMs: 1000,
				relay: () => undefined,
			},
			[],
		);
		const holder = Number(/holder (\d+)/u.exec(run.tail)?.[1] ?? 0);
		try {
			expect(run).toMatchObject({ status: 0, timedOut: false });
			expect(Date.now() - started).toBeLessThan(10_000);
		} finally {
			killQuietly(holder);
		}
	}, 40_000);
});

describe("the check once ai-bdd has settled", () => {
	it("exits at once: no timer of the run keeps its process alive", async () => {
		// check-acceptance.mts prints its evidence line last; nothing should be left to wait for after it.
		const dir = mkdtempSync(join(tmpdir(), "hobo-active-resources-"));
		const activeFile = join(dir, "active.json");
		const check = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--import",
				pathToFileURL(ACTIVE_RESOURCES_SCRIPT).href,
				"packages/stage-gate/scripts/check-acceptance.mts",
				"plans-fresh",
			],
			{
				cwd: REPO_ROOT,
				env: {
					...process.env,
					HOBO_AI_BDD_CMD: JSON.stringify(nodeCommand("process.exit(0)")),
					HOBO_AI_BDD_PROJECT: tmpdir(),
					// The run's own timer: 30 s here, so one left armed holds the process far longer than a teardown takes.
					HOBO_AI_BDD_TIMEOUT_MS: "30000",
					ACTIVE_RESOURCES_FILE: activeFile,
				},
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		let printedAt = 0;
		check.stdout.on("data", () => {
			printedAt = Date.now();
		});
		// 10 s after the evidence line is far past any teardown under load; a process still alive then is held.
		const watchdog = setInterval(() => {
			if (printedAt > 0 && Date.now() - printedAt > 10_000) {
				check.kill("SIGKILL");
			}
		}, 250);
		try {
			const ended = await new Promise((done) =>
				check.on("exit", (status, signal) => done({ status, signal })),
			);
			// No wall clock: the resources that kept the loop alive when the line was written.
			expect(existsSync(activeFile)).toBe(true);
			// SAFETY: report-active-resources.mts writes a JSON array of strings.
			const active = JSON.parse(readFileSync(activeFile, "utf8")) as string[];
			expect(active.filter((type) => type === "Timeout")).toEqual([]);
			expect(ended).toEqual({ status: 0, signal: null });
			expect(Date.now() - printedAt).toBeLessThan(10_000);
		} finally {
			clearInterval(watchdog);
			check.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("runAiBdd on Linux, where a group can hold only zombies", () => {
	it.runIf(process.platform === "linux")(
		"is done with a group whose only member is a zombie its parent never reaps",
		async () => {
			// The inner shell leaves `sleep 0.1` in ai-bdd's group, then moves itself to a
			// session of its own (setsid) as a node process that never waits for it, and
			// writes $READY once /proc shows the sleep a zombie. ai-bdd (the outer shell)
			// exits only then, so the group holds one zombie, as under a PID 1 or
			// subreaper that does not reap, and no live member for the stop to end early.
			const ready = join(
				tmpdir(),
				`hobo-zombie-only-${process.pid}-${Date.now()}.ready`,
			);
			const run = await runAiBdd(
				{
					command: [
						"sh",
						"-c",
						`sh -c 'sleep 0.1 & echo holder $$; exec setsid "$NODE" -e "$HOBO_TEST_JS" $! >/dev/null 2>&1' & ${UNTIL_READY}`,
					],
					cwd: tmpdir(),
					env: {
						...process.env,
						HOBO_TEST_JS: ZOMBIE_PARENT_JS,
						NODE: process.execPath,
						READY: ready,
					},
					timeoutMs: 20_000,
					graceMs: 5000,
					relay: () => undefined,
				},
				[],
			);
			const finished = Date.now();
			try {
				expect(existsSync(ready)).toBe(true);
				expect(run.status).toBe(0);
				// Not the 5 s grace: a zombie is not a member to wait for. Counted from
				// $READY, so the member's own startup is not the stop's time.
				expect(finished - statSync(ready).mtimeMs).toBeLessThan(3000);
			} finally {
				killQuietly(Number(/holder (\d+)/u.exec(run.tail)?.[1] ?? 0));
				rmSync(ready, { force: true });
			}
		},
		30_000,
	);

	it.runIf(process.platform === "linux" && HAS_PYTHON3)(
		"kills a member whose main thread exited while its other threads run, although /proc shows it Z",
		async () => {
			// The member ignores SIGTERM, says so in $READY, starts a thread that writes the
			// marker 3 s later, and ends its main thread (pthread_exit): /proc shows Z with
			// num_threads 2. ai-bdd (the shell) exits once $READY is there, so the stop's
			// SIGTERM never comes before the member ignores it, however slowly it starts.
			const marker = join(
				tmpdir(),
				`hobo-leader-exit-${process.pid}-${Date.now()}`,
			);
			const ready = `${marker}.ready`;
			const started = Date.now();
			const run = await runAiBdd(
				{
					command: [
						"sh",
						"-c",
						`python3 -c "$HOBO_TEST_PY" >/dev/null 2>&1 & echo holder $!; ${UNTIL_READY}`,
					],
					cwd: tmpdir(),
					env: {
						...process.env,
						HOBO_TEST_PY: LEADER_EXIT_PY,
						MARKER: marker,
						READY: ready,
					},
					timeoutMs: 20_000,
					graceMs: 1500,
					relay: () => undefined,
				},
				[],
			);
			const took = Date.now() - started;
			try {
				// Past the moment the thread would have written the marker, had it lived.
				await new Promise((done) =>
					setTimeout(done, Math.max(0, started + 4000 - Date.now())),
				);
				expect(existsSync(ready)).toBe(true);
				expect(run.status).toBe(0);
				expect(existsSync(marker)).toBe(false);
				expect(took).toBeGreaterThanOrEqual(1500);
			} finally {
				killQuietly(Number(/holder (\d+)/u.exec(run.tail)?.[1] ?? 0));
				rmSync(marker, { force: true });
				rmSync(ready, { force: true });
			}
		},
		30_000,
	);
});

const HAS_PYTHON3 = spawnSync("python3", ["-c", ""]).status === 0;

/** The shell's wait for its member to write $READY (20 s at most), then its exit. */
const UNTIL_READY =
	'i=0; until [ -e "$READY" ] || [ $i -ge 400 ]; do sleep 0.05; i=$((i+1)); done; exit 0';

/** Ignores SIGTERM, writes $READY, starts a thread that writes $MARKER after 3 s, and ends its main thread. */
const LEADER_EXIT_PY = [
	"import ctypes, os, signal, threading, time",
	"signal.signal(signal.SIGTERM, signal.SIG_IGN)",
	"open(os.environ['READY'], 'w').close()",
	"def later():",
	"    time.sleep(3)",
	"    open(os.environ['MARKER'], 'w').close()",
	"threading.Thread(target=later).start()",
	"ctypes.CDLL(None).pthread_exit(None)",
].join("\n");

/** Waits for the zombie its argv names (a child of this process, which never waits for it), then writes $READY. */
const ZOMBIE_PARENT_JS = [
	"const fs = require('node:fs');",
	"const state = () => {",
	"  try { return /^State:\\s+(\\S)/mu.exec(fs.readFileSync('/proc/' + process.argv[1] + '/status', 'utf8'))?.[1]; } catch { return undefined; }",
	"};",
	"const tick = () => { if (state() === 'Z') fs.writeFileSync(process.env.READY, ''); else setTimeout(tick, 20); };",
	"tick();",
	"setTimeout(() => {}, 8000);",
].join("\n");

interface StopOutcome {
	readonly stopMs: number;
	readonly tail: string;
	readonly afterStatus: number | null;
	readonly afterUnstartable: string;
}

describe("stopRunningAiBdd, as the check calls it on its own SIGINT or SIGTERM", () => {
	it("passes that signal on, is done once the group is gone, and starts no ai-bdd after", async () => {
		const answer = (signal: string) =>
			`process.on('${signal}', () => { console.log('got ${signal}'); process.exit(0); });`;
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--import",
				"tsx",
				STOP_SCRIPT,
				"SIGINT",
				"20000",
				JSON.stringify(
					nodeCommand(
						`${answer("SIGINT")} ${answer("SIGTERM")} console.log('up'); setInterval(() => {}, 1000)`,
					),
				),
				JSON.stringify(nodeCommand("process.exit(0)")),
			],
			{ cwd: REPO_ROOT, timeout: 60_000 },
		);
		// SAFETY: stop-ai-bdd.mts prints one StopOutcome as JSON.
		const outcome = JSON.parse(stdout) as StopOutcome;
		// The signal the check got, not SIGTERM in its place.
		expect(outcome.tail).toContain("got SIGINT");
		// The group was gone at once: the 20 s grace was not waited out.
		expect(outcome.stopMs).toBeLessThan(5000);
		expect(outcome).toMatchObject({
			afterStatus: null,
			afterUnstartable: "not started: the check was stopped by SIGINT",
		});
	}, 60_000);
});
