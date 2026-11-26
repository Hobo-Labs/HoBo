/**
 * `.gitmodules` is read the way git reads it, and anything git could read
 * differently from the script is refused before any network call: two
 * sections that name the same path (git would use one of them, not
 * necessarily the one the script compared), and a value carrying a line break
 * or another control character (escapes such as `\n` are valid there, and
 * could make a line-based reader see a section that does not exist).
 *
 * The URLs are https on hosts that do not resolve, and HOBO_PINS_ALLOW_LOCAL
 * is off, so the real allow-list applies and any contact would show up as an
 * attempt to reach `evil.invalid`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	gitEnv,
	makeRemote,
	makeWork,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

const GOOD = "https://good.invalid/o/r.git";
const EVIL = "https://evil.invalid/x/y.git";

function section(name: string, url: string): string {
	return `[submodule "${name}"]\n\tpath = external/lib\n\turl = ${url}\n`;
}

/** A work tree whose manifest names GOOD and whose .gitmodules is `modules`. */
function withModules(modules: string): string {
	const dir = scratch("gitmodules");
	const remote = makeRemote(dir);
	const work = makeWork(dir, remote, 1);
	writeFileSync(join(work, ".gitmodules"), modules);
	const file = join(work, "tools/pins/siblings.json");
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	manifest.git.lib.repo = GOOD;
	writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
	return work;
}

const NOT_LOCAL = { HOBO_PINS_ALLOW_LOCAL: "" };

function assertNothingContacted(work: string, output: string): void {
	assert.doesNotMatch(
		output,
		/Cloning into|Could not resolve host|unable to access/u,
		"git was never asked to contact a host",
	);
	assert.equal(
		existsSync(join(work, "external/lib/.git")),
		false,
		"nothing was cloned",
	);
	assert.doesNotMatch(
		readFileSync(join(work, ".git/config"), "utf8"),
		/\[submodule /u,
		"git submodule init did not run",
	);
}

describe(".gitmodules that git could read another way is refused", () => {
	for (const order of ["the manifest's first", "the other first"]) {
		it(`two sections for one path (${order}) are refused by init, fetch and status`, () => {
			const work = withModules(
				order === "the manifest's first"
					? section("lib", GOOD) + section("evil", EVIL)
					: section("evil", EVIL) + section("lib", GOOD),
			);
			for (const args of [[], ["--fetch", "lib"]]) {
				const run = runBootstrap(work, args, NOT_LOCAL);
				assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
				assert.match(
					run.stderr,
					/GITMODULES_AMBIGUOUS: \.gitmodules has 2 sections for external\/lib \("(lib|evil)", "(lib|evil)"\)/u,
				);
				assert.match(run.stderr, /fix: keep one \[submodule\] section/u);
				assertNothingContacted(work, `${run.stdout}${run.stderr}`);
			}
			const status = runBootstrap(work, ["--status"], NOT_LOCAL);
			assert.equal(status.status, 1, status.stdout);
			assert.match(status.stdout, /lib {2}[0-9a-f]{7} {2}FAIL/u);
			assert.match(status.stdout, /2 sections for external\/lib/u);
		});
	}

	it("a value with an escaped line break is refused, so it cannot forge a section", () => {
		const work = withModules(
			`[submodule "carrier"]\n\tbranch = "main\\nsubmodule.fake.path external/lib\\nsubmodule.fake.url ${GOOD}"\n${section("real", EVIL)}`,
		);
		const run = runBootstrap(work, [], NOT_LOCAL);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stderr,
			/GITMODULES_AMBIGUOUS: \.gitmodules: submodule\.carrier\.branch holds a line break or another control character/u,
		);
		assertNothingContacted(work, `${run.stdout}${run.stderr}`);
	});

	it("one section, read with git config -z, still compares as before", () => {
		const work = withModules(section("lib", EVIL));
		const run = runBootstrap(work, [], NOT_LOCAL);
		assert.equal(run.status, 1);
		assert.match(
			run.stderr,
			/SUBMODULE_STATE: \.gitmodules names https:\/\/evil\.invalid\/x\/y\.git for external\/lib; siblings\.json says https:\/\/good\.invalid\/o\/r\.git/u,
		);
		assertNothingContacted(work, `${run.stdout}${run.stderr}`);
	});

	it("a .gitmodules git cannot parse is refused as such, naming where git stopped", () => {
		const work = withModules(
			`${section("lib", GOOD)}[submodule "x"\n\tpath = y\n`,
		);
		const status = runBootstrap(work, ["--status"], NOT_LOCAL);
		assert.equal(status.status, 1, status.stdout);
		assert.match(
			status.stdout,
			/git cannot read \.gitmodules: .*bad config line \d+ in file \.gitmodules/u,
		);
		assert.doesNotMatch(status.stdout, /not registered/u);
		const run = runBootstrap(work, ["--fetch", "lib"], NOT_LOCAL);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stderr,
			/GITMODULES_AMBIGUOUS: git cannot read \.gitmodules/u,
		);
		assertNothingContacted(work, `${run.stdout}${run.stderr}`);
	});

	it("a section name in a printed fix is quoted for the shell", () => {
		const work = withModules(section("lib$(touch PWNED)", EVIL));
		const status = runBootstrap(work, ["--status"], NOT_LOCAL);
		const fix = /fix: (.+?)(?: {3}\(|$)/mu.exec(status.stdout)?.[1] ?? "";
		assert.match(fix, /'submodule\.lib\$\(touch PWNED\)\.url'/u, status.stdout);
		execFileSync("sh", ["-c", fix], { cwd: work, env: gitEnv() });
		assert.equal(existsSync(join(work, "PWNED")), false, "nothing ran");
		const after = runBootstrap(work, ["--status"], NOT_LOCAL);
		assert.doesNotMatch(after.stdout, /\.gitmodules names/u, after.stdout);
	});
});
