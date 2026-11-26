/**
 * Things in the way that a fetch must not trust or crash on: a link or a
 * directory where a verified file belongs, an unexpected system error, and a
 * directory that is not a git checkout at all.
 */
import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	type FileServer,
	pinsJson,
	runBootstrap,
	runBootstrapAsync,
	scratch,
	sha256Hex,
	spawnBootstrap,
	startServer,
	writeManifest,
} from "./support/pins-support.ts";

const BYTES = Buffer.from("#!/bin/sh\necho robust\n");
const DIGEST = sha256Hex(BYTES);

let server: FileServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

async function setup(): Promise<{
	readonly root: string;
	readonly cached: string;
}> {
	server = await startServer();
	server.setFile("/bin", BYTES);
	const root = scratch("robust");
	const file = `{"url":"${server.origin}/bin","sha256":"${DIGEST}","size":${BYTES.byteLength},"entry":"tool"}`;
	writeManifest(
		root,
		`{"mirror":{"repo":"${server.origin}/example/mirror","tag":"v1.0.0","files":{"linux-x64":${file},"linux-arm64":${file}}}}`,
	);
	return { root, cached: join(root, ".cache/siblings", DIGEST, "tool") };
}

describe("a link or a directory is not a verified file", () => {
	it("a symlink to a correct file is not accepted, and a fetch replaces it", async () => {
		const { root, cached } = await setup();
		const first = await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(first.status, 0, first.stderr);
		const elsewhere = join(root, "elsewhere");
		writeFileSync(elsewhere, BYTES);
		rmSync(cached);
		symlinkSync(elsewhere, cached);
		const status = await runBootstrapAsync(root, ["--status", "--offline"]);
		assert.equal(status.status, 1, status.stdout);
		assert.match(status.stdout, /is not a regular file \(a symbolic link\)/);
		assert.match(
			status.stdout,
			/fix: pnpm run pins:fetch mirror {3}\(replaces it\)/,
		);
		const fetched = await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(fetched.status, 0, fetched.stderr);
		assert.equal(lstatSync(cached).isFile(), true, "a real file now");
		assert.deepEqual(readFileSync(cached), BYTES);
		assert.equal(
			(await runBootstrapAsync(root, ["--status", "--offline"])).status,
			0,
		);
	});

	it("a symlink to /dev/zero is refused without hashing it, so status returns", async () => {
		const { root, cached } = await setup();
		mkdirSync(join(root, ".cache/siblings", DIGEST), {
			recursive: true,
			mode: 0o700,
		});
		symlinkSync("/dev/zero", cached);
		const running = spawnBootstrap(root, ["--status", "--offline"]);
		const timer = setTimeout(() => running.child.kill("SIGKILL"), 6000);
		const status = await running.done;
		clearTimeout(timer);
		assert.equal(
			status.signal,
			null,
			"it was killed while reading an endless file",
		);
		assert.equal(status.status, 1, status.stdout);
		assert.match(status.stdout, /is not a regular file \(a symbolic link\)/);
	});

	it("a directory at the path is reported, and a fetch replaces it", async () => {
		const { root, cached } = await setup();
		mkdirSync(cached, { recursive: true, mode: 0o700 });
		writeFileSync(join(cached, "inside"), "x");
		const status = await runBootstrapAsync(root, ["--status", "--offline"]);
		assert.equal(status.status, 1, status.stdout);
		assert.match(status.stdout, /is not a regular file \(a directory\)/);
		const fetched = await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(fetched.status, 0, fetched.stderr);
		assert.deepEqual(readFileSync(cached), BYTES);
	});
});

describe("an unexpected failure is one line, not a stack", () => {
	it("a cache path that is a file is refused with its fix", async () => {
		const { root } = await setup();
		const cache = join(root, ".cache");
		mkdirSync(cache, { recursive: true, mode: 0o700 });
		writeFileSync(join(cache, "siblings"), "not a directory");
		const run = await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /CACHE_UNSAFE: .*siblings is not a directory/);
		assert.match(run.stderr, /fix: remove /);
		assert.doesNotMatch(run.stderr, /\n\s+at /);
	});

	it("an error nobody planned for prints ERR and its message, and HOBO_PINS_DEBUG shows the stack", () => {
		const root = scratch("robust-eisdir");
		mkdirSync(join(root, "tools/pins/siblings.json"), { recursive: true });
		const plain = runBootstrap(root, ["--status", "--offline"]);
		assert.equal(plain.status, 1);
		assert.match(plain.stderr, /^ERR EISDIR: /u);
		assert.doesNotMatch(plain.stderr, /\n\s+at /);
		const debug = runBootstrap(root, ["--status", "--offline"], {
			HOBO_PINS_DEBUG: "1",
		});
		assert.equal(debug.status, 1);
		assert.match(debug.stderr, /\n\s+at /);
	});
});

describe("a directory that is not a git checkout", () => {
	it("says to clone with git, not that a gitlink is missing", () => {
		const root = scratch("robust-zip");
		mkdirSync(join(root, "tools/pins"), { recursive: true });
		writeFileSync(
			join(root, "tools/pins/siblings.json"),
			pinsJson("https://example.com/o/lib.git"),
		);
		for (const args of [[], ["--status", "--offline"], ["--fetch", "lib"]]) {
			const run = runBootstrap(root, args);
			assert.equal(
				run.status,
				1,
				`${args.join(" ")}\n${run.stdout}${run.stderr}`,
			);
			assert.match(
				run.stderr,
				/is not a git checkout \(a zip download has no submodules\)/,
			);
			assert.match(run.stderr, /git clone --recurse-submodules/);
		}
		assert.equal(existsSync(join(root, "external")), false);
	});
});
