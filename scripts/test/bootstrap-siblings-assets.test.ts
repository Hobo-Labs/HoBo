/**
 * `scripts/bootstrap-siblings.mts` for asset pins: a release asset is pinned
 * by sha256, fetched once per machine into a content-addressed cache, and
 * re-hashed whenever the cache is asked about it.
 *
 * The release server is a real HTTP server on loopback and the script is the
 * real script; the manifest's `repo` points at that server, which the script
 * accepts only because the test sets HOBO_PINS_ALLOW_LOCAL.
 */
import assert from "node:assert/strict";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { currentTarget } from "../lib/pins-assets.ts";
import {
	type FileServer,
	runBootstrapAsync,
	scratch,
	sha256Hex,
	startServer,
	writeManifest,
} from "./support/pins-support.ts";

const TARGET = currentTarget();
const BYTES = Buffer.from("#!/bin/sh\necho mirror\n");
const DIGEST = sha256Hex(BYTES);

let server: FileServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

interface Setup {
	readonly root: string;
	readonly srv: FileServer;
	readonly cached: string;
}

async function setup(assets: (origin: string) => string): Promise<Setup> {
	const srv = await startServer();
	server = srv;
	const root = scratch("assets");
	writeManifest(root, assets(srv.origin));
	srv.setFile("/bin/mirror", BYTES);
	return { root, srv, cached: join(root, ".cache/siblings", DIGEST, "mirror") };
}

function pinned(origin: string, overrides = ""): string {
	return `{"mirror":{"repo":"${origin}/example/mirror","tag":"v1.0.0","files":{"${TARGET}":{"url":"${origin}/bin/mirror","sha256":"${DIGEST}","size":${BYTES.byteLength},"entry":"mirror"${overrides}}}},"kit":null}`;
}

function ok(run: { status: number | null; stdout: string; stderr: string }) {
	assert.equal(
		run.status,
		0,
		`exit ${run.status}\n${run.stdout}\n${run.stderr}`,
	);
	return run;
}

describe("bootstrap-siblings --fetch (assets)", () => {
	it("fetch downloads once and serves the second call from the cache (server saw one request)", async () => {
		const { root, srv, cached } = await setup((origin) => pinned(origin));
		const first = ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		assert.match(first.stdout, /mirror {2}fetched .* to /);
		const second = ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		assert.match(second.stdout, /mirror {2}already cached at /);
		assert.deepEqual(srv.hits, ["GET /bin/mirror"]);
		assert.deepEqual(readFileSync(cached), BYTES);
		assert.ok(
			(statSync(cached).mode & 0o111) !== 0,
			"the verified file is executable",
		);
	});

	it("fetch with a wrong sha256 exits 1 and leaves no file", async () => {
		const { root, srv } = await setup((origin) =>
			pinned(origin).replace(DIGEST, sha256Hex("something else")),
		);
		srv.setFile("/bin/mirror", "tampered bytes");
		const run = await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /DIGEST_MISMATCH/);
		assert.match(run.stderr, new RegExp(sha256Hex("tampered bytes")));
		const left = existsSync(join(root, ".cache/siblings"))
			? readdirSync(join(root, ".cache/siblings"), { recursive: true })
			: [];
		assert.deepEqual(left, [], "nothing was kept, not even an empty directory");
	});

	it("fetch of an unpublished asset says so and names its override variable", async () => {
		const { root } = await setup((origin) => pinned(origin));
		const kit = await runBootstrapAsync(root, ["--fetch", "kit"]);
		assert.equal(kit.status, 1);
		assert.match(kit.stderr, /ASSET_UNPUBLISHED/);
		assert.match(kit.stderr, /HOBO_KIT/);
		const bare = scratch("assets-null");
		writeManifest(bare, '{"mirror":null,"opensesame-kit":null}');
		const named = await runBootstrapAsync(bare, ["--fetch", "mirror"]);
		assert.equal(named.status, 1);
		assert.match(named.stderr, /ASSET_UNPUBLISHED.*MIRROR_BIN/);
		const kitNamed = await runBootstrapAsync(bare, [
			"--fetch",
			"opensesame-kit",
		]);
		assert.match(kitNamed.stderr, /HOBO_OPENSESAME_KIT/);
	});

	it("fetching everything skips what is not published instead of failing", async () => {
		const { root } = await setup((origin) => pinned(origin));
		const run = ok(await runBootstrapAsync(root, ["--fetch"]));
		assert.match(run.stdout, /mirror {2}fetched/);
		assert.match(
			run.stdout,
			/kit {2}skipped {2}\(not published yet; set HOBO_KIT/,
		);
	});

	it("fetch refuses a machine the release has no build for, and lists the builds", async () => {
		const { root } = await setup((origin) =>
			pinned(origin).replace(TARGET, "plan9-x64"),
		);
		const run = await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(run.status, 1);
		assert.match(
			run.stderr,
			new RegExp(
				`TARGET_UNSUPPORTED: mirror is not published for ${TARGET}; supported: plan9-x64`,
			),
		);
	});
});

describe("bootstrap-siblings --status (assets)", () => {
	it("lists an unpublished asset as unpinned and says whether its override is set", async () => {
		const { root } = await setup((origin) => pinned(origin));
		const bare = scratch("assets-status");
		writeManifest(bare, '{"mirror":null}');
		const unset = ok(
			await runBootstrapAsync(bare, ["--status", "--offline"], {
				MIRROR_BIN: "",
			}),
		);
		assert.match(
			unset.stdout,
			/mirror {2}unpinned {2}\(not published yet; MIRROR_BIN is unset\)/,
		);
		const set = ok(
			await runBootstrapAsync(bare, ["--status", "--offline"], {
				MIRROR_BIN: "/opt/mirror",
			}),
		);
		assert.match(set.stdout, /MIRROR_BIN is set/);
		assert.match(
			ok(await runBootstrapAsync(root, ["--status", "--offline"])).stdout,
			/kit {2}unpinned/,
		);
	});

	it("accepts the -- that pnpm passes through (pnpm run pins:status -- --online)", async () => {
		const { root } = await setup((origin) => pinned(origin));
		const run = ok(
			await runBootstrapAsync(root, ["--status", "--", "--offline"]),
		);
		assert.match(run.stdout, /mirror {2}v1\.0\.0 {2}ok/);
	});

	it("says not cached, and still exits 0, before anything was fetched", async () => {
		const { root } = await setup((origin) => pinned(origin));
		const run = ok(await runBootstrapAsync(root, ["--status", "--offline"]));
		assert.match(
			run.stdout,
			new RegExp(
				`mirror {2}v1\\.0\\.0 {2}ok {2}\\(${TARGET} sha256 ${DIGEST.slice(0, 7)}, not cached; pnpm run pins:fetch mirror\\)`,
			),
		);
	});

	it("re-hashes the cached file and exits 1 naming it when one byte was edited", async () => {
		const { root, cached } = await setup((origin) => pinned(origin));
		ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		const clean = ok(await runBootstrapAsync(root, ["--status", "--offline"]));
		assert.match(clean.stdout, /mirror {2}v1\.0\.0 {2}ok {2}\(.*, cached\)/);
		const edited = Buffer.from(readFileSync(cached));
		edited[0] = (edited[0] ?? 0) ^ 1;
		writeFileSync(cached, edited);
		const run = await runBootstrapAsync(root, ["--status", "--offline"]);
		assert.equal(run.status, 1);
		assert.match(run.stdout, /mirror {2}v1\.0\.0 {2}FAIL/);
		assert.ok(
			run.stdout.includes(cached),
			`the report names ${cached}:\n${run.stdout}`,
		);
		assert.match(run.stdout, new RegExp(`hashes to ${sha256Hex(edited)}`));
		assert.match(
			run.stdout,
			/fix: pnpm run pins:fetch mirror {3}\(replaces the corrupt file\)/,
		);
		assert.doesNotMatch(run.stdout, /fix: delete/);
		// Fetching replaces the corrupt file instead of trusting it.
		ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		assert.deepEqual(readFileSync(cached), BYTES);
		ok(await runBootstrapAsync(root, ["--status", "--offline"]));
	});

	it("reports a machine the release has no build for as n/a, not as drift", async () => {
		const { root } = await setup((origin) =>
			pinned(origin).replace(TARGET, "plan9-x64"),
		);
		const run = ok(await runBootstrapAsync(root, ["--status", "--offline"]));
		assert.match(
			run.stdout,
			new RegExp(
				`mirror {2}v1\\.0\\.0 {2}n/a {2}\\(no ${TARGET} build; published: plan9-x64\\)`,
			),
		);
	});

	it("--online compares the pin with the release's published SHA256SUMS", async () => {
		const { root, srv, cached } = await setup((origin) => pinned(origin));
		const sums = "/example/mirror/releases/download/v1.0.0/SHA256SUMS";
		srv.setFile(sums, `${DIGEST}  mirror\n`);
		ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		const agrees = ok(await runBootstrapAsync(root, ["--status", "--online"]));
		assert.match(agrees.stdout, /matches SHA256SUMS/);
		// A corrupt cache is not the release's fault: no suggestion to re-pin.
		writeFileSync(cached, "corrupt");
		const corrupt = await runBootstrapAsync(root, ["--status", "--online"]);
		assert.equal(corrupt.status, 1);
		assert.doesNotMatch(corrupt.stdout, /pins:bump/);
		ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		srv.setFile(sums, `${sha256Hex("rebuilt")}  mirror\n`);
		const differs = await runBootstrapAsync(root, ["--status", "--online"]);
		assert.equal(differs.status, 1);
		assert.match(
			differs.stdout,
			new RegExp(
				`${TARGET}: the pin says ${DIGEST}; SHA256SUMS of v1\\.0\\.0 says ${sha256Hex("rebuilt")}`,
			),
		);
		assert.match(differs.stdout, /pnpm run pins:bump mirror v1\.0\.0/);
	});
});

describe("bootstrap-siblings --bump (assets)", () => {
	const SUMS = "/example/mirror/releases/download/v2.0.0/SHA256SUMS";
	const FILE = `/example/mirror/releases/download/v2.0.0/mirror-${TARGET}`;

	it("records the sha256 from the release's SHA256SUMS and the measured size, and changes only that entry", async () => {
		const { root, srv } = await setup(() => '{"mirror":null,"kit":null}');
		const bytes = Buffer.from("a newer mirror, longer than the first\n");
		srv.setFile(FILE, bytes);
		srv.setFile(SUMS, `${sha256Hex(bytes)}  mirror-${TARGET}\n`);
		const before = readFileSync(join(root, "tools/pins/siblings.json"), "utf8");
		const run = ok(
			await runBootstrapAsync(root, [
				"--bump",
				"mirror",
				"v2.0.0",
				"--repo",
				`${srv.origin}/example/mirror`,
			]),
		);
		assert.match(run.stdout, /mirror {2}unpinned -> v2\.0\.0/);
		const after = JSON.parse(
			readFileSync(join(root, "tools/pins/siblings.json"), "utf8"),
		);
		assert.deepEqual(after.assets.mirror, {
			repo: `${srv.origin}/example/mirror`,
			tag: "v2.0.0",
			files: {
				[TARGET]: {
					url: `${srv.origin}${FILE}`,
					sha256: sha256Hex(bytes),
					size: bytes.byteLength,
					entry: "mirror",
				},
			},
		});
		assert.equal(after.assets.kit, null);
		assert.deepEqual(after.git, JSON.parse(before).git);
		assert.deepEqual(after.vendor, JSON.parse(before).vendor);
		// The download that proved the sum primed the cache, so status is ok offline.
		assert.deepEqual(
			readFileSync(join(root, ".cache/siblings", sha256Hex(bytes), "mirror")),
			bytes,
		);
		assert.match(
			ok(await runBootstrapAsync(root, ["--status", "--offline"])).stdout,
			/mirror {2}v2\.0\.0 {2}ok {2}\(.*, cached\)/,
		);
	});

	it("refuses and writes nothing when the downloaded bytes do not match the published sum", async () => {
		const { root, srv } = await setup(() => '{"mirror":null}');
		srv.setFile(FILE, "what the server really sends");
		srv.setFile(
			SUMS,
			`${sha256Hex("what the sums claim")}  mirror-${TARGET}\n`,
		);
		const path = join(root, "tools/pins/siblings.json");
		const before = readFileSync(path, "utf8");
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--repo",
			`${srv.origin}/example/mirror`,
		]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /DIGEST_MISMATCH/);
		assert.equal(
			readFileSync(path, "utf8"),
			before,
			"the manifest is untouched",
		);
	});

	it("asks for --repo when the pin has no repository yet", async () => {
		const { root } = await setup(() => '{"mirror":null}');
		const run = await runBootstrapAsync(root, ["--bump", "mirror", "v2.0.0"]);
		assert.equal(run.status, 2);
		assert.match(run.stderr, /has no repository yet: pass --repo/);
	});

	it("fails when the release publishes none of the pin's files", async () => {
		const { root, srv } = await setup(() => '{"mirror":null}');
		srv.setFile(SUMS, `${sha256Hex("x")}  unrelated-file\n`);
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			"v2.0.0",
			"--repo",
			`${srv.origin}/example/mirror`,
		]);
		assert.equal(run.status, 1);
		assert.match(
			run.stderr,
			new RegExp(
				`SHA256SUMS of v2\\.0\\.0 lists none of mirror-linux-x64, mirror-linux-arm64`,
			),
		);
	});
});

describe("bootstrap-siblings vendored pins", () => {
	const VENDOR =
		'{"anti-slop":{"from":"OpenSesame","path":"skills/x/assets/anti-slop","dest":"tools/oxlint/anti-slop"}}';

	it("status lists a vendored copy and says it does not check it", async () => {
		const root = scratch("vendor");
		writeManifest(root, "{}", VENDOR);
		const run = ok(await runBootstrapAsync(root, ["--status", "--offline"]));
		assert.match(
			run.stdout,
			/anti-slop {2}vendored from OpenSesame {2}\(not checked by pins:status\)/,
		);
	});

	it("fetch and bump refuse a vendored copy and name where it comes from", async () => {
		const root = scratch("vendor-verbs");
		writeManifest(root, "{}", VENDOR);
		for (const args of [
			["--fetch", "anti-slop"],
			["--bump", "anti-slop", "main"],
		]) {
			const run = await runBootstrapAsync(root, args);
			assert.equal(run.status, 2, `${args.join(" ")}\n${run.stderr}`);
			assert.match(
				run.stderr,
				/anti-slop is a vendored copy of \.\.\/OpenSesame\/skills\/x\/assets\/anti-slop/,
			);
		}
	});
});
