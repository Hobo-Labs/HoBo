import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	git,
	gitEnv,
	makeRemote,
	makeWork,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

function setUp(fetched = true) {
	const dir = scratch("gitmodules-once");
	const remote = makeRemote(dir);
	const work = makeWork(dir, remote, 1);
	if (fetched) assert.equal(runBootstrap(work, []).status, 0);
	return { work, url: remote.url };
}

function count(text: string, part: string): number {
	return text.split(part).length - 1;
}

function statusOf(work: string): string {
	const run = runBootstrap(work, ["--status", "--offline"]);
	return `exit ${run.status}\n${run.stdout}${run.stderr}`;
}

describe("status says a .gitmodules problem once, with a fix that works", () => {
	it("two sections for the path", () => {
		const { work, url } = setUp();
		appendFileSync(
			join(work, ".gitmodules"),
			`[submodule "dup"]\n\tpath = external/lib\n\turl = ${url}\n`,
		);
		const said = statusOf(work);
		assert.match(said, /^exit 1\n/u);
		assert.equal(count(said, "has 2 sections for external/lib"), 1, said);
		assert.equal(count(said, "keep one [submodule] section"), 1, said);
		assert.doesNotMatch(said, /rm -rf|nothing is run in it/u);
		git(work, [
			"config",
			"-f",
			".gitmodules",
			"--remove-section",
			"submodule.dup",
		]);
		assert.match(statusOf(work), /^exit 0\n/u, "the fix is enough");
	});

	it("no section for the path", () => {
		const { work } = setUp();
		writeFileSync(join(work, ".gitmodules"), "");
		const said = statusOf(work);
		assert.match(said, /^exit 1\n/u);
		assert.equal(
			count(said, "external/lib is not registered in .gitmodules"),
			1,
			said,
		);
		assert.doesNotMatch(said, /not this submodule's|rm -rf/u);
		const fix = /fix: (.+)/u.exec(said)?.[1] ?? "";
		assert.match(fix, /^git config -f \.gitmodules /u, said);
		execFileSync("sh", ["-c", fix], { cwd: work, env: gitEnv() });
		const after = statusOf(work);
		assert.match(after, /^exit 0\n/u, `the printed fix is enough: ${after}`);
	});

	const SPELLINGS: readonly [string, (url: string) => string][] = [
		[
			"section lib, path ./external/lib",
			(url) => `[submodule "lib"]\n\tpath = ./external/lib\n\turl = ${url}\n`,
		],
		[
			"section lib, path external/lib/",
			(url) => `[submodule "lib"]\n\tpath = external/lib/\n\turl = ${url}\n`,
		],
		[
			"section external/lib, path ./external/lib",
			(url) =>
				`[submodule "external/lib"]\n\tpath = ./external/lib\n\turl = ${url}\n`,
		],
		[
			"section lib, path exact, no url",
			() => `[submodule "lib"]\n\tpath = external/lib\n`,
		],
	];
	for (const [label, modules] of SPELLINGS) {
		it(`not registered (${label}): the printed fix is enough`, () => {
			const { work, url } = setUp(false);
			writeFileSync(join(work, ".gitmodules"), modules(url));
			const said = statusOf(work);
			assert.match(said, /external\/lib is not registered in \.gitmodules/u);
			const fix = /fix: (.+)/u.exec(said)?.[1] ?? "";
			execFileSync("sh", ["-c", fix], { cwd: work, env: gitEnv() });
			const setup = runBootstrap(work, []);
			assert.equal(setup.status, 0, `after "${fix}": ${setup.stderr}`);
			const after = statusOf(work);
			assert.match(after, /^exit 0\n/u, `after "${fix}": ${after}`);
		});
	}
});
