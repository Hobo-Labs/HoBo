/**
 * What the release gate does with an ai-bdd that hangs, prints without
 * end, or cannot be spawned (ADR-0172): HOBO_AI_BDD_TIMEOUT_MS bounds each
 * call, output is relayed but never held whole, and a command Node refuses
 * is not run. Through real processes, with test/helpers/fake-ai-bdd.mts as
 * HOBO_AI_BDD_CMD.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { checkAcceptance } from "../src/acceptance-check.js";
import { defineReleaseGate } from "../src/definition.js";
import { runStageGate } from "../src/runner.js";
import {
	ALL_PASS,
	checkOf,
	FAKE_COMMAND,
	type FakePlan,
	gone,
	killQuietly,
	newDir,
	PASSED,
	removeTempDirs,
	runGate,
	TIMEOUT,
} from "./helpers/release-gate.js";

afterEach(removeTempDirs);

describe("the release gate bounds ai-bdd", () => {
	it(
		"a hung ai-bdd is stopped with its process group at HOBO_AI_BDD_TIMEOUT_MS, and the check is not run",
		async () => {
			const pidFile = join(newDir(), "child.pid");
			const sleepMs = 40_000;
			const run = await runGate(
				{
					...ALL_PASS,
					run: { exit: 0, report: PASSED, sleepMs, pidFile },
				},
				FAKE_COMMAND,
				newDir(),
				// 5 s, as the next test's: the bound counts from ai-bdd's spawn and the stand-in
				// must launch (a Node startup) and write pidFile inside it, which 1.5 s does not
				// leave under load.
				{ HOBO_AI_BDD_TIMEOUT_MS: "5000" },
			);
			const finished = Date.now();
			// Killed at the bound, not ended by the stand-in waking up: a bound that only marked the run would wait the whole sleepMs.
			// Counted from the stand-in's own start (it writes pidFile as it begins), not from the
			// test's: the Node startups of the checks before and around it are not the bound's.
			expect(finished - statSync(pidFile).mtimeMs).toBeLessThan(sleepMs / 2);
			const replay = checkOf(run, "acceptance-replay");
			expect(replay).toMatchObject({ status: "not_run", exitCode: 3 });
			expect(replay.evidence.reason).toBe(
				"ai-bdd run --frozen --no-agent --reporter json,junit did not finish within 5000 ms (HOBO_AI_BDD_TIMEOUT_MS): its process group was sent SIGTERM, and SIGKILL after 10 s",
			);
			expect(run.result.record.status).toBe("not_run");
			// The child it started in its own group went with it (a browser Playwright launches is not in it: see the next test).
			const child = Number(readFileSync(pidFile, "utf8"));
			expect(await gone(child)).toBe(true);
		},
		TIMEOUT,
	);

	it.each([
		// The bound counts from ai-bdd's spawn, and the stand-in takes 240 to 770 ms
		// (load 33) to launch its browser and write browser.pid: 1.5 s left about
		// 0.7 s of headroom. 5 s is still well under the stand-in's 40 s.
		[
			"at HOBO_AI_BDD_TIMEOUT_MS",
			{ HOBO_AI_BDD_TIMEOUT_MS: "5000" },
			undefined,
		],
		// The backstop counts from the check's spawn, and two Node startups (the tsx
		// check, then the stand-in) come before the stand-in launches its browser:
		// 1.3 to 2.5 s at load average 35 on 4 CPUs, and past 5 s at 57 to 67, where
		// a 5 s backstop stopped it before any browser.pid was written. 15 s leaves
		// that headroom and is still well under the stand-in's 40 s.
		["by the runner's backstop", { HOBO_AI_BDD_TIMEOUT_MS: "600000" }, 15_000],
	])(
		"a hung ai-bdd stopped %s gets SIGTERM first, so the browser it launched in a group of its own is closed",
		async (_label, env, replayBackstopMs) => {
			const detachedPidFile = join(newDir(), "browser.pid");
			const run = await runGate(
				{
					...ALL_PASS,
					run: { exit: 0, report: PASSED, sleepMs: 40_000, detachedPidFile },
				},
				FAKE_COMMAND,
				newDir(),
				env,
				replayBackstopMs,
			);
			expect(checkOf(run, "acceptance-replay")).toMatchObject({
				status: "not_run",
				exitCode: 3,
			});
			// A group kill never reaches it; the stand-in ends it on SIGTERM, as Playwright does.
			const browser = Number(readFileSync(detachedPidFile, "utf8"));
			try {
				expect(await gone(browser)).toBe(true);
			} finally {
				killQuietly(browser);
			}
		},
		TIMEOUT,
	);

	it(
		"the stand-in closes its browser although it is signalled the moment the browser is up",
		async () => {
			// Its handlers must already be there: a test that signals it then is a gate that stops it then.
			const dir = newDir();
			const detachedPidFile = join(dir, "browser.pid");
			const [node = "", ...fakeArgs] = FAKE_COMMAND;
			const plan: FakePlan = {
				...ALL_PASS,
				run: {
					exit: 0,
					report: PASSED,
					sleepMs: 40_000,
					detachedPidFile,
					pauseAfterBrowserMs: 3000,
				},
			};
			const fake = spawn(node, [...fakeArgs, "run"], {
				cwd: dir,
				env: {
					...process.env,
					FAKE_AI_BDD: JSON.stringify(plan),
					FAKE_AI_BDD_LOG: join(dir, "calls.log"),
				},
				stdio: "ignore",
				// A group of its own, as the gate gives ai-bdd: what it leaves in it is ended below.
				detached: true,
			});
			const exited = new Promise((done) => fake.on("exit", done));
			let browser = 0;
			try {
				for (
					let tries = 0;
					tries < 300 && !existsSync(detachedPidFile);
					tries += 1
				) {
					await new Promise((done) => setTimeout(done, 50));
				}
				browser = Number(readFileSync(detachedPidFile, "utf8"));
				fake.kill("SIGTERM");
				await exited;
				expect(await gone(browser)).toBe(true);
			} finally {
				killQuietly(browser);
				try {
					// Never -0: that would be this test's own group.
					if (fake.pid !== undefined) process.kill(-fake.pid, "SIGKILL");
				} catch {
					// Its group is gone.
				}
			}
		},
		TIMEOUT,
	);

	it("each release check's backstop is ai-bdd's bound in the runner's env, plus a minute", () => {
		const env = { HOBO_AI_BDD_TIMEOUT_MS: "1000" };
		// The env the runner is given, not the one defineReleaseGate() ran in.
		expect(process.env.HOBO_AI_BDD_TIMEOUT_MS).toBeUndefined();
		const bounds = defineReleaseGate().checks.map((check) =>
			check.timeoutMs instanceof Function
				? check.timeoutMs(env)
				: check.timeoutMs,
		);
		expect(bounds).toEqual([61_000, 61_000, 61_000]);
	});

	it(
		"the runner bounds a check by a timeoutMs computed from the env it runs the check with",
		async () => {
			const { record } = await runStageGate(
				{
					gateId: "release",
					checks: [
						{
							checkId: "slow",
							kind: "acceptance",
							command: [process.execPath, "-e", "setTimeout(() => {}, 8000)"],
							timeoutMs: (env) => Number(env.SLOW_BOUND_MS),
						},
					],
				},
				{ cwd: newDir(), env: { SLOW_BOUND_MS: "400" } },
			);
			expect(record.checks[0]).toMatchObject({
				status: "not_run",
				exitCode: 3,
			});
			expect(record.checks[0]?.evidence.error).toContain(
				"did not finish within 400 ms (timeoutMs)",
			);
		},
		TIMEOUT,
	);

	it.each(["0", "-5", "abc", "1.5", ""])(
		"HOBO_AI_BDD_TIMEOUT_MS=%j is a usage error",
		async (value) => {
			const run = await runGate(ALL_PASS, FAKE_COMMAND, newDir(), {
				HOBO_AI_BDD_TIMEOUT_MS: value,
			});
			const plans = checkOf(run, "acceptance-plans-fresh");
			expect(plans).toMatchObject({ status: "failed", exitCode: 2 });
			expect(plans.evidence.reason).toContain("HOBO_AI_BDD_TIMEOUT_MS");
		},
		TIMEOUT,
	);

	it(
		"a passing replay that prints more than 16 MiB is not killed for its output",
		async () => {
			const run = await runGate({
				...ALL_PASS,
				run: { exit: 0, report: PASSED, outputBytes: 20 * 1024 * 1024 },
			});
			expect(checkOf(run, "acceptance-replay").status).toBe("passed");
			expect(run.result.record.status).toBe("passed");
		},
		TIMEOUT,
	);

	it("a command Node refuses to spawn (as it refuses a .cmd shim on Windows) is not run", async () => {
		const project = newDir();
		// spawn() throws synchronously for an argument it will not pass to the OS.
		const result = await checkAcceptance(
			["plans-fresh"],
			{
				...process.env,
				HOBO_AI_BDD_CMD: JSON.stringify(["ai\u0000bdd"]),
				HOBO_AI_BDD_PROJECT: project,
			},
			project,
		);
		expect(result).toMatchObject({ outcome: "not_run", exitCode: 3 });
		expect(result.evidence.reason).toMatch(
			/^ai-bdd compile --check did not run: /u,
		);
	});
});
