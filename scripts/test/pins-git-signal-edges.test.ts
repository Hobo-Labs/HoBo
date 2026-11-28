import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { lib, runWithStandIn } from "./support/pins-signal-support.ts";

const WRAPPED = `
const core = await import(${lib("pins-git-core.ts")});
const r = core.git(process.cwd(), ["ls-remote", "x"], {}, { ms: 30000, what: "ls-remote" });
console.log(JSON.stringify({ status: r.status, signal: r.signal ?? null, said: core.gitFailure("git ls-remote", r), stderr: r.stderr }));
`;

const TIMED = `
const core = await import(${lib("pins-git-core.ts")});
const time = (action) => {
	const start = Date.now();
	const r = core.git(process.cwd(), ["ls-remote", "x"], { STANDIN_ACTION: action }, { ms: 30000, what: "ls-remote" });
	return { ms: Date.now() - start, status: r.status, signal: r.signal ?? null };
};
const fastest = (action) => [time(action), time(action), time(action)].sort((a, b) => a.ms - b.ms)[0];
console.log(JSON.stringify({ exit: fastest("exit:3"), pipe: fastest("kill:SIGPIPE") }));
`;

const CORE_PATTERN = (() => {
	try {
		return readFileSync("/proc/sys/kernel/core_pattern", "utf8").trim();
	} catch {
		return "";
	}
})();
const CORE_IN_CWD = /^[^/|]/u.test(CORE_PATTERN);

describe("the wrapper and the signals it does not re-raise", () => {
	it("SIGUSR1 in git: no inspector, the signal named", () => {
		const { run } = runWithStandIn(WRAPPED, "kill:SIGUSR1");
		assert.equal(run.status, 0, run.stderr);
		const row = JSON.parse(run.stdout);
		assert.doesNotMatch(
			`${row.said}${row.stderr}`,
			/Debugger|ws:\/\//u,
			"the wrapper must not open Node's inspector",
		);
		assert.deepEqual(
			[row.status, row.signal, row.said],
			[138, "SIGUSR1", "git ls-remote was killed by SIGUSR1"],
		);
	});

	it("SIGPIPE in git: 141 and the name, without waiting for a fallback timer", () => {
		const { run } = runWithStandIn(TIMED, "exit:3");
		assert.equal(run.status, 0, run.stderr);
		const { exit, pipe } = JSON.parse(run.stdout);
		assert.equal(exit.status, 3);
		assert.deepEqual([pipe.status, pipe.signal], [141, "SIGPIPE"]);
		assert.ok(
			pipe.ms - exit.ms < 700,
			`SIGPIPE took ${pipe.ms} ms against ${exit.ms} ms for a plain exit`,
		);
	});

	for (const signal of ["SIGSEGV", "SIGABRT", "SIGQUIT"]) {
		it(`${signal} in git: the wrapper writes no core file of its own`, {
			skip: CORE_IN_CWD
				? false
				: `core_pattern is "${CORE_PATTERN}": a core file would not land in the working directory`,
		}, () => {
			const { dir, run } = runWithStandIn(WRAPPED, `kill:${signal}`, true);
			assert.equal(run.status, 0, run.stderr);
			assert.equal(JSON.parse(run.stdout).signal, signal);
			assert.deepEqual(
				readdirSync(dir).filter((name) => name.startsWith("core")),
				[],
				"a core file in the directory git ran in (ulimit -c unlimited)",
			);
		});
	}
});
