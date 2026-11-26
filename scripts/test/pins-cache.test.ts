/**
 * The cache holds executables that a later command runs, so it is private
 * (0700, owned by the user, never writable by anyone else), and a download that
 * is interrupted or killed leaves nothing in it: not for this run, and not for
 * the next one, which sweeps what a dead process left.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { PinsError } from "../lib/pins.ts";
import { cacheProblem, dirProblem, sweepPartials } from "../lib/pins-cache.ts";
import { ensureCached } from "../lib/pins-fetch.ts";
import {
	type FileServer,
	runBootstrapAsync,
	scratch,
	sha256Hex,
	spawnBootstrap,
	startServer,
	waitUntil,
	writeManifest,
} from "./support/pins-support.ts";

let server: FileServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

const BYTES = Buffer.from("#!/bin/sh\necho cache\n");
const DIGEST = sha256Hex(BYTES);

function pinnedFile(origin: string) {
	return {
		url: `${origin}/bin`,
		sha256: DIGEST,
		size: BYTES.byteLength,
		entry: "tool",
	};
}

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("the cache directories are private", () => {
	for (const umask of [0o002, 0o000]) {
		it(`are created 0700 under umask ${umask.toString(8).padStart(3, "0")}`, async () => {
			server = await startServer();
			server.setFile("/bin", BYTES);
			const cache = join(scratch("cache-mode"), "cache", "siblings");
			const before = process.umask(umask);
			try {
				await ensureCached(cache, pinnedFile(server.origin), {
					allowLocal: true,
				});
			} finally {
				process.umask(before);
			}
			assert.equal(mode(cache), 0o700, "the cache root");
			assert.equal(mode(join(cache, DIGEST)), 0o700, "the digest directory");
		});
	}

	it("a cache directory that group or others can write is refused, with the chmod that fixes it", async () => {
		server = await startServer();
		server.setFile("/bin", BYTES);
		const root = scratch("cache-open");
		const cache = join(root, "siblings");
		mkdirSync(cache);
		chmodSync(cache, 0o775); // mkdir applies the umask; chmod does not
		await assert.rejects(
			ensureCached(cache, pinnedFile(server.origin), { allowLocal: true }),
			(error: Error) =>
				error instanceof PinsError &&
				error.code === "CACHE_UNSAFE" &&
				error.message.includes(cache) &&
				/chmod go-w /u.test(error.message),
		);
		assert.deepEqual(readdirSync(cache), [], "nothing was downloaded into it");
		mkdirSync(cache, { recursive: true, mode: 0o700 });
		const digestDir = join(cache, DIGEST);
		mkdirSync(digestDir);
		chmodSync(digestDir, 0o777);
		await assert.rejects(
			ensureCached(cache, pinnedFile(server.origin), { allowLocal: true }),
			(error: Error) =>
				error instanceof PinsError && error.code === "CACHE_UNSAFE",
		);
	});

	it("dirProblem names an owner that is not the user, a link, and a writable mode", () => {
		const ok = { uid: 1000, mode: 0o40700, directory: true };
		assert.equal(dirProblem(ok, 1000, "/c"), null);
		assert.equal(
			dirProblem({ ...ok, mode: 0o40755 }, 1000, "/c"),
			null,
			"readable by others is fine",
		);
		assert.match(
			dirProblem({ ...ok, uid: 0 }, 1000, "/c")?.problem ?? "",
			/owned by uid 0, not by you \(uid 1000\)/,
		);
		assert.match(
			dirProblem({ ...ok, mode: 0o40770 }, 1000, "/c")?.problem ?? "",
			/writable by group or others/,
		);
		assert.match(
			dirProblem({ ...ok, mode: 0o40707 }, 1000, "/c")?.problem ?? "",
			/writable by group or others/,
		);
		assert.match(
			dirProblem({ ...ok, directory: false }, 1000, "/c")?.problem ?? "",
			/not a directory/,
		);
	});

	it("cacheProblem is null for a cache that does not exist yet and for a private one", async () => {
		const root = scratch("cache-none");
		assert.equal(await cacheProblem(join(root, "absent")), null);
		const cache = join(root, "siblings");
		mkdirSync(cache, { mode: 0o700 });
		assert.equal(await cacheProblem(cache), null);
	});

	it("status reports a cache that others can write as a problem with the fix", async () => {
		server = await startServer();
		server.setFile("/bin", BYTES);
		const root = scratch("cache-status");
		const { origin } = server;
		writeManifest(
			root,
			`{"mirror":{"repo":"${origin}/example/mirror","tag":"v1.0.0","files":{"linux-x64":${JSON.stringify(pinnedFile(origin))},"linux-arm64":${JSON.stringify(pinnedFile(origin))}}}}`,
		);
		const first = await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(first.status, 0, first.stderr);
		const cache = join(root, ".cache/siblings");
		assert.equal(mode(cache), 0o700);
		const run = await runBootstrapAsync(root, ["--status", "--offline"]);
		assert.equal(run.status, 0, run.stdout);
		chmodSync(cache, 0o777);
		const open = await runBootstrapAsync(root, ["--status", "--offline"]);
		assert.equal(open.status, 1, open.stdout);
		assert.match(open.stdout, /writable by group or others/);
		assert.match(
			open.stdout,
			new RegExp(`fix: chmod go-w ${cache.replace(/[/.]/gu, "\\$&")}`),
		);
	});
});

/** A pid that existed a moment ago and does not now. */
function deadPid(): number {
	const result = spawnSync(process.execPath, ["-e", ""]);
	assert.ok(result.pid > 0);
	return result.pid;
}

function partial(
	dir: string,
	name: string,
	pid: number,
	ageMs: number,
	suffix = "",
): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${name}.${pid}${suffix}.partial`);
	writeFileSync(path, "half a download", { mode: 0o600 });
	const then = new Date(Date.now() - ageMs);
	utimesSync(path, then, then);
	return path;
}

describe("a download that was interrupted leaves nothing in the cache", () => {
	it("sweepPartials removes old partial files of dead processes and keeps the rest", async () => {
		const cache = join(scratch("cache-sweep"), "siblings");
		const dir = join(cache, "a".repeat(64));
		const dead = partial(dir, "tool", deadPid(), 5 * 60_000);
		const live = partial(dir, "live", process.ppid, 5 * 60_000);
		const young = partial(dir, "young", deadPid(), 5_000);
		const whole = join(dir, "tool");
		writeFileSync(whole, "a verified file");
		const removed = await sweepPartials(cache);
		assert.deepEqual(removed, [dead]);
		assert.equal(
			existsSync(dead),
			false,
			"a dead process's old partial file is gone",
		);
		assert.equal(
			existsSync(live),
			true,
			"another live process's is not touched within the hour",
		);
		assert.equal(
			existsSync(young),
			true,
			"a young one may be a download starting now",
		);
		assert.equal(existsSync(whole), true, "only partial files are swept");
	});

	it("a fetch sweeps what a dead download left before it starts", async () => {
		server = await startServer();
		server.setFile("/bin", BYTES);
		const root = scratch("cache-sweep-cli");
		const { origin } = server;
		writeManifest(
			root,
			`{"mirror":{"repo":"${origin}/example/mirror","tag":"v1.0.0","files":{"linux-x64":${JSON.stringify(pinnedFile(origin))},"linux-arm64":${JSON.stringify(pinnedFile(origin))}}}}`,
		);
		const leftover = partial(
			join(root, ".cache/siblings", DIGEST),
			"tool",
			deadPid(),
			5 * 60_000,
		);
		const run = await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(run.status, 0, run.stderr);
		assert.equal(existsSync(leftover), false);
	});
});

describe("a leftover partial file never blocks a later run", () => {
	const RANDOM = ".0123456789ab";

	it("one named after this process's own pid (a container's pid 1) is swept and does not collide", async () => {
		server = await startServer();
		server.setFile("/bin", BYTES);
		const cache = join(scratch("cache-own-pid"), "siblings");
		const dir = join(cache, DIGEST);
		const legacy = partial(dir, "tool", process.pid, 5 * 60_000);
		const current = partial(dir, "tool", process.pid, 5 * 60_000, RANDOM);
		const { path } = await ensureCached(cache, pinnedFile(server.origin), {
			allowLocal: true,
		});
		assert.deepEqual(readdirSync(dir), ["tool"], "only the verified file");
		assert.equal(path, join(dir, "tool"));
		assert.equal(existsSync(legacy) || existsSync(current), false);
	});

	it("an old one is swept whatever its pid says, a young one and a live process's are kept", async () => {
		const cache = join(scratch("cache-age"), "siblings");
		const dir = join(cache, "b".repeat(64));
		const stale = partial(dir, "a", 4242, 2 * 3_600_000, RANDOM);
		const live = partial(dir, "b", 4243, 5 * 60_000, RANDOM);
		const dead = partial(dir, "c", 4244, 5 * 60_000, RANDOM);
		const young = partial(dir, "d", 4245, 5_000, RANDOM);
		const removed = await sweepPartials(
			cache,
			Date.now(),
			(pid) => pid !== 4244,
		);
		assert.deepEqual(removed.sort(), [stale, dead].sort());
		assert.equal(existsSync(live), true, "its process is alive");
		assert.equal(existsSync(young), true, "it may be a download starting now");
	});

	it("a run killed with SIGKILL leaves one the next run neither trips on nor keeps", async () => {
		server = await startServer();
		server.setStall("/stall", Buffer.alloc(10, 1), BYTES.byteLength);
		server.setFile("/bin", BYTES);
		const root = scratch("cache-sigkill");
		const stalled = {
			...pinnedFile(server.origin),
			url: `${server.origin}/stall`,
		};
		writeManifest(
			root,
			`{"mirror":{"repo":"${server.origin}/example/mirror","tag":"v1.0.0","files":{"linux-x64":${JSON.stringify(stalled)},"linux-arm64":${JSON.stringify(stalled)}}}}`,
		);
		const dir = join(root, ".cache/siblings", DIGEST);
		const running = spawnBootstrap(root, ["--fetch", "mirror"]);
		const left = await waitUntil("a partial file with bytes in it", () =>
			existsSync(dir)
				? readdirSync(dir).find((name) => name.endsWith(".partial"))
				: undefined,
		);
		running.child.kill("SIGKILL");
		await running.done;
		assert.match(
			left,
			new RegExp(`^tool\\.${running.child.pid}\\.[0-9a-f]{12}\\.partial$`, "u"),
			"named after its process, with a random part",
		);
		writeManifest(
			root,
			`{"mirror":{"repo":"${server.origin}/example/mirror","tag":"v1.0.0","files":{"linux-x64":${JSON.stringify(pinnedFile(server.origin))},"linux-arm64":${JSON.stringify(pinnedFile(server.origin))}}}}`,
		);
		const old = new Date(Date.now() - 5 * 60_000);
		utimesSync(join(dir, left), old, old);
		const next = await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(next.status, 0, next.stderr);
		assert.deepEqual(readdirSync(dir), ["tool"], "the leftover was swept");
	});
});
