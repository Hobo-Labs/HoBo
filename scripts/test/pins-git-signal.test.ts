/**
 * A git ended by a signal is `128 + its number` and "killed by SIG..." however
 * it was run: directly, under the deadline wrapper (`git()` with a deadline),
 * or streamed (`netGitWatched`). Through the wrapper the signal used to
 * become a plain exit 128, so the same OOM kill read as "exited 128: " there
 * and "killed by SIGKILL" on a direct call. A real exit status is left alone:
 * 129 is git's usage error, not a SIGHUP. The edges of the wrapper's way of
 * doing it (a core file, the inspector, SIGPIPE) are in
 * `pins-git-signal-edges.test.ts`.
 *
 * A stand-in `git` first on PATH ends itself the way the test says.
 */
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	lib,
	REAL_GIT,
	runWithStandIn,
} from "./support/pins-signal-support.ts";
import {
	git,
	makeRemote,
	makeWork,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

/** Every signal a git can plausibly die of: the wrapper re-raises six and exits 128 + N for the rest. */
const SIGNALS = [
	"SIGHUP",
	"SIGINT",
	"SIGTERM",
	"SIGKILL",
	"SIGUSR2",
	"SIGALRM",
	"SIGQUIT",
	"SIGABRT",
	"SIGSEGV",
	"SIGUSR1",
	"SIGPIPE",
] as const;

/** The ones the end-to-end refusal is walked for: it does not depend on how the wrapper ends. */
const REFUSED_FOR = ["SIGKILL", "SIGTERM", "SIGSEGV"] as const;

/** One program: the same stand-in git run directly, under the wrapper, and streamed. */
const PROGRAM = `
const core = await import(${lib("pins-git-core.ts")});
const stream = await import(${lib("pins-git-stream.ts")});
const row = (what, r) => ({ status: r.status, signal: r.signal ?? null, said: core.gitFailure(what, r) });
const direct = core.git(process.cwd(), ["status"]);
const wrapped = core.git(process.cwd(), ["ls-remote", "x"], {}, { ms: 30000, what: "ls-remote" });
const streamed = await stream.netGitWatched(process.cwd(), ["fetch", "x"], { allowLocal: true }, false);
console.log(JSON.stringify({ direct: row("git status", direct), wrapped: row("git ls-remote", wrapped), streamed: row("git fetch", streamed) }));
`;

interface Row {
	readonly status: number;
	readonly signal: string | null;
	readonly said: string;
}

function runAll(
	action: string,
): Record<"direct" | "wrapped" | "streamed", Row> {
	const { run } = runWithStandIn(PROGRAM, action);
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout);
}

describe("a git ended by a signal, however it was run", () => {
	for (const signal of SIGNALS) {
		it(`${signal}: direct, under the deadline wrapper and streamed all say 128 + its number and the signal`, () => {
			const number = constants.signals[signal];
			const rows = runAll(`kill:${signal}`);
			for (const [how, row] of Object.entries(rows)) {
				assert.equal(
					row.status,
					128 + number,
					`${how}: ${JSON.stringify(row)}`,
				);
				assert.equal(row.signal, signal, `${how}: ${JSON.stringify(row)}`);
				assert.match(
					row.said,
					new RegExp(`was killed by ${signal}$`, "u"),
					how,
				);
			}
		});
	}

	for (const code of [3, 128, 129, 137]) {
		it(`exit ${code} is an exit, not a signal, however it was run`, () => {
			const rows = runAll(`exit:${code}`);
			for (const [how, row] of Object.entries(rows)) {
				assert.equal(row.status, code, `${how}: ${JSON.stringify(row)}`);
				assert.equal(row.signal, null, `${how}: ${JSON.stringify(row)}`);
				assert.match(row.said, new RegExp(`exited ${code}:`, "u"), how);
			}
		});
	}
});

describe("a stale-URL read ended by a signal still refuses before any network call", () => {
	for (const signal of REFUSED_FOR) {
		it(`${signal}: status, fetch and setup exit 1 and run no network git`, () => {
			const dir = scratch("signal-e2e");
			const remote = makeRemote(dir);
			const work = makeWork(dir, remote, 1);
			const bin = join(dir, "calls-bin");
			mkdirSync(bin);
			const calls = join(dir, "calls.log");
			writeFileSync(
				join(bin, "git"),
				`#!/bin/sh
ulimit -c 0 2>/dev/null
echo "$*" >> '${calls}'
case "$*" in *--show-scope*submodule.*.url*) kill -s ${signal.slice(3)} $$ ;; esac
exec '${REAL_GIT}' "$@"
`,
			);
			chmodSync(join(bin, "git"), 0o755);
			const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
			for (const args of [["--status", "--offline"], ["--fetch", "lib"], []]) {
				const run = runBootstrap(work, args, env);
				assert.equal(
					run.status,
					1,
					`${args.join(" ")}: ${run.stdout}${run.stderr}`,
				);
				assert.match(
					`${run.stdout}${run.stderr}`,
					new RegExp(`git config was killed by ${signal}`, "u"),
				);
			}
			const made = existsSync(calls) ? readFileSync(calls, "utf8") : "";
			assert.doesNotMatch(
				made,
				/protocol\.allow|ls-remote|clone|fetch|submodule update/u,
				"no call that can reach the network",
			);
			assert.equal(existsSync(join(work, "external/lib/.git")), false);
			assert.equal(git(work, ["status", "--porcelain"]).includes("lib"), false);
		});
	}
});
