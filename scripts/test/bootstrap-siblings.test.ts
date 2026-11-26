/**
 * `scripts/bootstrap-siblings.mts` for git pins, against real repositories on
 * disk: a throwaway remote, a work tree whose submodule is uninitialised, and
 * the real script run under Node's native type stripping.
 *
 * The pin is the submodule's gitlink, so every case here is a statement about
 * what `git submodule update --depth 1`, sparse-checkout and the index end up
 * holding, never about the script's own bookkeeping.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	git,
	makeReference,
	makeRemote,
	makeWork,
	type PinsFileOptions,
	type Remote,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

interface Fixture {
	readonly dir: string;
	readonly remote: Remote;
	readonly work: string;
	readonly reference: string;
	readonly sub: string;
}

function fixture(pinned = 1, options: PinsFileOptions = {}): Fixture {
	const dir = scratch("git");
	const remote = makeRemote(dir);
	const work = makeWork(dir, remote, pinned, options);
	return {
		dir,
		remote,
		work,
		reference: makeReference(dir, remote),
		sub: join(work, "external/lib"),
	};
}

const short = (commit: string | undefined): string =>
	(commit ?? "").slice(0, 7);

function lines(stdout: string): string[] {
	return stdout.split("\n");
}

function ok(run: { status: number | null; stdout: string; stderr: string }) {
	assert.equal(
		run.status,
		0,
		`exit ${run.status}\n${run.stdout}\n${run.stderr}`,
	);
	return run;
}

describe("bootstrap-siblings: initialising a git pin", () => {
	it("initialises a submodule at the gitlink commit, shallow, from a local reference", () => {
		const f = fixture(1);
		const run = ok(runBootstrap(f.work, ["--reference", f.reference]));
		assert.match(
			run.stdout,
			new RegExp(`lib {2}initialised at ${short(f.remote.shas[1])}`),
		);
		assert.match(run.stdout, /borrowed from .*; keep that clone in place\)/);
		// The gitlink, not the branch tip: shas[2] is the tip and is not what was asked for.
		assert.equal(git(f.sub, ["rev-parse", "HEAD"]), f.remote.shas[1]);
		assert.equal(git(f.sub, ["rev-parse", "--is-shallow-repository"]), "true");
		const gitDir = git(f.sub, ["rev-parse", "--absolute-git-dir"]);
		assert.match(
			readFileSync(join(gitDir, "objects/info/alternates"), "utf8"),
			new RegExp(`${f.reference}/\\.git/objects`),
		);
	});

	it("sparse cone leaves only the configured paths and the root files", () => {
		const f = fixture(1, { sparse: ["packages/a"] });
		const run = ok(runBootstrap(f.work, ["--reference", f.reference]));
		assert.match(run.stdout, /sparse: packages\/a/);
		assert.ok(existsSync(join(f.sub, "README.md")), "root files stay");
		assert.ok(
			existsSync(join(f.sub, "packages/a/x.txt")),
			"the configured path stays",
		);
		assert.equal(existsSync(join(f.sub, "packages/b")), false);
		assert.equal(existsSync(join(f.sub, "docs")), false);
	});

	it("a second run changes nothing and says already pinned", () => {
		const f = fixture(1, { sparse: ["packages/a"] });
		ok(runBootstrap(f.work, ["--reference", f.reference]));
		const reflog = git(f.sub, ["reflog", "--format=%H %gs"]);
		const config = readFileSync(
			join(git(f.sub, ["rev-parse", "--absolute-git-dir"]), "config"),
			"utf8",
		);
		const again = ok(runBootstrap(f.work, ["--reference", f.reference]));
		assert.ok(
			lines(again.stdout).includes(
				`lib  already pinned at ${short(f.remote.shas[1])}`,
			),
			again.stdout,
		);
		assert.equal(
			git(f.sub, ["reflog", "--format=%H %gs"]),
			reflog,
			"HEAD did not move",
		);
		assert.equal(
			readFileSync(
				join(git(f.sub, ["rev-parse", "--absolute-git-dir"]), "config"),
				"utf8",
			),
			config,
			"the repository configuration did not change",
		);
	});

	it("falls back to a full fetch when the server refuses a fetch of that commit", () => {
		const f = fixture(1);
		for (const key of [
			"allowAnySHA1InWant",
			"allowReachableSHA1InWant",
			"allowTipSHA1InWant",
		]) {
			git(f.remote.dir, ["config", `uploadpack.${key}`, "false"]);
		}
		// Protocol v0 is where a server can refuse an unadvertised commit.
		const run = ok(runBootstrap(f.work, [], {}, [["protocol.version", "0"]]));
		assert.match(run.stdout, /initialised at/);
		assert.match(run.stdout, /full/);
		assert.equal(git(f.sub, ["rev-parse", "HEAD"]), f.remote.shas[1]);
		assert.equal(git(f.sub, ["rev-parse", "--is-shallow-repository"]), "false");
	});

	it("refuses to move a submodule that has uncommitted changes", () => {
		const f = fixture(1);
		ok(runBootstrap(f.work, ["--reference", f.reference]));
		git(f.sub, ["checkout", "-q", f.remote.shas[2] ?? ""]);
		writeFileSync(join(f.sub, "README.md"), "local edit\n");
		const run = runBootstrap(f.work, ["--reference", f.reference]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /SUBMODULE_STATE.*uncommitted changes/);
		assert.equal(
			git(f.sub, ["rev-parse", "HEAD"]),
			f.remote.shas[2],
			"HEAD was not moved",
		);
		assert.equal(
			readFileSync(join(f.sub, "README.md"), "utf8"),
			"local edit\n",
			"the edit survived",
		);
	});
});

describe("bootstrap-siblings --status", () => {
	it("prints the pin and ok for a submodule that matches its gitlink", () => {
		const f = fixture(1);
		ok(runBootstrap(f.work, ["--reference", f.reference]));
		const run = ok(runBootstrap(f.work, ["--status", "--offline"]));
		assert.ok(
			lines(run.stdout).includes(`lib  ${short(f.remote.shas[1])}  ok`),
			run.stdout,
		);
	});

	it("a submodule whose HEAD differs from its gitlink fails the status with the fix", () => {
		const f = fixture(1);
		ok(runBootstrap(f.work, ["--reference", f.reference]));
		git(f.sub, ["checkout", "-q", f.remote.shas[2] ?? ""]);
		const run = runBootstrap(f.work, ["--status", "--offline"]);
		assert.equal(run.status, 1);
		assert.match(
			run.stdout,
			new RegExp(`lib {2}${short(f.remote.shas[1])} {2}FAIL`),
		);
		assert.match(
			run.stdout,
			new RegExp(
				`is at ${short(f.remote.shas[2])}, the pin is ${short(f.remote.shas[1])}`,
			),
		);
		assert.match(run.stdout, /pnpm run pins:fetch lib/);
		assert.match(
			run.stdout,
			new RegExp(`pnpm run pins:bump lib ${short(f.remote.shas[2])}`),
		);
		assert.match(run.stderr, /1 pin\(s\) out of date/);
	});

	it("fails and names pins:fetch when the submodule was never fetched", () => {
		const f = fixture(1);
		const run = runBootstrap(f.work, ["--status", "--offline"]);
		assert.equal(run.status, 1);
		assert.match(run.stdout, /external\/lib is not fetched/);
		assert.match(run.stdout, /pnpm run pins:fetch lib/);
	});

	it("fails on uncommitted changes to tracked files", () => {
		const f = fixture(1);
		ok(runBootstrap(f.work, ["--reference", f.reference]));
		writeFileSync(join(f.sub, "README.md"), "local edit\n");
		const run = runBootstrap(f.work, ["--status", "--offline"]);
		assert.equal(run.status, 1);
		assert.match(run.stdout, /uncommitted changes to tracked files/);
	});

	it("fails when .gitmodules and siblings.json name different repositories", () => {
		const f = fixture(1, { repo: "https://github.com/example/other.git" });
		const run = runBootstrap(f.work, ["--status", "--offline"]);
		assert.equal(run.status, 1);
		assert.match(
			run.stdout,
			/\.gitmodules names .* for external\/lib; siblings\.json says https:\/\/github\.com\/example\/other\.git/,
		);
	});

	it("--online says where the branch is, and when the pin is its tip", () => {
		const behind = fixture(1);
		ok(runBootstrap(behind.work, ["--reference", behind.reference]));
		const run = ok(runBootstrap(behind.work, ["--status", "--online"]));
		assert.ok(
			lines(run.stdout).includes(
				`lib  ${short(behind.remote.shas[1])}  ok  (main is at ${short(behind.remote.shas[2])})`,
			),
			run.stdout,
		);
		const tip = fixture(2);
		ok(runBootstrap(tip.work, ["--reference", tip.reference]));
		assert.ok(
			lines(
				ok(runBootstrap(tip.work, ["--status", "--online"])).stdout,
			).includes(`lib  ${short(tip.remote.shas[2])}  ok  (the tip of main)`),
		);
	});
});

describe("bootstrap-siblings --bump", () => {
	it("bump moves only the gitlink", () => {
		const f = fixture(1);
		ok(runBootstrap(f.work, ["--reference", f.reference]));
		const run = ok(
			runBootstrap(f.work, [
				"--bump",
				"lib",
				short(f.remote.shas[2]),
				"--reference",
				f.reference,
			]),
		);
		assert.match(
			run.stdout,
			new RegExp(
				`lib {2}${short(f.remote.shas[1])} -> ${short(f.remote.shas[2])}`,
			),
		);
		assert.equal(
			git(f.work, ["diff", "--cached", "--name-only"]),
			"external/lib",
		);
		assert.equal(
			git(f.work, ["diff", "--name-only"]),
			"",
			"nothing else is modified",
		);
		assert.match(
			git(f.work, ["ls-files", "-s", "external/lib"]),
			new RegExp(`160000 ${f.remote.shas[2]}`),
		);
		assert.equal(git(f.sub, ["rev-parse", "HEAD"]), f.remote.shas[2]);
		const status = ok(runBootstrap(f.work, ["--status", "--offline"]));
		assert.ok(
			lines(status.stdout).includes(`lib  ${short(f.remote.shas[2])}  ok`),
			status.stdout,
		);
	});

	it("bump to a branch name fetches the tip of that branch", () => {
		const f = fixture(0);
		ok(runBootstrap(f.work, []));
		ok(runBootstrap(f.work, ["--bump", "lib", "main"]));
		assert.match(
			git(f.work, ["ls-files", "-s", "external/lib"]),
			new RegExp(`160000 ${f.remote.shas[2]}`),
		);
	});

	it("a short id the submodule cannot resolve fails and names --reference", () => {
		const f = fixture(1);
		ok(runBootstrap(f.work, []));
		const run = runBootstrap(f.work, [
			"--bump",
			"lib",
			short(f.remote.shas[0]),
		]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /cannot resolve .* --reference/);
		assert.equal(
			git(f.work, ["diff", "--cached", "--name-only"]),
			"",
			"nothing was staged",
		);
	});

	it("a short id the submodule lacks is resolved through --reference", () => {
		const f = fixture(1);
		ok(runBootstrap(f.work, []));
		// shas[0] is older than anything the shallow clone fetched.
		ok(
			runBootstrap(f.work, [
				"--bump",
				"lib",
				short(f.remote.shas[0]),
				"--reference",
				f.reference,
			]),
		);
		assert.equal(git(f.sub, ["rev-parse", "HEAD"]), f.remote.shas[0]);
		assert.match(
			git(f.work, ["ls-files", "-s", "external/lib"]),
			new RegExp(`160000 ${f.remote.shas[0]}`),
		);
	});

	it("bump refuses to start from a submodule that was never fetched", () => {
		const f = fixture(1);
		const run = runBootstrap(f.work, ["--bump", "lib", "main"]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /not fetched; run pnpm run pins:fetch lib first/);
	});
});

describe("bootstrap-siblings usage", () => {
	const f = fixture(1);
	const cases: readonly (readonly [string, readonly string[], RegExp])[] = [
		[
			"--bump with one argument",
			["--bump", "lib"],
			/--bump takes a pin name and a ref/,
		],
		["two verbs", ["--status", "--fetch"], /cannot be combined/],
		["--offline without --status", ["--offline"], /belong to --status/],
		[
			"--offline with --online",
			["--status", "--offline", "--online"],
			/cannot be combined/,
		],
		["an unknown pin", ["--fetch", "nosuch"], /no pin named nosuch; pins: lib/],
		[
			"a pin named like an Object property",
			["--fetch", "toString"],
			/no pin named toString/,
		],
		[
			"--bump of a name that is not a pin",
			["--bump", "__proto__", "main"],
			/no pin named __proto__/,
		],
		["an unknown flag", ["--frobnicate"], /frobnicate/],
		["a stray argument", ["extra"], /unexpected argument extra/],
		[
			"a reference that is not a repository",
			["--reference", "/nonexistent-dir"],
			/not a git repository/,
		],
		[
			"a ref that git would read as an option",
			["--bump", "lib", "a..b"],
			/not a commit, branch or tag name/,
		],
	];
	for (const [label, args, message] of cases) {
		it(`exits 2 for ${label}`, () => {
			const run = runBootstrap(f.work, args);
			assert.equal(run.status, 2, `${run.stdout}${run.stderr}`);
			assert.match(run.stderr, message);
			assert.match(run.stderr, /usage: bootstrap-siblings\.mts|ERR/);
		});
	}

	it("exits 1 when the manifest is malformed", () => {
		writeFileSync(
			join(f.work, "tools/pins/siblings.json"),
			'{"schemaVersion":1,"git":{"lib":{"path":"../x","repo":"https://github.com/e/l.git","branch":"main","sparse":null}},"assets":{},"vendor":{}}',
		);
		const run = runBootstrap(f.work, ["--status", "--offline"]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /PINS_MALFORMED.*git\.lib\.path/);
	});
});
