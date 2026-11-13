import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BIP39_ENGLISH } from "../../src/keys/bip39-english.js";
import { fingerprintWords } from "../../src/keys/index.js";

// SHA-256 of bitcoin/bips bip-0039/english.txt (one word per line, trailing newline).
const BIP39_ENGLISH_SHA256 =
	"2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda";

function thumbprintOfBytes(head: readonly number[]): string {
	const bytes = Buffer.alloc(32);
	Buffer.from(head).copy(bytes);
	return bytes.toString("base64url");
}

describe("fingerprintWords", () => {
	it("vendors the BIP-39 English list verbatim", () => {
		expect(BIP39_ENGLISH.length).toBe(2048);
		expect(
			createHash("sha256")
				.update(`${BIP39_ENGLISH.join("\n")}\n`)
				.digest("hex"),
		).toBe(BIP39_ENGLISH_SHA256);
	});

	it("reads the first 44 bits as four 11-bit indexes", () => {
		expect(fingerprintWords(thumbprintOfBytes([0, 0, 0, 0, 0, 0]))).toEqual([
			"abandon",
			"abandon",
			"abandon",
			"abandon",
		]);
		// 44 one-bits, then zeros: index 2047 four times ("zoo").
		expect(
			fingerprintWords(thumbprintOfBytes([255, 255, 255, 255, 255, 0xf0])),
		).toEqual(["zoo", "zoo", "zoo", "zoo"]);
		// Bits after the 44th do not count.
		expect(
			fingerprintWords(thumbprintOfBytes([0, 0, 0, 0, 0, 0x0f, 255])),
		).toEqual(["abandon", "abandon", "abandon", "abandon"]);
		// Indexes 1, 2, 3, 4: 00000000001 00000000010 00000000011 00000000100, then 4 ignored bits.
		expect(
			fingerprintWords(thumbprintOfBytes([0x00, 0x20, 0x08, 0x01, 0x80, 0x40])),
		).toEqual(["ability", "able", "about", "above"]);
	});

	it("refuses a string that is not a SHA-256 thumbprint", () => {
		expect(() => fingerprintWords("short")).toThrow();
		expect(() => fingerprintWords(`${"A".repeat(42)}=`)).toThrow();
	});
});
