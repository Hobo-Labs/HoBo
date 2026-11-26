/**
 * A person at a terminal sees git's progress while the submodule is fetched,
 * as it arrives: when the script's stderr is a terminal, the visible git gets
 * `--progress` and its stderr is passed on live (a bounded tail is kept for
 * the failure hint). Without a terminal nothing changes: no progress meter,
 * and git's messages are printed once the call returns.
 *
 * The end-to-end terminal is a real pseudo-terminal made by util-linux
 * `script(1)`; where that `script` is missing (BSD and macOS have another
 * with other options) that case is skipped and says why. The decision itself,
 * and the live pass-through, are checked everywhere without a terminal.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { onTerminal, progressArgs } from "../lib/pins-git-stream.ts";
import {
	gitEnv,
	makeRemote,
	makeWork,
	REPO_ROOT,
	runBootstrap,
	SCRIPT,
	scratch,
} from "./support/pins-support.ts";

const PROGRESS = /Enumerating objects|Counting objects|Receiving objects/u;

/** Why the pseudo-terminal case cannot run here, or false when it can. */
function noUtilLinuxScript(): string | false {
	const needs = "needs util-linux script(1) for a pseudo-terminal";
	const probe = spawnSync("script", ["--version"], { encoding: "utf8" });
	if (probe.error !== undefined) return `${needs}: ${probe.error.message}`;
	const said = `${probe.stdout}${probe.stderr}`.trim().replace(/\s+/gu, " ");
	if (!/util-linux/u.test(said))
		return `${needs}; \`script --version\` said: ${said || `exit ${probe.status}`}`;
	return false;
}

describe("git's progress during pins:fetch", () => {
	it("is shown live on a terminal", { skip: noUtilLinuxScript() }, () => {
		const dir = scratch("progress-tty");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 1);
		const command = `'${process.execPath}' --experimental-strip-types '${SCRIPT}' --root '${work}' --fetch lib`;
		const run = spawnSync("script", ["-qec", command, "/dev/null"], {
			cwd: work,
			encoding: "utf8",
			env: gitEnv({
				NODE_OPTIONS: "",
				NODE_NO_WARNINGS: "1",
				HOME: join(work, ".home"),
				XDG_CACHE_HOME: join(work, ".cache"),
				HOBO_PINS_ALLOW_LOCAL: "1",
				GIT_PROGRESS_DELAY: "0",
			}),
		});
		assert.equal(run.status, 0, run.stdout);
		const lines = run.stdout.replace(/\r/gu, "\n").split("\n");
		const progress = lines.filter((line) => PROGRESS.test(line));
		assert.ok(
			progress.length >= 2,
			`progress lines: ${progress.length}\n${run.stdout}`,
		);
		const cloning = lines.findIndex((line) => line.includes("Cloning into"));
		const checkedOut = lines.findIndex((line) =>
			line.includes("Submodule path 'external/lib': checked out"),
		);
		assert.ok(
			cloning >= 0 && cloning < checkedOut,
			`"Cloning into" comes as it happens, before "checked out":\n${run.stdout}`,
		);
	});

	it("is not shown without a terminal, where git's messages still arrive", () => {
		const dir = scratch("progress-pipe");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 1);
		const run = runBootstrap(work, ["--fetch", "lib"], {
			GIT_PROGRESS_DELAY: "0",
		});
		assert.equal(run.status, 0, run.stderr);
		assert.doesNotMatch(run.stderr, PROGRESS);
		assert.match(run.stderr, /Cloning into/u);
	});
});

describe("the progress decision, without a terminal", () => {
	it("asks git for --progress only when stderr is a terminal", () => {
		assert.deepEqual(progressArgs({ isTTY: true }), ["--progress"]);
		assert.deepEqual(progressArgs({ isTTY: false }), []);
		assert.deepEqual(progressArgs({}), []);
		assert.equal(onTerminal({ isTTY: true }), true);
		assert.equal(onTerminal({}), false);
	});

	for (const live of [true, false]) {
		it(`${live ? "passes" : "holds"} git's stderr ${live ? "on as it arrives" : "until git ends"} when live is ${live}`, async () => {
			// A `git` that says one line, then waits for the test to let it end.
			const dir = scratch("progress-live");
			const bin = join(dir, "bin");
			mkdirSync(bin);
			const release = join(dir, "release");
			writeFileSync(
				join(bin, "git"),
				`#!/bin/sh\necho 'Cloning into stand-in...' >&2\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\n`,
				{ mode: 0o755 },
			);
			const stream = pathToFileURL(
				join(REPO_ROOT, "scripts/lib/pins-git-stream.ts"),
			).href;
			const program = `import(${JSON.stringify(stream)}).then(({ netGitWatched }) => netGitWatched(process.cwd(), ["fetch"], { allowLocal: true }, ${live}))`;
			const child = spawn(
				process.execPath,
				["--experimental-strip-types", "-e", program],
				{
					cwd: dir,
					stdio: ["ignore", "ignore", "pipe"],
					env: {
						...process.env,
						NODE_OPTIONS: "",
						NODE_NO_WARNINGS: "1",
						PATH: `${bin}:${process.env.PATH ?? ""}`,
					},
				},
			);
			let said = "";
			child.stderr.on("data", (chunk: Buffer) => {
				said += chunk.toString("utf8");
			});
			const ended = new Promise<number | null>((resolve) =>
				child.on("close", resolve),
			);
			// Live: the line arrives while git is still running. Held: nothing
			// arrives in that time, however long it is given.
			const deadline = Date.now() + (live ? 10_000 : 1500);
			while (!said.includes("Cloning into") && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			const beforeEnd = said;
			writeFileSync(release, "");
			assert.equal(await ended, 0, said);
			assert.equal(beforeEnd.includes("Cloning into"), live, beforeEnd);
			assert.match(said, /Cloning into stand-in/u);
		});
	}
});
