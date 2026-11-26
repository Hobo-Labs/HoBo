/**
 * What the git side of the bootstrap script trusts, and what it refuses to
 * do on trust: the repository named by the manifest, by `.gitmodules` and by
 * this clone's own configuration must be the same one before any network call,
 * a transport git would run code for is never used, a commit only a local
 * clone has is never pinned, and local work is not abandoned by a `setup`.
 *
 * Real repositories on disk, the real script, git configuration isolated.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	allowedProtocols,
	isAllowedTransport,
	netArgs,
	remoteTip,
} from "../lib/pins-git-net.ts";
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
	const dir = scratch("safety");
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

const OTHER = "https://github.com/example/other.git";

/**
 * An `ext::` URL whose command leaves a marker if git ever runs it. (The ext
 * helper splits on spaces and does not interpret quotes, so the command is a
 * script file, not `sh -c '...'`.)
 */
interface ExtCommand {
	readonly url: string;
	readonly marker: string;
}

function extUrl(dir: string): ExtCommand {
	const marker = join(dir, "ext-ran");
	const script = join(dir, "ext-command.sh");
	writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
	return { url: `ext::${script}`, marker };
}

describe("the repository must be the same everywhere before anything is fetched", () => {
	it("init refuses when .gitmodules names another repository, and fetches nothing", () => {
		const f = fixture(1, { repo: OTHER });
		const run = runBootstrap(f.work, ["--reference", f.reference]);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stderr,
			/SUBMODULE_STATE: \.gitmodules names .* for external\/lib; siblings\.json says https:\/\/github\.com\/example\/other\.git/,
		);
		assert.match(
			run.stderr,
			/fix: git config -f \.gitmodules submodule\.external\/lib\.url https:\/\/github\.com\/example\/other\.git/,
		);
		assert.equal(existsSync(join(f.sub, ".git")), false, "nothing was cloned");
		assert.doesNotMatch(
			readFileSync(join(f.work, ".git/config"), "utf8"),
			/\[submodule "external\/lib"\]/u,
			"git submodule init did not run",
		);
	});

	it("naming the pin does not get around it, and neither does bump", () => {
		const f = fixture(1, { repo: OTHER });
		const named = runBootstrap(f.work, ["--fetch", "lib"]);
		assert.equal(named.status, 1);
		assert.match(named.stderr, /siblings\.json says/);
		const good = fixture(1);
		const first = runBootstrap(good.work, []);
		assert.equal(first.status, 0, first.stderr);
		git(good.work, [
			"config",
			"-f",
			".gitmodules",
			"submodule.external/lib.url",
			OTHER,
		]);
		const bump = runBootstrap(good.work, ["--bump", "lib", "main"]);
		assert.equal(bump.status, 1);
		assert.match(bump.stderr, /\.gitmodules names/);
		assert.equal(
			git(good.work, ["diff", "--cached", "--name-only"]),
			"",
			"nothing was staged",
		);
	});

	it("a stale configured URL is refused with the command that syncs it", () => {
		const f = fixture(1);
		assert.equal(runBootstrap(f.work, []).status, 0);
		git(f.work, [
			"config",
			"submodule.external/lib.url",
			"file:///somewhere/else",
		]);
		const run = runBootstrap(f.work, ["--fetch", "lib"]);
		assert.equal(run.status, 1);
		assert.match(
			run.stderr,
			/configured URL for external\/lib is file:\/\/\/somewhere\/else/,
		);
		assert.match(run.stderr, /fix: git submodule sync -- external\/lib/);
		const status = runBootstrap(f.work, ["--status", "--offline"]);
		assert.equal(status.status, 1);
		assert.match(status.stdout, /fix: git submodule sync -- external\/lib/);
	});

	it("a path missing from .gitmodules is refused, and the fix says how to register it", () => {
		const f = fixture(1);
		git(f.work, [
			"config",
			"-f",
			".gitmodules",
			"--remove-section",
			"submodule.external/lib",
		]);
		const init = runBootstrap(f.work, []);
		assert.equal(init.status, 1);
		assert.match(
			init.stderr,
			/external\/lib is not registered in \.gitmodules/,
		);
		const status = runBootstrap(f.work, ["--status", "--offline"]);
		assert.equal(status.status, 1);
		const url = f.remote.url.replace(/[/.]/gu, "\\$&");
		assert.match(
			status.stdout,
			new RegExp(
				`fix: git config -f \\.gitmodules submodule\\.external/lib\\.path external/lib && git config -f \\.gitmodules submodule\\.external/lib\\.url ${url}`,
			),
		);
	});

	it("a transport that runs code is never handed to git, even if git would allow it", () => {
		const f = fixture(1, { repo: "https://example.com/o/r.git" });
		const { url, marker } = extUrl(f.dir);
		git(f.work, [
			"config",
			"-f",
			".gitmodules",
			"submodule.external/lib.url",
			url,
		]);
		// The user's configuration enables ext; the script must not care.
		const run = runBootstrap(f.work, [], { HOBO_PINS_ALLOW_LOCAL: "" }, [
			["protocol.ext.allow", "always"],
		]);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(run.stderr, /which is not an https URL/);
		assert.equal(existsSync(marker), false, "the ext transport did not run");
	});
});

describe("network git pins the transports", () => {
	it("allows https and ssh, and file or http only where the tests or a --reference clone need them", () => {
		assert.equal(allowedProtocols(false, false), "https:ssh");
		assert.equal(allowedProtocols(false, true), "https:ssh:file");
		assert.equal(allowedProtocols(true, false), "https:ssh:http:file");
	});

	it("every network call starts with protocol.allow=never", () => {
		const args = netArgs(["fetch", "x"]);
		assert.deepEqual(args.slice(0, 2), ["-c", "protocol.allow=never"]);
		assert.deepEqual(args.slice(-2), ["fetch", "x"], "settings, then the call");
	});

	it("isAllowedTransport accepts https and refuses what runs code or sends in the clear", () => {
		for (const ok of ["https://github.com/o/r.git", "HTTPS://github.com/o/r"]) {
			assert.equal(isAllowedTransport(ok, false), true, ok);
		}
		for (const bad of [
			"ext::sh -c 'id'",
			"fd::3",
			"file:///tmp/repo",
			"/tmp/repo",
			"git://github.com/o/r.git",
			"http://github.com/o/r.git",
			"ssh://git@github.com/o/r.git",
		]) {
			assert.equal(isAllowedTransport(bad, false), false, bad);
		}
		assert.equal(isAllowedTransport("file:///tmp/repo", true), true);
		assert.equal(isAllowedTransport("/tmp/repo", true), true);
		assert.equal(isAllowedTransport("http://127.0.0.1:8080/r", true), true);
		assert.equal(isAllowedTransport("http://example.com/r", true), false);
	});

	it("ls-remote of an ext:: URL fails and runs nothing even when the configuration enables ext", () => {
		const dir = scratch("net");
		const { url, marker } = extUrl(dir);
		const saved = { ...process.env };
		Object.assign(process.env, {
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "protocol.ext.allow",
			GIT_CONFIG_VALUE_0: "always",
		});
		try {
			assert.throws(
				() =>
					remoteTip(dir, url, "main", {
						allowLocal: false,
					}),
				/GIT_FAILED/,
			);
			assert.equal(existsSync(marker), false);
		} finally {
			for (const key of Object.keys(process.env)) {
				if (!(key in saved)) delete process.env[key];
			}
			Object.assign(process.env, saved);
		}
	});
});

/** A commit that exists in the reference clone and nowhere the remote can see. */
function localOnlyCommit(f: Fixture): string {
	writeFileSync(join(f.reference, "f.txt"), "never pushed\n");
	git(f.reference, ["add", "f.txt"]);
	git(f.reference, ["commit", "-q", "-m", "local only"]);
	return git(f.reference, ["rev-parse", "HEAD"]);
}

describe("a commit the remote does not serve is never pinned", () => {
	it("bump refuses a commit only the --reference clone has, and changes nothing", () => {
		const f = fixture(1);
		assert.equal(runBootstrap(f.work, ["--reference", f.reference]).status, 0);
		const local = localOnlyCommit(f);
		const before = git(f.sub, ["rev-parse", "HEAD"]);
		const run = runBootstrap(f.work, [
			"--bump",
			"lib",
			local.slice(0, 7),
			"--reference",
			f.reference,
		]);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stderr,
			new RegExp(`NOT_PUSHED: ${local.slice(0, 7)} exists here`),
		);
		assert.match(run.stderr, /does not serve it/);
		assert.match(run.stderr, /Push it first/);
		assert.equal(
			git(f.sub, ["rev-parse", "HEAD"]),
			before,
			"the submodule did not move",
		);
		assert.equal(
			git(f.work, ["diff", "--cached", "--name-only"]),
			"",
			"nothing was staged",
		);
	});

	it("a failure to ask is an error, not a no", () => {
		const f = fixture(1);
		assert.equal(runBootstrap(f.work, ["--reference", f.reference]).status, 0);
		const local = localOnlyCommit(f);
		rmSync(f.remote.dir, { recursive: true, force: true });
		const run = runBootstrap(f.work, [
			"--bump",
			"lib",
			local,
			"--reference",
			f.reference,
		]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /GIT_FAILED: could not ask /);
		assert.doesNotMatch(run.stderr, /Push it first/);
	});

	it("--status --online fails when the pinned commit is not on the remote", () => {
		const f = fixture(1);
		const local = localOnlyCommit(f);
		const work = makeWork(scratch("unpushed"), f.remote, 1, { gitlink: local });
		const run = runBootstrap(work, ["--status", "--online"]);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stdout,
			new RegExp(
				`the pinned commit ${local.slice(0, 7)} is not available from`,
			),
		);
		assert.match(
			run.stdout,
			/push it, or move the pin to a pushed commit: pnpm run pins:bump lib <a pushed ref>/,
		);
	});

	it("--status --online is quiet about a pin the remote serves", () => {
		const f = fixture(1);
		assert.equal(runBootstrap(f.work, ["--reference", f.reference]).status, 0);
		const run = runBootstrap(f.work, ["--status", "--online"]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.doesNotMatch(run.stdout, /not available from/);
	});
});

describe("the script does not move a submodule it cannot account for", () => {
	it("bump refuses a submodule with uncommitted changes and keeps them", () => {
		const f = fixture(1);
		assert.equal(runBootstrap(f.work, ["--reference", f.reference]).status, 0);
		writeFileSync(join(f.sub, "README.md"), "local edit\n");
		const before = git(f.sub, ["rev-parse", "HEAD"]);
		const run = runBootstrap(f.work, ["--bump", "lib", "main"]);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(run.stderr, /external\/lib has uncommitted changes/);
		assert.equal(
			git(f.sub, ["rev-parse", "HEAD"]),
			before,
			"HEAD did not move",
		);
		assert.equal(
			readFileSync(join(f.sub, "README.md"), "utf8"),
			"local edit\n",
		);
		assert.equal(
			git(f.work, ["diff", "--cached", "--name-only"]),
			"",
			"nothing was staged",
		);
	});

	it("init reports a submodule that git declined to update, instead of calling it pinned", () => {
		const f = fixture(1);
		// `update = none` makes `git submodule update` skip the path and succeed.
		git(f.work, ["config", "submodule.external/lib.update", "none"]);
		const run = runBootstrap(f.work, []);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stderr,
			/external\/lib is at nothing after update; the pin is /,
		);
	});
});
