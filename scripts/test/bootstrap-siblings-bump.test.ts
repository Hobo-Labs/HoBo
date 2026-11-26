/**
 * `pins:bump` for an asset pin, and what it must not do quietly: drop a build
 * the new release does not list, rename the file a binary runs under, move a
 * pin to another repository, or let an unchecked tag steer a request.
 *
 * The release is a real loopback http server and the script is the real
 * script (HOBO_PINS_ALLOW_LOCAL lets the manifest name that server).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	type FileServer,
	runBootstrapAsync,
	scratch,
	sha256Hex,
	startServer,
	writeManifest,
} from "./support/pins-support.ts";

const OLD_X64 = Buffer.from("old x64 build\n");
const OLD_ARM = Buffer.from("old arm64 build\n");
const NEW_X64 = Buffer.from("new x64 build, a little longer\n");
const NEW_ARM = Buffer.from("new arm64 build, longer still\n");

let server: FileServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

interface Setup {
	readonly root: string;
	readonly srv: FileServer;
	readonly repo: string;
	readonly manifest: string;
}

function pinFile(origin: string, target: string, bytes: Buffer, entry: string) {
	return `"${target}":{"url":"${origin}/old/${target}","sha256":"${sha256Hex(bytes)}","size":${bytes.byteLength},"entry":"${entry}"}`;
}

/** A two-target pin at v1.0.0 whose files run under `entry`. */
async function setup(entry = "mirror.real-name"): Promise<Setup> {
	const srv = await startServer();
	server = srv;
	const root = scratch("bump");
	const repo = `${srv.origin}/example/mirror`;
	writeManifest(
		root,
		`{"mirror":{"repo":"${repo}","tag":"v1.0.0","files":{${pinFile(srv.origin, "linux-x64", OLD_X64, entry)},${pinFile(srv.origin, "linux-arm64", OLD_ARM, entry)}}}}`,
	);
	return {
		root,
		srv,
		repo,
		manifest: join(root, "tools/pins/siblings.json"),
	};
}

/** Publish v2.0.0 with these builds (and only these) in its SHA256SUMS. */
function release(
	srv: FileServer,
	builds: Readonly<Record<string, Buffer>>,
	tag = "v2.0.0",
): void {
	const base = `/example/mirror/releases/download/${tag}`;
	const lines: string[] = [];
	for (const [target, bytes] of Object.entries(builds)) {
		srv.setFile(`${base}/mirror-${target}`, bytes);
		lines.push(`${sha256Hex(bytes)}  mirror-${target}`);
	}
	srv.setFile(`${base}/SHA256SUMS`, `${lines.join("\n")}\n`);
}

function cacheEntries(root: string): string[] {
	const cache = join(root, ".cache/siblings");
	return existsSync(cache)
		? readdirSync(cache, { recursive: true }).map(String)
		: [];
}

describe("bump never drops a build quietly", () => {
	it("refuses when the release lacks a target the pin has, and downloads nothing", async () => {
		const { root, srv, manifest } = await setup();
		release(srv, { "linux-x64": NEW_X64 });
		const before = readFileSync(manifest, "utf8");
		srv.hits.length = 0;
		const run = await runBootstrapAsync(root, ["--bump", "mirror", "v2.0.0"]);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(run.stderr, /TARGET_DROPPED/);
		assert.match(run.stderr, /linux-arm64/);
		assert.match(run.stderr, /--drop linux-arm64/);
		assert.equal(
			readFileSync(manifest, "utf8"),
			before,
			"the manifest is untouched",
		);
		assert.deepEqual(
			srv.hits,
			["GET /example/mirror/releases/download/v2.0.0/SHA256SUMS"],
			"only the sums were read",
		);
		assert.deepEqual(cacheEntries(root), [], "nothing was cached");
	});

	it("--drop records the drop and says what is kept and what is dropped", async () => {
		const { root, srv, manifest } = await setup();
		release(srv, { "linux-x64": NEW_X64 });
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--drop",
			"linux-arm64",
		]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.match(run.stdout, /kept: linux-x64 {2}dropped: linux-arm64/);
		const after = JSON.parse(readFileSync(manifest, "utf8")).assets.mirror;
		assert.deepEqual(Object.keys(after.files), ["linux-x64"]);
		assert.equal(after.tag, "v2.0.0");
	});

	it("keeps every target and says so when the release lists them all", async () => {
		const { root, srv, manifest } = await setup();
		release(srv, { "linux-x64": NEW_X64, "linux-arm64": NEW_ARM });
		const run = await runBootstrapAsync(root, ["--bump", "mirror", "v2.0.0"]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.match(run.stdout, /kept: linux-x64, linux-arm64 {2}dropped: none/);
		assert.deepEqual(
			Object.keys(
				JSON.parse(readFileSync(manifest, "utf8")).assets.mirror.files,
			),
			["linux-x64", "linux-arm64"],
		);
	});

	it("--drop is a usage error for a target the pin never had or the release does list", async () => {
		const { root, srv } = await setup();
		release(srv, { "linux-x64": NEW_X64, "linux-arm64": NEW_ARM });
		const never = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--drop",
			"darwin-arm64",
		]);
		assert.equal(never.status, 2);
		assert.match(
			never.stderr,
			/--drop darwin-arm64: the pin has no such target/,
		);
		const listed = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--drop",
			"linux-x64",
		]);
		assert.equal(listed.status, 2);
		assert.match(listed.stderr, /--drop linux-x64: the release publishes it/);
	});

	it("a first bump may publish fewer targets than the defaults, and says which are missing", async () => {
		const srv = await startServer();
		server = srv;
		const root = scratch("bump-first");
		writeManifest(root, '{"mirror":null}');
		release(srv, { "linux-x64": NEW_X64 });
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--repo",
			`${srv.origin}/example/mirror`,
		]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.match(run.stdout, /kept: linux-x64 {2}not published: linux-arm64/);
	});
});

describe("bump keeps the name a binary runs under", () => {
	it("carries a non-default entry over and caches the file under it", async () => {
		const { root, srv, manifest } = await setup("mirror.real-name");
		release(srv, { "linux-x64": NEW_X64, "linux-arm64": NEW_ARM });
		const run = await runBootstrapAsync(root, ["--bump", "mirror", "v2.0.0"]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		const files = JSON.parse(readFileSync(manifest, "utf8")).assets.mirror
			.files;
		assert.equal(files["linux-x64"].entry, "mirror.real-name");
		assert.equal(files["linux-arm64"].entry, "mirror.real-name");
		assert.ok(
			existsSync(
				join(root, ".cache/siblings", sha256Hex(NEW_X64), "mirror.real-name"),
			),
		);
	});

	it("--entry renames it on purpose and says so; a bad name is a usage error", async () => {
		const { root, srv, manifest } = await setup("mirror.real-name");
		release(srv, { "linux-x64": NEW_X64, "linux-arm64": NEW_ARM });
		const bad = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--entry",
			"bin/mirror",
		]);
		assert.equal(bad.status, 2);
		assert.match(bad.stderr, /--entry bin\/mirror is not a plain file name/);
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--entry",
			"mirror",
		]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.match(run.stdout, /entry: mirror\.real-name -> mirror/);
		assert.equal(
			JSON.parse(readFileSync(manifest, "utf8")).assets.mirror.files[
				"linux-x64"
			].entry,
			"mirror",
		);
	});

	it("a first bump names the file after the pin", async () => {
		const srv = await startServer();
		server = srv;
		const root = scratch("bump-entry");
		writeManifest(root, '{"mirror":null}');
		release(srv, { "linux-x64": NEW_X64, "linux-arm64": NEW_ARM });
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--repo",
			`${srv.origin}/example/mirror`,
		]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		const manifest = join(root, "tools/pins/siblings.json");
		assert.equal(
			JSON.parse(readFileSync(manifest, "utf8")).assets.mirror.files[
				"linux-x64"
			].entry,
			"mirror",
		);
	});
});

describe("bump checks what it was given before it asks anyone", () => {
	it("a tag that is not a release tag is refused before any request or cache write", async () => {
		const { root, srv, manifest } = await setup();
		const before = readFileSync(manifest, "utf8");
		srv.hits.length = 0;
		for (const tag of ["../../../../other/place", "v1/../x", "a b", "v1;rm"]) {
			const run = await runBootstrapAsync(root, ["--bump", "mirror", tag]);
			assert.equal(run.status, 2, `${tag}\n${run.stdout}${run.stderr}`);
			assert.match(run.stderr, /is not a release tag/);
		}
		assert.deepEqual(srv.hits, [], "no request left this machine");
		assert.deepEqual(cacheEntries(root), []);
		assert.equal(readFileSync(manifest, "utf8"), before);
	});

	it("--repo that is not an allowed URL is refused before any request", async () => {
		const { root, srv } = await setup();
		srv.hits.length = 0;
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--repo",
			"ftp://example.com/x",
		]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /PINS_MALFORMED/);
		assert.deepEqual(srv.hits, []);
	});

	it("moving the pin to another repository is announced as repo: old -> new", async () => {
		const { root, srv, repo, manifest } = await setup();
		release(srv, { "linux-x64": NEW_X64, "linux-arm64": NEW_ARM });
		const same = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--repo",
			repo,
		]);
		assert.equal(same.status, 0, `${same.stdout}${same.stderr}`);
		assert.doesNotMatch(
			same.stdout,
			/repo:/,
			"an unchanged repository is not announced",
		);
		const fork = `${srv.origin}/someone-else/fork`;
		for (const target of ["linux-x64", "linux-arm64"]) {
			const bytes = target === "linux-x64" ? NEW_X64 : NEW_ARM;
			srv.setFile(
				`/someone-else/fork/releases/download/v2.0.1/mirror-${target}`,
				bytes,
			);
		}
		srv.setFile(
			"/someone-else/fork/releases/download/v2.0.1/SHA256SUMS",
			`${sha256Hex(NEW_X64)}  mirror-linux-x64\n${sha256Hex(NEW_ARM)}  mirror-linux-arm64\n`,
		);
		const moved = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.1",
			"--repo",
			fork,
		]);
		assert.equal(moved.status, 0, `${moved.stdout}${moved.stderr}`);
		assert.match(
			moved.stdout,
			new RegExp(
				`repo: ${repo.replace(/[/.]/gu, "\\$&")} -> ${fork.replace(/[/.]/gu, "\\$&")}`,
			),
		);
		assert.equal(
			JSON.parse(readFileSync(manifest, "utf8")).assets.mirror.repo,
			fork,
		);
	});
});
