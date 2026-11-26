/**
 * The archive reader against the system `tar`, on archives crafted byte by
 * byte. Whatever the reader accepts, it must name exactly the bytes `tar -xzf`
 * leaves at the member's path, both when `tar` extracts the whole archive and
 * when it extracts only that member by name; anything else it must refuse.
 *
 * Each case also says what the reader answers, so the reader is pinned on a
 * machine without `tar`; only the comparison with `tar` needs one.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import { scratch } from "./support/pins-support.ts";
import {
	accepted,
	allDisagreements,
	EVIL,
	GOOD,
	gnuTarMissing,
	label,
	noGnuTar,
	readerSays,
} from "./support/tar-diff.ts";
import { type TarEntry, tarGz, tarStream } from "./support/tar-support.ts";

/** GNU tar's magic and version, `ustar  \0`. */
const GNU = "ustar  ";
/** A header's sum as the checksum field writes it: six octal digits. */
const oct6 = (sum: number): string => sum.toString(8).padStart(6, "0");
/** NBSP, U+00A0, the byte 0xA0: a JavaScript `trim` strips it, C's `isspace` does not. */
const NBSP = "\u00a0";
/** A name as UTF-8 bytes, in the latin1 string the builder writes byte for byte. */
const utf8 = (name: string): string =>
	Buffer.from(name, "utf8").toString("latin1");

interface Case {
	readonly what: string;
	readonly entries: readonly TarEntry[];
	/** Entries after the two end blocks. */
	readonly after?: readonly TarEntry[];
	/** The member the pin names; `mirror` unless given. */
	readonly member?: string;
	/** What is done to the gzip bytes `entries` make, when the case is about gzip. */
	readonly gzip?: (archive: Buffer) => Buffer;
	/** `GOOD` when the reader names GOOD's bytes, else the code it refuses with. */
	readonly reader: string;
}

const CASES: readonly Case[] = [
	{
		what: "mirror's own layout: LICENSE, then mirror",
		entries: [
			{ name: "LICENSE", body: "MIT\n" },
			{ name: "mirror", body: GOOD },
		],
		reader: "GOOD",
	},
	{
		what: "a nested member after its directory",
		entries: [
			{ name: "bin/", type: "5" },
			{ name: "bin/mirror", body: GOOD },
		],
		member: "bin/mirror",
		reader: "GOOD",
	},
	{
		what: "a nested member before its directory",
		entries: [
			{ name: "bin/mirror", body: GOOD },
			{ name: "bin/", type: "5" },
		],
		member: "bin/mirror",
		reader: "GOOD",
	},
	{
		what: "a nested member named through the ustar prefix",
		entries: [{ name: "mirror", prefix: "bin", body: GOOD }],
		member: "bin/mirror",
		reader: "GOOD",
	},
	{
		what: "a second mirror after the end blocks",
		entries: [{ name: "mirror", body: GOOD }],
		after: [{ name: "mirror", body: EVIL }],
		reader: "GOOD",
	},
	{
		what: "POSIX magic with an odd version, named through the prefix",
		entries: [
			{ name: "mirror", prefix: "bin", magic: "ustar\0XX", body: GOOD },
		],
		member: "bin/mirror",
		reader: "GOOD",
	},
	// GNU headers. Bytes 345 to 500 hold times there, and tar reads no prefix.
	{
		what: "mirror, then a GNU-magic mirror with zz where a prefix would be",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: "mirror", prefix: "zz", magic: GNU, body: EVIL },
		],
		reader: "ARCHIVE_UNSUPPORTED",
	},
	{
		what: "a lone GNU-magic mirror with zz where a prefix would be",
		entries: [{ name: "mirror", prefix: "zz", magic: GNU, body: EVIL }],
		reader: "ARCHIVE_UNSUPPORTED",
	},
	{
		what: "a GNU-magic mirror",
		entries: [{ name: "mirror", magic: GNU, body: GOOD }],
		reader: "ARCHIVE_UNSUPPORTED",
	},
	{
		what: "GNU magic with its version zeroed, which tar reads as v7",
		entries: [{ name: "mirror", magic: "ustar ", body: GOOD }],
		reader: "ARCHIVE_UNSUPPORTED",
	},
	// A regular file whose name ends in "/": tar makes a directory of it.
	{
		what: "a lone regular file named mirror/",
		entries: [{ name: "mirror/", body: EVIL }],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "a lone old-style (type NUL) file named mirror/",
		entries: [{ name: "mirror/", type: "\0", body: EVIL }],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "a regular file named mirror/ through the prefix",
		entries: [{ name: "", prefix: "mirror", body: EVIL }],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "a regular file named bin/, then bin/mirror",
		entries: [
			{ name: "bin/", body: EVIL },
			{ name: "bin/mirror", body: GOOD },
		],
		member: "bin/mirror",
		reader: "ARCHIVE_UNSAFE",
	},
	// Names tar extracts somewhere other than as written, or not at all.
	{
		what: "mirror, then /mirror",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: "/mirror", body: EVIL },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "a lone /mirror",
		entries: [{ name: "/mirror", body: GOOD }],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "evil, mirror, then a hard link /mirror to evil",
		entries: [
			{ name: "evil", body: EVIL },
			{ name: "mirror", body: GOOD },
			{ name: "/mirror", type: "1", linkname: "evil" },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "mirror, then ../mirror",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: "../mirror", body: EVIL },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "mirror, then a/../mirror",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: "a/../mirror", body: EVIL },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "bin/, bin/mirror, then bin/./mirror",
		entries: [
			{ name: "bin/", type: "5" },
			{ name: "bin/mirror", body: GOOD },
			{ name: "bin/./mirror", body: EVIL },
		],
		member: "bin/mirror",
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "a lone ./mirror, which tar -xzf A mirror does not find",
		entries: [{ name: "./mirror", body: GOOD }],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "a lone .//bin//mirror, which tar -xzf A bin/mirror does not find",
		entries: [{ name: ".//bin//mirror", body: GOOD }],
		member: "bin/mirror",
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "the prefix bin/ before mirror, stored as bin//mirror",
		entries: [{ name: "mirror", prefix: "bin/", body: GOOD }],
		member: "bin/mirror",
		reader: "ARCHIVE_UNSAFE",
	},
	// Links, anywhere: each can put other bytes at the member's path.
	{
		what: "d -> ., mirror, then d/mirror",
		entries: [
			{ name: "d", type: "2", linkname: "." },
			{ name: "mirror", body: GOOD },
			{ name: "d/mirror", body: EVIL },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "real/, bin -> real, bin/mirror, then real/mirror",
		entries: [
			{ name: "real/", type: "5" },
			{ name: "bin", type: "2", linkname: "real" },
			{ name: "bin/mirror", body: GOOD },
			{ name: "real/mirror", body: EVIL },
		],
		member: "bin/mirror",
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "mirror, then a hard link to it",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: "other", type: "1", linkname: "mirror" },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "mirror, and a symbolic link beside it",
		entries: [
			{ name: "LICENSE", body: "MIT\n" },
			{ name: "mirror", body: GOOD },
			{ name: "COPYING", type: "2", linkname: "LICENSE" },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	// The member's path in the tree: nothing under it, only directories above it.
	{
		what: "mirror/x, then mirror",
		entries: [
			{ name: "mirror/x", body: EVIL },
			{ name: "mirror", body: GOOD },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "mirror, then a directory mirror/sub/",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: "mirror/sub/", type: "5" },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "a regular file bin, then bin/mirror",
		entries: [
			{ name: "bin", body: EVIL },
			{ name: "bin/mirror", body: GOOD },
		],
		member: "bin/mirror",
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "bin/mirror, then a regular file bin",
		entries: [
			{ name: "bin/mirror", body: GOOD },
			{ name: "bin", body: EVIL },
		],
		member: "bin/mirror",
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "a FIFO bin, then bin/mirror",
		entries: [
			{ name: "bin", type: "6" },
			{ name: "bin/mirror", body: GOOD },
		],
		member: "bin/mirror",
		reader: "ARCHIVE_UNSAFE",
	},
	// NBSP in a numeric field. tar cannot read the field, so it skips that
	// header and reads the block after it as the next header.
	{
		what: "mirror, a header with NBSP before its checksum, a hidden mirror",
		entries: [
			{ name: "mirror", body: GOOD },
			{
				name: "pad",
				claimedSize: 1024,
				checksum: (sum) => `${NBSP}${oct6(sum)}\0`,
			},
			{ name: "mirror", body: EVIL },
		],
		reader: "ARCHIVE_MALFORMED",
	},
	{
		what: "mirror, a header with NBSP after its checksum, a hidden mirror",
		entries: [
			{ name: "mirror", body: GOOD },
			{
				name: "pad",
				claimedSize: 1024,
				checksum: (sum) => `${oct6(sum)}${NBSP} `,
			},
			{ name: "mirror", body: EVIL },
		],
		reader: "ARCHIVE_MALFORMED",
	},
	{
		what: "mirror, a header with NBSP before its size, a hidden mirror",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: "pad", claimedSize: 1024, raw: [[124, `${NBSP}0000002000\0`]] },
			{ name: "mirror", body: EVIL },
		],
		reader: "ARCHIVE_MALFORMED",
	},
	{
		what: "mirror, a header with NBSP after its size, a hidden mirror",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: "pad", claimedSize: 1024, raw: [[124, `0000002000${NBSP}\0`]] },
			{ name: "mirror", body: EVIL },
		],
		reader: "ARCHIVE_MALFORMED",
	},
	{
		what: "LICENSE, a header with NBSP before its size, a hidden mirror only tar sees",
		entries: [
			{ name: "LICENSE", body: "MIT\n" },
			{ name: "pad", claimedSize: 1024, raw: [[124, `${NBSP}0000002000\0`]] },
			{ name: "mirror", body: EVIL },
		],
		reader: "ARCHIVE_MALFORMED",
	},
	{
		what: "a mirror whose size has NBSP before it, which tar cannot read at all",
		entries: [
			{ name: "mirror", body: GOOD, raw: [[124, `${NBSP}0000000024\0`]] },
		],
		reader: "ARCHIVE_MALFORMED",
	},
	{
		what: "bin/mirror, then bin\\mirror, which tar on Windows reads as bin/mirror",
		entries: [
			{ name: "bin/mirror", body: GOOD },
			{ name: "bin\\mirror", body: EVIL },
		],
		member: "bin/mirror",
		reader: "ARCHIVE_UNSAFE",
	},
	// The gzip stream: read to its end and checked, as gzip under tar checks it.
	{
		what: "two gzip members, LICENSE in the first and mirror in the second",
		entries: [],
		gzip: () =>
			Buffer.concat([
				gzipSync(tarStream([{ name: "LICENSE", body: "MIT\n" }])),
				gzipSync(
					Buffer.concat([
						tarStream([{ name: "mirror", body: GOOD }]),
						Buffer.alloc(1024),
					]),
				),
			]),
		reader: "GOOD",
	},
	{
		what: "a gzip stream with no trailer",
		entries: [{ name: "mirror", body: GOOD }],
		gzip: (archive) => archive.subarray(0, archive.length - 8),
		reader: "ARCHIVE_MALFORMED",
	},
	{
		what: "a gzip stream whose CRC is wrong",
		entries: [{ name: "mirror", body: GOOD }],
		gzip: (archive) => {
			const bytes = Buffer.from(archive);
			bytes[bytes.length - 8] = (bytes[bytes.length - 8] ?? 0) ^ 0xff;
			return bytes;
		},
		reader: "ARCHIVE_MALFORMED",
	},
	{
		what: "garbage after the gzip stream",
		entries: [{ name: "mirror", body: GOOD }],
		gzip: (archive) => Buffer.concat([archive, Buffer.from("garbage!")]),
		reader: "ARCHIVE_MALFORMED",
	},
	{
		what: "zeros after the gzip stream, which gzip ignores",
		entries: [{ name: "mirror", body: GOOD }],
		gzip: (archive) => Buffer.concat([archive, Buffer.alloc(8)]),
		reader: "ARCHIVE_MALFORMED",
	},
	// Names one file to a case-insensitive file system (macOS, Windows).
	{
		what: "mirror, then MIRROR",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: "MIRROR", body: EVIL },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "bin/mirror, then BIN/mirror",
		entries: [
			{ name: "bin/mirror", body: GOOD },
			{ name: "BIN/mirror", body: EVIL },
		],
		member: "bin/mirror",
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "mirror, and café in NFC and in NFD",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: utf8("caf\u00e9"), body: "a" },
			{ name: utf8("cafe\u0301"), body: "b" },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "ssh, then \u1e9eH (capital sharp s), one file under full case folding",
		entries: [
			{ name: "ssh", body: GOOD },
			{ name: utf8("\u1e9eH"), body: EVIL },
		],
		member: "ssh",
		reader: "ARCHIVE_UNSAFE",
	},
	// Default-ignorable code points, which HFS+ and some Linux casefold kernels drop.
	{
		what: "mirror, then mi\u200drror (a zero-width joiner)",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: utf8("mi\u200drror"), body: EVIL },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "mirror, then \ufeffmirror (a byte order mark)",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: utf8("\ufeffmirror"), body: EVIL },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "mirror, and a file named with a variation selector",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: utf8("x\ufe0f"), body: "x" },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "mirror, then Ss\u0345\u0307 and ss\u1fbe\u0307, one name to NTFS though NFC orders them apart",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: utf8("Ss\u0345\u0307"), body: "a" },
			{ name: utf8("ss\u1fbe\u0307"), body: "b" },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "MIRROR/x, then mirror",
		entries: [
			{ name: "MIRROR/x", body: EVIL },
			{ name: "mirror", body: GOOD },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "a regular file BIN, then bin/mirror",
		entries: [
			{ name: "BIN", body: EVIL },
			{ name: "bin/mirror", body: GOOD },
		],
		member: "bin/mirror",
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "mirror, and LICENSE twice",
		entries: [
			{ name: "LICENSE", body: "MIT\n" },
			{ name: "mirror", body: GOOD },
			{ name: "LICENSE", body: "MIT\n" },
		],
		reader: "ARCHIVE_UNSAFE",
	},
	{
		what: "mirror, and a FIFO and a directory beside it",
		entries: [
			{ name: "mirror", body: GOOD },
			{ name: "pipe", type: "6" },
			{ name: "share/", type: "5" },
		],
		reader: "GOOD",
	},
];

function archiveOf(crafted: Case): string {
	const path = join(scratch("tar-diff"), "a.tar.gz");
	const archive = tarGz(crafted.entries, crafted.after);
	writeFileSync(path, crafted.gzip?.(archive) ?? archive);
	return path;
}

describe("crafted archives, as the reader reads them", () => {
	for (const crafted of CASES) {
		it(`${crafted.what}: ${crafted.reader === "GOOD" ? "names GOOD" : `refused, ${crafted.reader}`}`, async () => {
			const answer = await readerSays(
				archiveOf(crafted),
				crafted.member ?? "mirror",
			);
			assert.equal(label(answer), crafted.reader);
		});
	}
});

describe("crafted archives, against the system tar", () => {
	it("the reader refuses each, or names the bytes tar leaves at the member, extracting all or only the member", {
		skip: noGnuTar,
	}, async () => {
		const compared = [];
		for (const crafted of CASES) {
			const path = archiveOf(crafted);
			const member = crafted.member ?? "mirror";
			const answer = await readerSays(path, member);
			if (accepted(answer)) {
				compared.push({ what: crafted.what, path, member, answer });
			}
		}
		assert.deepEqual(await allDisagreements(compared), []);
	});
});

describe("the tar the comparisons run against", () => {
	/** A directory holding only a `tar` that prints `banner` for any arguments and exits 0. */
	function fakeTar(banner: string): string {
		const dir = scratch("fake-tar");
		writeFileSync(join(dir, "tar"), `#!/bin/sh\necho '${banner}'\nexit 0\n`, {
			mode: 0o755,
		});
		return dir;
	}

	it("is GNU tar only: a bsdtar on PATH skips the comparisons, naming its banner", () => {
		const reason = gnuTarMissing({
			PATH: fakeTar("bsdtar 3.7.2 - libarchive 3.7.2 zlib/1.2.13"),
		});
		assert.match(
			String(reason),
			/^the tar on PATH is not GNU tar \(it says "bsdtar 3\.7\.2 - libarchive/u,
		);
	});

	it("says so when there is no tar at all", () => {
		assert.match(
			String(gnuTarMissing({ PATH: scratch("no-tar") })),
			/^no `tar` on PATH/u,
		);
	});

	it("runs the comparisons when the tar on PATH says it is GNU tar", () => {
		assert.equal(gnuTarMissing({ PATH: fakeTar("tar (GNU tar) 1.35") }), false);
	});
});
