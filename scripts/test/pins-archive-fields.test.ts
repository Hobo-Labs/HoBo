/**
 * Every numeric field of a ustar header, with every byte value at three
 * places in it, held to the system `tar`. Each archive is a GOOD `mirror`,
 * then a header `pad` that claims 1024 bytes and carries the byte under test,
 * then an EVIL `mirror` in exactly those 1024 bytes. Where both read `pad`'s
 * fields alike, the EVIL copy is `pad`'s data and only GOOD is extracted;
 * where `tar` cannot read a field it skips `pad` and extracts EVIL, and where
 * it reads a field the reader does not, the two disagree some other way.
 *
 * The reader must refuse every such archive or name the bytes both extracts
 * leave. `tar` runs only on the archives the reader accepts, which keeps
 * 6,144 cases fast.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";

import { PinsError } from "../lib/pins.ts";
import { TarScan } from "../lib/pins-tar.ts";

import { scratch } from "./support/pins-support.ts";
import {
	accepted,
	allDisagreements,
	EVIL,
	GOOD,
	label,
	noGnuTar,
	readerSays,
} from "./support/tar-diff.ts";
import { type TarEntry, tarGz } from "./support/tar-support.ts";

/** The numeric fields, where they are, and the value `pad` gives each. */
const FIELDS = [
	{ field: "mode", at: 100, length: 8, value: 0o755 },
	{ field: "uid", at: 108, length: 8, value: 0 },
	{ field: "gid", at: 116, length: 8, value: 0 },
	{ field: "size", at: 124, length: 12, value: 1024 },
	{ field: "mtime", at: 136, length: 12, value: 0 },
	{ field: "checksum", at: 148, length: 8, value: 0 },
	{ field: "devmajor", at: 329, length: 8, value: 0 },
	{ field: "devminor", at: 337, length: 8, value: 0 },
] as const;

/** Where the byte goes: before the digits, right after them, or the field's last byte. */
const PLACES = ["first", "after the digits", "last"] as const;
type Place = (typeof PLACES)[number];

const octalDigits = (value: number, width: number): string =>
	value.toString(8).padStart(width, "0");

/** The field's text with `byte` at `place`; the checksum's sum is only known once the header is built. */
function fieldText(
	length: number,
	value: number,
	place: Place,
	byte: string,
): string {
	if (place === "first") return `${byte}${octalDigits(value, length - 2)}\0`;
	if (place === "after the digits") {
		return `${octalDigits(value, length - 2)}${byte}\0`;
	}
	return `${octalDigits(value, length - 1)}${byte}`;
}

function checksumText(sum: number, place: Place, byte: string): string {
	const digits = octalDigits(sum, 6);
	if (place === "first") return `${byte}${digits}\0`;
	if (place === "after the digits") return `${digits}${byte} `;
	return `${digits}\0${byte}`;
}

interface FieldCase {
	readonly what: string;
	readonly byte: number;
	readonly place: Place;
	readonly bytes: Buffer;
}

function* fieldCases(): Generator<FieldCase> {
	for (const { field, at, length, value } of FIELDS) {
		for (const place of PLACES) {
			for (let byte = 0; byte <= 0xff; byte += 1) {
				const char = String.fromCharCode(byte);
				const pad: TarEntry =
					field === "checksum"
						? {
								name: "pad",
								claimedSize: 1024,
								checksum: (sum) => checksumText(sum, place, char),
							}
						: {
								name: "pad",
								claimedSize: 1024,
								raw: [[at, fieldText(length, value, place, char)]],
							};
				yield {
					what: `${field}, byte 0x${byte.toString(16).padStart(2, "0")} ${place}`,
					byte,
					place,
					bytes: tarGz([
						{ name: "mirror", body: GOOD },
						pad,
						{ name: "mirror", body: EVIL },
					]),
				};
			}
		}
	}
}

/**
 * The reader's answer for each case. The scan alone is run first, in memory;
 * only an archive it accepts is written out and read the whole way, through
 * gunzip and the file, as a pin reads it.
 */
async function readAll(): Promise<readonly Read[]> {
	const dir = scratch("tar-fields");
	const read: Read[] = [];
	let index = 0;
	for (const crafted of fieldCases()) {
		index += 1;
		const scanned = scanOnly(crafted.bytes);
		if (scanned !== undefined) {
			read.push({ crafted, path: "", answer: scanned });
			continue;
		}
		const path = join(dir, `${index}.tar.gz`);
		writeFileSync(path, crafted.bytes);
		read.push({ crafted, path, answer: await readerSays(path, "mirror") });
	}
	return read;
}

interface Read {
	readonly crafted: FieldCase;
	readonly path: string;
	readonly answer: string;
}

/** The code the scan refuses `bytes` with, or `undefined` when it reads them. */
function scanOnly(bytes: Buffer): string | undefined {
	try {
		const scan = new TarScan("case", "mirror", () => undefined);
		scan.push(gunzipSync(bytes));
		scan.finish();
		return undefined;
	} catch (error) {
		if (error instanceof PinsError) return error.code;
		throw error;
	}
}

/** Both tests read the same cases; they are read once. */
let reading: Promise<readonly Read[]> | undefined;
const readOnce = (): Promise<readonly Read[]> => {
	reading ??= readAll();
	return reading;
};

/** A byte the one numeric form allows at `place`: an octal digit, a space, or a NUL after the first byte. */
function allowed(byte: number, place: Place): boolean {
	if (byte >= 0x30 && byte <= 0x37) return true;
	if (byte === 0x20) return true;
	return byte === 0 && place !== "first";
}

describe("every numeric field, every byte, three places", () => {
	it("the reader never names EVIL, and refuses every byte the one numeric form does not allow", async (t) => {
		const read = await readOnce();
		assert.equal(read.length, FIELDS.length * PLACES.length * 256);
		const wrong = read
			.filter(
				({ crafted, answer }) =>
					label(answer) === "EVIL" ||
					(accepted(answer) && !allowed(crafted.byte, crafted.place)),
			)
			.map(({ crafted, answer }) => `${crafted.what}: ${label(answer)}`);
		assert.deepEqual(wrong, []);
		t.diagnostic(
			`${read.length} cases, ${read.filter(({ answer }) => accepted(answer)).length} accepted`,
		);
	});

	it("the reader refuses each, or names the bytes tar leaves at the member, extracting all or only the member", {
		skip: noGnuTar,
	}, async (t) => {
		const read = await readOnce();
		const compared = read.filter(({ answer }) => accepted(answer));
		const found = await allDisagreements(
			compared.map(({ crafted, path, answer }) => ({
				what: crafted.what,
				path,
				member: "mirror",
				answer,
			})),
		);
		assert.deepEqual(found, []);
		t.diagnostic(
			`${read.length} cases; the reader accepted ${compared.length}, and tar agreed on each, extracting all and only the member`,
		);
	});
});
