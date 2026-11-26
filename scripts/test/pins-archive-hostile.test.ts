/**
 * The archive reader against the archives a careful reader must not trust:
 * entries `tar` would read differently, names spelled two ways, files that
 * cannot be opened, bytes that are not the pinned archive.
 *
 * Where the question is "what would `tar` do", the answer is GNU tar's, run
 * on the same bytes: an entry type the reader does not model carries data
 * that GNU tar treats as that entry's contents, never as headers, so a reader
 * that skipped over the type and parsed the data as headers would find a
 * member `tar` never extracts. Refusing such a type is the only safe reading.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";

import { PinsError } from "../lib/pins.ts";
import {
	extractMember,
	MAX_MEMBER_BYTES,
	memberDigest,
} from "../lib/pins-archive.ts";
import { scratch, sha256Hex } from "./support/pins-support.ts";
import { noGnuTar } from "./support/tar-diff.ts";
import { type TarEntry, tarGz, tarStream } from "./support/tar-support.ts";

const BINARY = Buffer.from("#!/bin/sh\necho mirror from an archive\n");
const SMUGGLED = Buffer.from("#!/bin/sh\necho smuggled\n");

function refusal(code: string) {
	return (error: Error) => error instanceof PinsError && error.code === code;
}

function archiveFile(bytes: Buffer) {
	const dir = scratch("archive-hostile");
	const path = join(dir, "a.tar.gz");
	writeFileSync(path, bytes);
	return { dir, path };
}

/** What GNU tar lists, and what it extracts into a fresh directory. */
function asGnuTarSees(path: string) {
	const listed = execFileSync("tar", ["-tzf", path], { encoding: "utf8" })
		.split("\n")
		.filter((line) => line !== "");
	const into = join(scratch("gnu-tar-out"), "x");
	mkdirSync(into);
	spawnSync("tar", ["-xzf", path, "-C", into], { encoding: "utf8" });
	return { listed, extracted: readdirSync(into).sort() };
}

/** An entry of `type` whose data is a ustar stream holding a `mirror` member. */
function decoy(type: string): Buffer {
	return tarGz([
		{
			name: "decoy",
			type,
			body: tarStream([{ name: "mirror", body: SMUGGLED }]),
		},
	]);
}

describe("entry types the reader does not model", () => {
	for (const [type, kind] of [
		["7", "contiguous file"],
		["D", "GNU dumpdir"],
	] as const) {
		it(`refuses a type ${type} (${kind}) entry`, async () => {
			const bytes = decoy(type);
			const { dir, path } = archiveFile(bytes);
			const dest = join(dir, "out");
			await assert.rejects(
				extractMember(path, "mirror", dest, sha256Hex(bytes)),
				refusal("ARCHIVE_UNSUPPORTED"),
			);
			assert.equal(existsSync(dest), false);
		});

		it(`GNU tar reads a type ${type} (${kind}) entry's data as its own, never as headers`, {
			skip: noGnuTar,
		}, () => {
			const { path } = archiveFile(decoy(type));
			const seen = asGnuTarSees(path);
			assert.deepEqual(seen.listed, ["decoy"]);
			assert.equal(seen.extracted.includes("mirror"), false);
		});
	}

	for (const type of ["S", "M", "N", "V", "A", "Z"]) {
		it(`refuses a type ${type} entry as unsupported`, async () => {
			const bytes = tarGz([
				{ name: "other", type, body: "x" },
				{ name: "mirror", body: BINARY },
			]);
			const { dir, path } = archiveFile(bytes);
			await assert.rejects(
				extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
				refusal("ARCHIVE_UNSUPPORTED"),
			);
		});
	}

	it("refuses GNU long-name and long-link headers", async () => {
		for (const type of ["L", "K"]) {
			const bytes = tarGz([
				{ name: "././@LongLink", type, body: "mirror\0" },
				{ name: "evil", body: SMUGGLED },
			]);
			const { dir, path } = archiveFile(bytes);
			await assert.rejects(
				extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
				refusal("ARCHIVE_UNSUPPORTED"),
			);
		}
	});

	it("refuses a link, device or directory entry that claims data", async () => {
		for (const type of ["1", "2", "3", "4", "5", "6"]) {
			const bytes = tarGz([
				{
					name: "other",
					type,
					body: tarStream([{ name: "mirror", body: SMUGGLED }]),
				},
				{ name: "mirror", body: BINARY },
			]);
			const { dir, path } = archiveFile(bytes);
			await assert.rejects(
				extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
				refusal("ARCHIVE_MALFORMED"),
				`type ${type}`,
			);
		}
	});

	it("refuses a member that is a hard link, a device or a FIFO", async () => {
		for (const type of ["1", "3", "4", "6"]) {
			const bytes = tarGz([{ name: "mirror", type, linkname: "LICENSE" }]);
			const { dir, path } = archiveFile(bytes);
			await assert.rejects(
				extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
				refusal("ARCHIVE_UNSAFE"),
				`type ${type}`,
			);
		}
	});

	it("refuses a header that is not ustar", async () => {
		const bytes = tarGz([{ name: "mirror", body: BINARY, magic: "" }]);
		const { dir, path } = archiveFile(bytes);
		await assert.rejects(
			extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
			refusal("ARCHIVE_UNSUPPORTED"),
		);
	});

	it("refuses a GNU-magic header, where tar reads no name prefix", async () => {
		const bytes = tarGz([
			{ name: "mirror", body: BINARY },
			{ name: "mirror", prefix: "zz", body: SMUGGLED, magic: "ustar  " },
		]);
		const { dir, path } = archiveFile(bytes);
		const dest = join(dir, "out");
		await assert.rejects(
			extractMember(path, "mirror", dest, sha256Hex(bytes)),
			refusal("ARCHIVE_UNSUPPORTED"),
		);
		assert.equal(existsSync(dest), false);
	});

	it("refuses a member over the size cap before reading its data", async () => {
		const bytes = tarGz([
			{ name: "mirror", claimedSize: MAX_MEMBER_BYTES + 1 },
		]);
		const { dir, path } = archiveFile(bytes);
		await assert.rejects(
			extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
			refusal("SIZE_EXCEEDED"),
		);
		assert.deepEqual(readdirSync(dir), ["a.tar.gz"]);
	});
});

describe("member names", () => {
	it("names an entry in a refusal by its UTF-8 code points, every one outside printable ASCII escaped", async () => {
		const utf8 = (name: string): string =>
			Buffer.from(name, "utf8").toString("latin1");
		for (const [name, shown] of [
			[utf8("caf\u00e9/../x"), '"caf\\u{00E9}/../x"'],
			[utf8("\u202emirror/../x"), '"\\u{202E}mirror/../x"'],
			[utf8("a\u00a0b/../x"), '"a\\u{00A0}b/../x"'],
			// Two Hangul fillers: letters that draw nothing.
			[utf8("\u3164\u3164/../x"), '"\\u{3164}\\u{3164}/../x"'],
			[utf8("mirror\ufe0f/../x"), '"mirror\\u{FE0F}/../x"'],
			[utf8("\ud83d\ude00/../x"), '"\\u{1F600}/../x"'],
			['say "hi"\\/../x', '"say \\"hi\\"\\\\/../x"'],
			["\xff/../x", '"\\xff/../x"'],
		] as const) {
			const bytes = tarGz([
				{ name: "mirror", body: BINARY },
				{ name, body: "x" },
			]);
			const { dir, path } = archiveFile(bytes);
			await assert.rejects(
				extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
				(error: Error) =>
					refusal("ARCHIVE_UNSAFE")(error) && error.message.includes(shown),
				shown,
			);
		}
	});

	it("refuses a second copy of the member spelled another way", async () => {
		for (const second of [".//mirror", "./mirror", "./mirror/", "mirror/"]) {
			const bytes = tarGz([
				{ name: "mirror", body: BINARY },
				{ name: second, body: SMUGGLED },
			]);
			const { dir, path } = archiveFile(bytes);
			await assert.rejects(
				extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
				refusal("ARCHIVE_UNSAFE"),
				second,
			);
		}
	});

	it("refuses a member written as ./mirror or .//bin//mirror, which tar does not find by the plain name", async () => {
		for (const [name, member] of [
			["./mirror", "mirror"],
			[".//bin//mirror", "bin/mirror"],
		] as const) {
			const bytes = tarGz([{ name, body: BINARY }]);
			const { dir, path } = archiveFile(bytes);
			await assert.rejects(
				extractMember(path, member, join(dir, "out"), sha256Hex(bytes)),
				refusal("ARCHIVE_UNSAFE"),
				name,
			);
		}
	});
});

describe("names that are one file on macOS or Windows", () => {
	const utf8 = (name: string): string =>
		Buffer.from(name, "utf8").toString("latin1");

	it("refuses two entries whose names are equal once case-folded and put in NFC", async () => {
		const cases: [string, string, readonly TarEntry[]][] = [
			[
				"mirror and MIRROR",
				"mirror",
				[
					{ name: "mirror", body: BINARY },
					{ name: "MIRROR", body: SMUGGLED },
				],
			],
			[
				"bin/mirror and BIN/mirror",
				"bin/mirror",
				[
					{ name: "bin/mirror", body: BINARY },
					{ name: "BIN/mirror", body: SMUGGLED },
				],
			],
			[
				"café in NFC and in NFD",
				"mirror",
				[
					{ name: "mirror", body: BINARY },
					{ name: utf8("caf\u00e9"), body: "a" },
					{ name: utf8("cafe\u0301"), body: "b" },
				],
			],
			[
				"Straße and STRASSE",
				"mirror",
				[
					{ name: "mirror", body: BINARY },
					{ name: utf8("Stra\u00dfe"), body: "a" },
					{ name: "STRASSE", body: "b" },
				],
			],
			[
				"LICENSE twice",
				"mirror",
				[
					{ name: "LICENSE", body: "MIT" },
					{ name: "mirror", body: BINARY },
					{ name: "LICENSE", body: "MIT" },
				],
			],
		];
		for (const [what, member, entries] of cases) {
			const bytes = tarGz(entries);
			const { dir, path } = archiveFile(bytes);
			const dest = join(dir, "out");
			await assert.rejects(
				extractMember(path, member, dest, sha256Hex(bytes)),
				refusal("ARCHIVE_UNSAFE"),
				what,
			);
			assert.equal(existsSync(dest), false, what);
		}
	});

	it("reads at most 10000 entries: each name is kept to compare", async () => {
		const many = (count: number): TarEntry[] => [
			{ name: "mirror", body: BINARY },
			...Array.from({ length: count - 1 }, (_, i) => ({
				name: `d/${i}`,
				type: "5",
			})),
		];
		const atLimit = tarGz(many(10_000));
		const ok = archiveFile(atLimit);
		await extractMember(
			ok.path,
			"mirror",
			join(ok.dir, "out"),
			sha256Hex(atLimit),
		);
		assert.deepEqual(readFileSync(join(ok.dir, "out")), BINARY);

		const over = tarGz(many(10_001));
		const { dir, path } = archiveFile(over);
		await assert.rejects(
			extractMember(path, "mirror", join(dir, "out"), sha256Hex(over)),
			refusal("ARCHIVE_UNSUPPORTED"),
		);
		assert.deepEqual(readdirSync(dir), ["a.tar.gz"]);
	});
});

describe("the end of the archive", () => {
	it("ignores entries after the two end blocks, as tar does", async () => {
		const bytes = tarGz(
			[{ name: "mirror", body: BINARY }],
			[{ name: "mirror", body: SMUGGLED }],
		);
		const { dir, path } = archiveFile(bytes);
		await extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes));
		assert.deepEqual(readFileSync(join(dir, "out")), BINARY);
	});

	/** A megabyte that does not compress. */
	function incompressible(): Buffer {
		const filler: Buffer[] = [];
		let seed = Buffer.from("filler");
		for (let i = 0; i < 1024 * 32; i += 1) {
			seed = createHash("sha256").update(seed).digest();
			filler.push(seed);
		}
		return Buffer.concat(filler);
	}

	it("reads the gzip stream to its end: a megabyte past the end blocks is inflated, checked and hashed", async () => {
		const bytes = tarGz(
			[{ name: "mirror", body: BINARY }],
			[{ name: "after", body: incompressible() }],
		);
		const { dir, path } = archiveFile(bytes);
		await extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes));
		assert.deepEqual(readFileSync(join(dir, "out")), BINARY);
		assert.deepEqual(await memberDigest(path, "mirror"), {
			archive: sha256Hex(bytes),
			member: sha256Hex(BINARY),
		});
	});

	it("refuses a corrupt gzip trailer however far past the end blocks it is, as gzip under tar exits 2 on it", async () => {
		for (const after of [[], [{ name: "after", body: incompressible() }]]) {
			const bytes = Buffer.from(
				tarGz([{ name: "mirror", body: BINARY }], after),
			);
			const crc = bytes.length - 8;
			bytes[crc] = (bytes[crc] ?? 0) ^ 0xff;
			assert.throws(() => gunzipSync(bytes), /incorrect data check/u);
			const { dir, path } = archiveFile(bytes);
			await assert.rejects(
				extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
				refusal("ARCHIVE_MALFORMED"),
				`${after.length} entries after the end blocks`,
			);
			assert.deepEqual(readdirSync(dir), ["a.tar.gz"]);
		}
	});

	it("refuses bytes after the gzip stream, zeros included, and a stream with no trailer", async () => {
		const good = tarGz([{ name: "mirror", body: BINARY }]);
		for (const [what, bytes] of [
			["garbage", Buffer.concat([good, Buffer.from("garbage!")])],
			["zeros", Buffer.concat([good, Buffer.alloc(8)])],
			[
				"zeros, then a second member",
				Buffer.concat([good, Buffer.alloc(8), good]),
			],
			["no trailer", good.subarray(0, good.length - 8)],
		] as const) {
			const { dir, path } = archiveFile(bytes);
			await assert.rejects(
				extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
				refusal("ARCHIVE_MALFORMED"),
				what,
			);
		}
	});

	it("refuses an archive that inflates more skipped data than 32 times its size plus 1 MiB", async () => {
		// Eight MiB of zeros compress to a few KiB: as another entry's data, and after the end blocks.
		const zeros = Buffer.alloc(8 * 1024 ** 2);
		for (const bytes of [
			tarGz([
				{ name: "padding", body: zeros },
				{ name: "mirror", body: BINARY },
			]),
			tarGz(
				[{ name: "mirror", body: BINARY }],
				[{ name: "after", body: zeros }],
			),
		]) {
			assert.ok(bytes.length * 32 + 1024 ** 2 < zeros.length);
			const { dir, path } = archiveFile(bytes);
			await assert.rejects(
				extractMember(path, "mirror", join(dir, "out"), sha256Hex(bytes)),
				refusal("ARCHIVE_UNSUPPORTED"),
			);
			assert.deepEqual(readdirSync(dir), ["a.tar.gz"]);
		}
	});
});

describe("the archive the bytes come from", () => {
	it("refuses to keep anything unless the bytes read hash to the pin", async () => {
		const bytes = tarGz([{ name: "mirror", body: BINARY }]);
		const { dir, path } = archiveFile(bytes);
		const dest = join(dir, "out");
		await assert.rejects(
			extractMember(path, "mirror", dest, "0".repeat(64)),
			refusal("DIGEST_MISMATCH"),
		);
		assert.deepEqual(readdirSync(dir), ["a.tar.gz"]);
	});

	it("a missing archive or a directory is a refusal, not a crash, and leaves no partial file", async () => {
		const dir = scratch("archive-unreadable");
		for (const archive of [join(dir, "absent.tar.gz"), dir]) {
			await assert.rejects(
				extractMember(archive, "mirror", join(dir, "out"), "0".repeat(64)),
				refusal("ARCHIVE_UNREADABLE"),
				archive,
			);
		}
		assert.deepEqual(readdirSync(dir), []);
	});
});
