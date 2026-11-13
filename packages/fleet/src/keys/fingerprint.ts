// Four fingerprint words of a key (design §6.5): the first 44 bits of the
// RFC 7638 thumbprint, read as four 11-bit indexes into the BIP-39 English list.
import { BIP39_ENGLISH } from "./bip39-english.js";

const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/u;
const BITS_PER_WORD = 11;

export function wordsOf(
	thumbprint: string,
): readonly [string, string, string, string] {
	if (!THUMBPRINT.test(thumbprint))
		throw new Error("a thumbprint is 43 base64url characters (SHA-256)");
	const bytes = Buffer.from(thumbprint, "base64url");
	// The first 6 bytes hold the 44 bits; 48 bits fit a double exactly.
	const head = bytes.readUIntBE(0, 6);
	const top = Math.floor(head / 2 ** 4); // drop the low 4 bits: 44 remain
	const word = (i: number): string => {
		const shift = BITS_PER_WORD * (3 - i);
		const index = Math.floor(top / 2 ** shift) % 2 ** BITS_PER_WORD;
		const found = BIP39_ENGLISH[index];
		if (found === undefined) throw new Error("word index out of range");
		return found;
	};
	return Object.freeze([word(0), word(1), word(2), word(3)] as const);
}
