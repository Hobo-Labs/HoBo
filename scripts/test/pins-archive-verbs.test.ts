/**
 * Asset pins of release archives, the verbs: `pins:fetch` verifies the
 * archive and then unpacks the pinned member into the cache, `pins:status`
 * re-checks both, and `pins:bump` finds a Go-named archive
 * (`<name>_<tag>_<os>_<arch>.tar.gz`) in a release's SHA256SUMS, which is what
 * mirror.cloud publishes. Each runs the real script against a loopback release.
 * The archive reader itself is `pins-archive.test.ts`.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { tarGz } from "./support/tar-support.ts";

const TARGET = currentTarget();
const [GOOS = "linux", NODE_ARCH = "x64"] = TARGET.split("-");
// Go names the architectures node calls x64 and arm64 amd64 and arm64.
const GOARCH = NODE_ARCH === "x64" ? "amd64" : NODE_ARCH;
const BINARY = Buffer.from("#!/bin/sh\necho mirror from an archive\n");
const ARCHIVE = tarGz([
	{ name: "LICENSE", body: "MIT\n" },
	{ name: "mirror", body: BINARY },
]);

let server: FileServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

const RELEASE = "/o/mirror/releases/download/v1.0.0";
const ARCHIVE_NAME = `mirror_v1.0.0_${GOOS}_${GOARCH}.tar.gz`;

async function pinnedArchive(bytes: Buffer = ARCHIVE, member = "mirror") {
	const srv = await startServer();
	server = srv;
	const root = scratch("archive-pin");
	srv.setFile(`${RELEASE}/${ARCHIVE_NAME}`, bytes);
	writeManifest(
		root,
		`{"mirror":{"repo":"${srv.origin}/o/mirror","tag":"v1.0.0","files":{"${TARGET}":{"url":"${srv.origin}${RELEASE}/${ARCHIVE_NAME}","sha256":"${sha256Hex(ARCHIVE)}","size":${bytes.length},"entry":"mirror","archive":{"format":"tar.gz","member":"${member}"}}}},"kit":null}`,
	);
	const dir = join(root, ".cache/siblings", sha256Hex(ARCHIVE));
	return {
		srv,
		root,
		entry: join(dir, "mirror"),
		archive: join(dir, ARCHIVE_NAME),
	};
}

function ok(run: { status: number | null; stdout: string; stderr: string }) {
	assert.equal(
		run.status,
		0,
		`exit ${run.status}\n${run.stdout}\n${run.stderr}`,
	);
	return run;
}

describe("pins:fetch and pins:status of an archive pin", () => {
	it("verifies the archive, unpacks the member to the entry (0755), and status re-checks both", async () => {
		const { srv, root, entry, archive } = await pinnedArchive();
		const run = ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		assert.match(run.stdout, /mirror {2}fetched/);
		assert.deepEqual(readFileSync(entry), BINARY);
		assert.equal(statSync(entry).mode & 0o777, 0o755);
		assert.deepEqual(readFileSync(archive), ARCHIVE);
		assert.match(
			ok(await runBootstrapAsync(root, ["--status", "--offline"])).stdout,
			/mirror {2}v1\.0\.0 {2}ok {2}\(.*cached/,
		);
		ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		assert.equal(
			srv.hits.filter((hit) => hit.endsWith(ARCHIVE_NAME)).length,
			1,
		);
	});

	it("an edited entry fails status, and fetch unpacks it again from the cached archive", async () => {
		const { srv, root, entry } = await pinnedArchive();
		ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		writeFileSync(entry, "#!/bin/sh\necho tampered\n");
		const status = await runBootstrapAsync(root, ["--status", "--offline"]);
		assert.equal(status.status, 1, status.stdout + status.stderr);
		assert.match(
			status.stdout + status.stderr,
			/is not mirror from the verified archive/,
		);
		const again = ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		assert.match(
			again.stdout,
			/mirror {2}unpacked again from the verified archive/,
		);
		assert.doesNotMatch(again.stdout, /already cached/);
		assert.deepEqual(readFileSync(entry), BINARY);
		assert.equal(
			srv.hits.filter((hit) => hit.endsWith(ARCHIVE_NAME)).length,
			1,
		);
	});

	it("an edited archive fails status, and fetch downloads it again", async () => {
		const { srv, root, archive } = await pinnedArchive();
		ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		writeFileSync(archive, "corrupt");
		const status = await runBootstrapAsync(root, ["--status", "--offline"]);
		assert.equal(status.status, 1);
		assert.match(
			status.stdout + status.stderr,
			new RegExp(`${ARCHIVE_NAME} hashes to`),
		);
		ok(await runBootstrapAsync(root, ["--fetch", "mirror"]));
		assert.equal(
			srv.hits.filter((hit) => hit.endsWith(ARCHIVE_NAME)).length,
			2,
		);
	});

	it("an archive with the wrong digest is refused before anything is unpacked", async () => {
		const { root, entry } = await pinnedArchive(
			tarGz([{ name: "mirror", body: "other bytes" }]),
		);
		const run = await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /DIGEST_MISMATCH|SIZE_MISMATCH/);
		assert.equal(existsSync(entry), false);
	});

	it("a pinned member the archive does not hold fails fetch and leaves no entry", async () => {
		const { root, entry } = await pinnedArchive(ARCHIVE, "bin/mirror");
		const run = await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /ARCHIVE_MEMBER_MISSING/);
		assert.equal(existsSync(entry), false);
	});

	it("status reports a verified archive that lacks the member on its own line, and goes on", async () => {
		const { root, archive } = await pinnedArchive(ARCHIVE, "bin/mirror");
		await runBootstrapAsync(root, ["--fetch", "mirror"]);
		assert.equal(existsSync(archive), true);
		const status = await runBootstrapAsync(root, ["--status", "--offline"]);
		assert.equal(status.status, 1, status.stdout + status.stderr);
		assert.match(
			status.stdout,
			/mirror {2}v1\.0\.0 {2}FAIL {2}\(.*archive unusable/u,
		);
		assert.match(status.stdout, /holds no regular file named bin\/mirror/u);
		assert.match(status.stdout, /kit {2}unpinned/u);
		// The one ERR line is the summary, not an abort on the first asset.
		assert.match(status.stderr, /^ERR 1 pin\(s\) out of date$/mu);
		assert.doesNotMatch(status.stdout + status.stderr, /^ERR [A-Z_]+:/mu);
	});
});

describe("pins:bump to a release that publishes archives", () => {
	const TAG = "v2.0.0";
	const base = `/o/mirror/releases/download/${TAG}`;
	const named = (os: string, arch: string) =>
		`mirror_${TAG}_${os}_${arch}.tar.gz`;

	async function release(archives: Record<string, Buffer>) {
		const srv = await startServer();
		server = srv;
		const root = scratch("archive-bump");
		writeManifest(root, '{"mirror":null,"kit":null}');
		const sums: string[] = [];
		for (const [name, bytes] of Object.entries(archives)) {
			srv.setFile(`${base}/${name}`, bytes);
			sums.push(`${sha256Hex(bytes)}  ${name}`);
		}
		srv.setFile(`${base}/SHA256SUMS`, `${sums.sort().join("\n")}\n`);
		return { srv, root };
	}

	it("pins each linux archive by its published sum, with the member, and primes the cache", async () => {
		const arm = tarGz([
			{ name: "LICENSE", body: "MIT\n" },
			{ name: "mirror", body: "arm64 build" },
		]);
		const { srv, root } = await release({
			[named("linux", "amd64")]: ARCHIVE,
			[named("linux", "arm64")]: arm,
			[named("darwin", "arm64")]: arm,
		});
		const run = ok(
			await runBootstrapAsync(root, [
				"--bump",
				"mirror",
				TAG,
				"--repo",
				`${srv.origin}/o/mirror`,
			]),
		);
		assert.match(run.stdout, /mirror {2}unpinned -> v2\.0\.0/);
		const pin = JSON.parse(
			readFileSync(join(root, "tools/pins/siblings.json"), "utf8"),
		).assets.mirror;
		assert.deepEqual(pin.files["linux-x64"], {
			url: `${srv.origin}${base}/${named("linux", "amd64")}`,
			sha256: sha256Hex(ARCHIVE),
			size: ARCHIVE.length,
			entry: "mirror",
			archive: { format: "tar.gz", member: "mirror" },
		});
		assert.equal(pin.files["linux-arm64"].sha256, sha256Hex(arm));
		assert.deepEqual(Object.keys(pin.files).sort(), [
			"linux-arm64",
			"linux-x64",
		]);
		assert.match(
			ok(await runBootstrapAsync(root, ["--status", "--offline"])).stdout,
			/mirror {2}v2\.0\.0 {2}ok/,
		);
	});

	it("refuses, and writes nothing, when an archive does not hold the member", async () => {
		const { srv, root } = await release({
			[named("linux", "amd64")]: tarGz([{ name: "LICENSE", body: "MIT" }]),
			[named("linux", "arm64")]: tarGz([{ name: "LICENSE", body: "MIT" }]),
		});
		const before = readFileSync(join(root, "tools/pins/siblings.json"), "utf8");
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			TAG,
			"--repo",
			`${srv.origin}/o/mirror`,
		]);
		assert.equal(run.status, 1);
		assert.match(run.stderr, /ARCHIVE_MEMBER_MISSING/);
		assert.equal(
			readFileSync(join(root, "tools/pins/siblings.json"), "utf8"),
			before,
		);
	});

	it("--member against a release of bare files is a usage error, before any download", async () => {
		const { srv, root } = await release({
			"mirror-linux-x64": BINARY,
			"mirror-linux-arm64": BINARY,
		});
		const before = readFileSync(join(root, "tools/pins/siblings.json"), "utf8");
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			TAG,
			"--repo",
			`${srv.origin}/o/mirror`,
			"--member",
			"mirror",
		]);
		assert.equal(run.status, 2, run.stdout + run.stderr);
		assert.match(
			run.stderr,
			/--member mirror: v2\.0\.0 publishes mirror-linux-\S+, an executable, not an archive/,
		);
		assert.deepEqual(
			srv.hits.filter((hit) => !hit.endsWith("/SHA256SUMS")),
			[],
		);
		assert.equal(
			readFileSync(join(root, "tools/pins/siblings.json"), "utf8"),
			before,
		);
	});

	it("unpacks the member named like the pin's entry when --member is not given", async () => {
		const holding = tarGz([{ name: "osk", body: BINARY }]);
		const { srv, root } = await release({
			[named("linux", "amd64")]: holding,
			[named("linux", "arm64")]: holding,
		});
		writeManifest(
			root,
			`{"mirror":{"repo":"${srv.origin}/o/mirror","tag":"v1.0.0","files":{"linux-x64":{"url":"${srv.origin}/o/mirror/releases/download/v1.0.0/mirror-linux-x64","sha256":"${"a".repeat(64)}","size":3,"entry":"osk"},"linux-arm64":{"url":"${srv.origin}/o/mirror/releases/download/v1.0.0/mirror-linux-arm64","sha256":"${"b".repeat(64)}","size":3,"entry":"osk"}}},"kit":null}`,
		);
		ok(await runBootstrapAsync(root, ["--bump", "mirror", TAG]));
		const pin = JSON.parse(
			readFileSync(join(root, "tools/pins/siblings.json"), "utf8"),
		).assets.mirror;
		assert.deepEqual(pin.files["linux-x64"].archive, {
			format: "tar.gz",
			member: "osk",
		});
		assert.equal(pin.files["linux-x64"].entry, "osk");
	});

	it("refuses --entry named like the archive, before any download", async () => {
		const { srv, root } = await release({
			[named("linux", "amd64")]: ARCHIVE,
			[named("linux", "arm64")]: ARCHIVE,
		});
		const before = readFileSync(join(root, "tools/pins/siblings.json"), "utf8");
		const run = await runBootstrapAsync(root, [
			"--bump",
			"mirror",
			TAG,
			"--repo",
			`${srv.origin}/o/mirror`,
			"--entry",
			named("linux", "amd64"),
		]);
		assert.equal(run.status, 2, run.stdout + run.stderr);
		assert.match(
			run.stderr,
			/the name of the archive it would be unpacked from/u,
		);
		assert.deepEqual(
			srv.hits.filter((hit) => !hit.endsWith("/SHA256SUMS")),
			[],
		);
		assert.equal(
			readFileSync(join(root, "tools/pins/siblings.json"), "utf8"),
			before,
		);
	});

	it("--member names a member below the archive's root", async () => {
		const nested = tarGz([{ name: "bin/mirror", body: BINARY }]);
		const { srv, root } = await release({
			[named("linux", "amd64")]: nested,
			[named("linux", "arm64")]: nested,
		});
		ok(
			await runBootstrapAsync(root, [
				"--bump",
				"mirror",
				TAG,
				"--repo",
				`${srv.origin}/o/mirror`,
				"--member",
				"bin/mirror",
			]),
		);
		const pin = JSON.parse(
			readFileSync(join(root, "tools/pins/siblings.json"), "utf8"),
		).assets.mirror;
		assert.deepEqual(pin.files["linux-x64"].archive, {
			format: "tar.gz",
			member: "bin/mirror",
		});
		assert.deepEqual(
			readFileSync(join(root, ".cache/siblings", sha256Hex(nested), "mirror")),
			BINARY,
		);
	});
});
