/**
 * Asset pins of release archives, the library half: the pin records the
 * archive's sha256 and the one member to run, and `extractMember` reads that
 * member, and only that member, out of a verified archive. The verbs over
 * such a pin are `pins-archive-verbs.test.ts`.
 *
 * Archives are built in memory (support/tar-support.ts) so the hostile ones
 * can be: a link where the binary should be, the binary twice, a pax header
 * that renames it, a corrupt header, a truncated stream.
 */
import assert from "node:assert/strict";
import fs, {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import { PinsError, parsePins } from "../lib/pins.ts";
import { extractMember, memberDigest, writeAll } from "../lib/pins-archive.ts";
import { serializePins } from "../lib/pins-assets.ts";
import { scratch, sha256Hex } from "./support/pins-support.ts";
import { paxPath, tarGz } from "./support/tar-support.ts";

const BINARY = Buffer.from("#!/bin/sh\necho mirror from an archive\n");
const ARCHIVE = tarGz([
	{ name: "LICENSE", body: "MIT\n" },
	{ name: "mirror", body: BINARY },
]);

function refusal(code: string) {
	return (error: Error) => error instanceof PinsError && error.code === code;
}

describe("extractMember", () => {
	function archiveFile(bytes: Buffer) {
		const dir = scratch("archive");
		const path = join(dir, "a.tar.gz");
		writeFileSync(path, bytes);
		return { dir, path };
	}

	it("writes only the named member, with its bytes and mode 0755", async () => {
		const { dir, path } = archiveFile(ARCHIVE);
		const dest = join(dir, "mirror-entry");
		await extractMember(path, "mirror", dest, sha256Hex(ARCHIVE));
		assert.deepEqual(readFileSync(dest), BINARY);
		assert.equal(statSync(dest).mode & 0o777, 0o755);
		assert.deepEqual(readdirSync(dir).sort(), ["a.tar.gz", "mirror-entry"]);
		assert.deepEqual(await memberDigest(path, "mirror"), {
			archive: sha256Hex(ARCHIVE),
			member: sha256Hex(BINARY),
		});
	});

	it("writes the member 0755 whatever mode its header gives: setuid dropped, 0644 made executable", async () => {
		for (const mode of ["0006755\0", "0004755\0", "0000644\0", "0001777\0"]) {
			const bytes = tarGz([
				{ name: "mirror", body: BINARY, raw: [[100, mode]] },
			]);
			const { dir, path } = archiveFile(bytes);
			const dest = join(dir, "out");
			await extractMember(path, "mirror", dest, sha256Hex(bytes));
			assert.equal(statSync(dest).mode & 0o7777, 0o755, mode);
		}
	});

	it("refuses an absolute or climbing name anywhere in the archive, and writes nothing", async () => {
		for (const name of ["/etc/escaped", "../../escaped", "/mirror"]) {
			const bytes = tarGz([
				{ name, body: "x" },
				{ name: "mirror", body: BINARY },
			]);
			const { dir, path } = archiveFile(bytes);
			await assert.rejects(
				extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
				refusal("ARCHIVE_UNSAFE"),
				name,
			);
			assert.deepEqual(readdirSync(dir), ["a.tar.gz"]);
			assert.equal(existsSync(join(dir, "..", "..", "escaped")), false);
		}
	});

	const hostile: [string, Buffer, string][] = [
		[
			"a member the archive does not hold",
			tarGz([{ name: "LICENSE", body: "MIT" }]),
			"ARCHIVE_MEMBER_MISSING",
		],
		[
			"a member that is a symbolic link",
			tarGz([{ name: "mirror", type: "2", linkname: "/bin/sh" }]),
			"ARCHIVE_UNSAFE",
		],
		[
			"a member that is a directory",
			tarGz([{ name: "mirror", type: "5" }]),
			"ARCHIVE_UNSAFE",
		],
		[
			"the member twice",
			tarGz([
				{ name: "mirror", body: BINARY },
				{ name: "./mirror", body: "other" },
			]),
			"ARCHIVE_UNSAFE",
		],
		[
			"a pax header that renames the next entry",
			tarGz([
				{ name: "PaxHeader", type: "x", body: paxPath("mirror") },
				{ name: "evil", body: "x" },
			]),
			"ARCHIVE_UNSUPPORTED",
		],
		[
			"a header with a wrong checksum",
			tarGz([{ name: "mirror", body: BINARY, badChecksum: true }]),
			"ARCHIVE_MALFORMED",
		],
		[
			"a truncated archive",
			ARCHIVE.subarray(0, ARCHIVE.length - 20),
			"ARCHIVE_MALFORMED",
		],
		[
			"bytes that are not gzip",
			Buffer.from("not an archive at all"),
			"ARCHIVE_MALFORMED",
		],
	];
	for (const [what, bytes, code] of hostile) {
		it(`refuses ${what} (${code}) and leaves nothing at the destination`, async () => {
			const { dir, path } = archiveFile(bytes);
			const dest = join(dir, "out");
			await assert.rejects(
				extractMember(path, "mirror", dest, sha256Hex(bytes)),
				refusal(code),
			);
			assert.equal(existsSync(dest), false);
			assert.deepEqual(readdirSync(dir), ["a.tar.gz"]);
		});
	}
});

describe("writeAll", () => {
	it("keeps writing until every byte is written when a write takes only some", () => {
		const path = join(scratch("write-all"), "out");
		const fd = openSync(path, "w");
		const bytes = Buffer.from("0123456789abcdef");
		const asked: number[] = [];
		try {
			writeAll(fd, bytes, (out, buffer, offset, length) => {
				asked.push(length);
				return writeSync(out, buffer, offset, Math.min(length, 5));
			});
		} finally {
			closeSync(fd);
		}
		assert.deepEqual(readFileSync(path), bytes);
		assert.deepEqual(asked, [16, 11, 6, 1]);
	});

	it("throws ARCHIVE_WRITE_FAILED on a write that makes no progress instead of looping", () => {
		assert.throws(
			() => writeAll(-1, Buffer.from("x"), () => 0),
			(error: Error) =>
				refusal("ARCHIVE_WRITE_FAILED")(error) &&
				/wrote 0 of 1 bytes/u.test(error.message),
		);
	});
});

describe("a failure writing the member", () => {
	/** An error shaped like node's own file system errors: `code` and a message that starts with it. */
	function injected(code: string, call: string): Error {
		return Object.assign(new Error(`${code}: injected, ${call}`), { code });
	}

	/**
	 * Make node:fs's `name` throw `code` for any descriptor but stdin, stdout
	 * and stderr until the test ends; the reader's named import sees it too.
	 */
	function inject(
		t: TestContext,
		name: "writeSync" | "fsyncSync",
		code: string,
	): void {
		if (name === "writeSync") {
			const real = fs.writeSync;
			t.mock.method(
				fs,
				"writeSync",
				(fd: number, buffer: Uint8Array, offset?: number, length?: number) => {
					if (fd <= 2) return real(fd, buffer, offset, length);
					throw injected(code, name);
				},
			);
		} else {
			const real = fs.fsyncSync;
			t.mock.method(fs, "fsyncSync", (fd: number) => {
				if (fd <= 2) return real(fd);
				throw injected(code, name);
			});
		}
		syncBuiltinESMExports();
		t.after(() => {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		});
	}

	it("names each path once when the rename into place fails", async () => {
		const dir = scratch("rename-failed");
		const path = join(dir, "a.tar.gz");
		writeFileSync(path, ARCHIVE);
		// A directory with something in it where the entry goes: rename(2) cannot replace it.
		const dest = join(dir, "out");
		mkdirSync(join(dest, "x"), { recursive: true });
		await assert.rejects(
			extractMember(path, "mirror", dest, sha256Hex(ARCHIVE)),
			(error: Error) => {
				assert.ok(error instanceof PinsError, String(error));
				assert.equal(error.code, "ARCHIVE_WRITE_FAILED");
				assert.ok(error.cause instanceof Error && "code" in error.cause);
				const errno = String(error.cause.code);
				assert.equal(error.message.split(errno).length - 1, 1, error.message);
				assert.equal(
					error.message.split(`'${dest}'`).length - 1,
					1,
					error.message,
				);
				assert.equal(
					error.message.split(`${dest}.`).length - 1,
					1,
					error.message,
				);
				return true;
			},
		);
		assert.deepEqual(readdirSync(dir).sort(), ["a.tar.gz", "out"]);
		assert.deepEqual(readdirSync(dest), ["x"]);
	});

	it("removes the partial file and keeps the write failure when closing it fails too", async (t) => {
		const dir = scratch("close-failed");
		const path = join(dir, "a.tar.gz");
		writeFileSync(path, ARCHIVE);
		inject(t, "writeSync", "ENOSPC");
		// As NFS reports a deferred write error: the descriptor is closed, and close says EIO.
		const realClose = fs.closeSync;
		t.mock.method(fs, "closeSync", (fd: number) => {
			realClose(fd);
			if (fd > 2) throw injected("EIO", "closeSync");
		});
		syncBuiltinESMExports();
		await assert.rejects(
			extractMember(path, "mirror", join(dir, "out"), sha256Hex(ARCHIVE)),
			(error: Error) => {
				assert.ok(error instanceof PinsError, String(error));
				assert.equal(error.code, "ARCHIVE_WRITE_FAILED");
				assert.ok(error.cause instanceof Error && "code" in error.cause);
				assert.equal(error.cause.code, "ENOSPC");
				const [closing] = error.suppressed;
				assert.ok(closing instanceof Error && "code" in closing);
				assert.equal(closing.code, "EIO");
				assert.match(error.message, /closing .* afterwards failed too: EIO/u);
				return true;
			},
		);
		assert.deepEqual(readdirSync(dir), ["a.tar.gz"]);
	});

	it("says the partial file was kept, and where, when removing it fails", async (t) => {
		const dir = scratch("rm-failed");
		const path = join(dir, "a.tar.gz");
		writeFileSync(path, ARCHIVE);
		const realRm = fs.rmSync;
		t.mock.method(fs, "rmSync", (target: string, options?: fs.RmOptions) => {
			if (String(target).endsWith(".partial"))
				throw injected("EBUSY", "rmSync");
			return realRm(target, options);
		});
		syncBuiltinESMExports();
		await assert.rejects(
			extractMember(path, "mirror", join(dir, "out"), "0".repeat(64)),
			(error: Error) => {
				assert.ok(error instanceof PinsError, String(error));
				assert.equal(error.code, "DIGEST_MISMATCH");
				const partial = readdirSync(dir).find((name) =>
					name.endsWith(".partial"),
				);
				assert.ok(partial !== undefined, "the partial file is still there");
				assert.doesNotMatch(error.message, /nothing was kept/u);
				assert.ok(
					error.message.endsWith(
						`; the partial file was kept at ${join(dir, partial)}`,
					),
					error.message,
				);
				const [removing] = error.suppressed;
				assert.ok(removing instanceof Error && "code" in removing);
				assert.equal(removing.code, "EBUSY");
				return true;
			},
		);
	});

	it("keeps the failure underneath an interruption as its cause, with what was suppressed", async (t) => {
		const dir = scratch("interrupted");
		const path = join(dir, "a.tar.gz");
		writeFileSync(path, ARCHIVE);
		// A listener of the test's own keeps the guard from ending the process.
		const stay = (): void => undefined;
		process.on("SIGTERM", stay);
		t.after(() => {
			process.off("SIGTERM", stay);
		});
		const realWrite = fs.writeSync;
		t.mock.method(
			fs,
			"writeSync",
			(fd: number, buffer: Uint8Array, offset?: number, length?: number) => {
				if (fd <= 2) return realWrite(fd, buffer, offset, length);
				process.emit("SIGTERM", "SIGTERM");
				throw injected("ENOSPC", "writeSync");
			},
		);
		const realClose = fs.closeSync;
		t.mock.method(fs, "closeSync", (fd: number) => {
			realClose(fd);
			if (fd > 2) throw injected("EIO", "closeSync");
		});
		syncBuiltinESMExports();
		await assert.rejects(
			extractMember(path, "mirror", join(dir, "out"), sha256Hex(ARCHIVE)),
			(error: Error) => {
				assert.ok(error instanceof PinsError, String(error));
				assert.equal(error.code, "INTERRUPTED");
				assert.match(
					error.message,
					/interrupted by SIGTERM; nothing was kept$/u,
				);
				assert.ok(error.cause instanceof PinsError, String(error.cause));
				assert.equal(error.cause.code, "ARCHIVE_WRITE_FAILED");
				const [closing] = error.suppressed;
				assert.ok(closing instanceof Error && "code" in closing);
				assert.equal(closing.code, "EIO");
				return true;
			},
		);
		assert.deepEqual(readdirSync(dir), ["a.tar.gz"]);
	});

	it("rejects an interrupted unpack and renames nothing into place, even when the partial file cannot be removed", async (t) => {
		const dir = scratch("interrupted-kept");
		const path = join(dir, "a.tar.gz");
		writeFileSync(path, ARCHIVE);
		const dest = join(dir, "out");
		// An embedder's own listener: the guard cleans up and does not end the process.
		const stay = (): void => undefined;
		process.on("SIGTERM", stay);
		t.after(() => {
			process.off("SIGTERM", stay);
		});
		// The guard's removal of the partial file fails, and so does the failure path's.
		const realRm = fs.rmSync;
		t.mock.method(fs, "rmSync", (target: string, options?: fs.RmOptions) => {
			if (String(target).endsWith(".partial")) {
				throw injected("EBUSY", "rmSync");
			}
			return realRm(target, options);
		});
		// SIGTERM arrives during the read; every write still succeeds.
		const realWrite = fs.writeSync;
		let signalled = false;
		t.mock.method(
			fs,
			"writeSync",
			(fd: number, buffer: Uint8Array, offset?: number, length?: number) => {
				if (fd > 2 && !signalled) {
					signalled = true;
					process.emit("SIGTERM", "SIGTERM");
				}
				return realWrite(fd, buffer, offset, length);
			},
		);
		syncBuiltinESMExports();
		await assert.rejects(
			extractMember(path, "mirror", dest, sha256Hex(ARCHIVE)),
			(error: Error) => {
				assert.ok(error instanceof PinsError, String(error));
				assert.equal(error.code, "INTERRUPTED");
				const partial = readdirSync(dir).find((name) =>
					name.endsWith(".partial"),
				);
				assert.ok(
					partial !== undefined,
					"the partial file the guard could not remove",
				);
				assert.ok(
					error.message.endsWith(
						`; the partial file was kept at ${join(dir, partial)}`,
					),
					error.message,
				);
				return true;
			},
		);
		assert.equal(signalled, true);
		assert.equal(existsSync(dest), false);
	});

	for (const [name, code] of [
		["writeSync", "ENOSPC"],
		["fsyncSync", "EIO"],
	] as const) {
		it(`is ARCHIVE_WRITE_FAILED carrying ${code} when ${name} fails, never ARCHIVE_MALFORMED, and leaves nothing`, async (t) => {
			const dir = scratch("write-failed");
			const path = join(dir, "a.tar.gz");
			writeFileSync(path, ARCHIVE);
			const dest = join(dir, "out");
			inject(t, name, code);
			await assert.rejects(
				extractMember(path, "mirror", dest, sha256Hex(ARCHIVE)),
				(error: Error) => {
					assert.ok(error instanceof PinsError, String(error));
					assert.equal(error.code, "ARCHIVE_WRITE_FAILED");
					assert.equal(error.message.split(code).length - 1, 1, error.message);
					assert.ok(error.cause instanceof Error && "code" in error.cause);
					assert.equal(error.cause.code, code);
					return true;
				},
			);
			assert.deepEqual(readdirSync(dir), ["a.tar.gz"]);
		});
	}
});

describe("an asset pin of an archive", () => {
	const file = (overrides: string) =>
		`{"url":"https://example.com/o/mirror/releases/download/v1.0.0/mirror_v1.0.0_linux_amd64.tar.gz","sha256":"${"a".repeat(64)}","size":10,"entry":"mirror"${overrides}}`;
	const manifest = (fileText: string) =>
		`{"schemaVersion":1,"git":{},"assets":{"mirror":{"repo":"https://example.com/o/mirror","tag":"v1.0.0","files":{"linux-x64":${fileText}}}},"vendor":{}}`;

	it("parses the archive and serialises it back unchanged", () => {
		const text = manifest(
			file(',"archive":{"format":"tar.gz","member":"mirror"}'),
		);
		const pins = parsePins(text);
		assert.deepEqual(pins.assets.mirror?.files["linux-x64"]?.archive, {
			format: "tar.gz",
			member: "mirror",
		});
		assert.equal(
			serializePins(pins),
			`${JSON.stringify(JSON.parse(text), null, 2)}\n`,
		);
	});

	for (const [what, archive] of [
		["a member that climbs out", '{"format":"tar.gz","member":"../mirror"}'],
		["an absolute member", '{"format":"tar.gz","member":"/mirror"}'],
		["an empty segment", '{"format":"tar.gz","member":"bin//mirror"}'],
		["a dot segment", '{"format":"tar.gz","member":"./mirror"}'],
		["an empty member", '{"format":"tar.gz","member":""}'],
		["a format it cannot read", '{"format":"zip","member":"mirror"}'],
		["an unknown key", '{"format":"tar.gz","member":"mirror","strip":1}'],
	] as const) {
		it(`refuses ${what}`, () => {
			assert.throws(
				() => parsePins(manifest(file(`,"archive":${archive}`))),
				refusal("PINS_MALFORMED"),
			);
		});
	}

	it("refuses an entry named like the archive it is unpacked from", () => {
		const text = manifest(
			file(',"archive":{"format":"tar.gz","member":"mirror"}').replace(
				'"entry":"mirror"',
				'"entry":"mirror_v1.0.0_linux_amd64.tar.gz"',
			),
		);
		assert.throws(() => parsePins(text), refusal("PINS_MALFORMED"));
	});

	it("refuses an archive whose URL does not end in .tar.gz", () => {
		const text = manifest(
			file(',"archive":{"format":"tar.gz","member":"mirror"}').replace(
				"mirror_v1.0.0_linux_amd64.tar.gz",
				"mirror-linux-x64",
			),
		);
		assert.throws(() => parsePins(text), refusal("PINS_MALFORMED"));
	});
});
