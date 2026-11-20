import {
	constants,
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	generateKeyPairSync,
	hkdfSync,
	privateDecrypt,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

import { EFF_LONG_WORDLIST } from "./eff-long-wordlist.js";

/**
 * The few pieces of Bitwarden's client-side cryptography that provisioning a
 * Secrets Manager access token needs, on Node's own `crypto`: Bitwarden
 * encrypts names and keys in the client, so the server never sees them.
 *
 * - EncString type 2 (AES-256-CBC with HMAC-SHA256): `2.<iv>|<data>|<mac>`.
 * - EncString types 3, 4 and 6 (RSA-2048 OAEP): how a device hands its user
 *   key to a sign-in request, and how an organization key is shared with a
 *   member.
 * - The access token's key: HKDF-SHA256 over a 16-byte seed, salt
 *   `bitwarden-accesstoken`, info `sm-access-token` (the SDK's
 *   `derive_shareable_key`).
 * - The fingerprint phrase a device shows before approving a sign-in request.
 *
 * Keys are `Buffer`s the caller zeroes (`wipe`) when it is done with them.
 */

export class BitwardenCryptoError extends Error {
	readonly code = "HOBO_BITWARDEN_CRYPTO";
	constructor(message: string) {
		super(message);
		this.name = "BitwardenCryptoError";
	}
}

/** A 64-byte AES-256-CBC + HMAC-SHA256 key: encryption half, then MAC half. */
export function symmetricKey(bytes: Buffer): Buffer {
	if (bytes.length !== 64)
		throw new BitwardenCryptoError(
			`Expected a 64-byte Bitwarden key, got ${bytes.length} bytes.`,
		);
	return bytes;
}

export function encryptEncString(plain: Buffer | string, key: Buffer): string {
	const k = symmetricKey(key);
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-256-cbc", k.subarray(0, 32), iv);
	const data = Buffer.concat([
		cipher.update(Buffer.from(plain)),
		cipher.final(),
	]);
	const mac = createHmac("sha256", k.subarray(32))
		.update(Buffer.concat([iv, data]))
		.digest();
	return `2.${iv.toString("base64")}|${data.toString("base64")}|${mac.toString("base64")}`;
}

export function decryptEncString(text: string, key: Buffer): Buffer {
	const k = symmetricKey(key);
	const match = /^2\.([^|]+)\|([^|]+)\|([^|]+)$/u.exec(text);
	if (match === null)
		throw new BitwardenCryptoError(
			"Only type 2 (AES-256-CBC, HMAC-SHA256) encrypted values are supported; this account may use Bitwarden's newer key format.",
		);
	const [, ivB64 = "", dataB64 = "", macB64 = ""] = match;
	const iv = Buffer.from(ivB64, "base64");
	const data = Buffer.from(dataB64, "base64");
	const mac = createHmac("sha256", k.subarray(32))
		.update(Buffer.concat([iv, data]))
		.digest();
	const given = Buffer.from(macB64, "base64");
	if (given.length !== mac.length || !timingSafeEqual(given, mac))
		throw new BitwardenCryptoError(
			"A Bitwarden encrypted value failed its integrity check.",
		);
	const decipher = createDecipheriv("aes-256-cbc", k.subarray(0, 32), iv);
	return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** Decrypt an RSA EncString (types 3, 4, 6) with a PKCS#8 DER private key. */
export function decryptRsaEncString(text: string, pkcs8: Buffer): Buffer {
	const match = /^([346])\.([^|]+)(?:\|.*)?$/u.exec(text);
	if (match === null)
		throw new BitwardenCryptoError(
			"Expected an RSA-encrypted Bitwarden value (type 3, 4 or 6).",
		);
	const [, type, dataB64 = ""] = match;
	return privateDecrypt(
		{
			key: createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: type === "3" ? "sha256" : "sha1",
		},
		Buffer.from(dataB64, "base64"),
	);
}

/** HKDF-Expand (RFC 5869) alone, as Bitwarden stretches a 32-byte master key. */
function hkdfExpand(prk: Buffer, info: string, length: number): Buffer {
	const blocks: Buffer[] = [];
	let previous = Buffer.alloc(0);
	for (let i = 1; Buffer.concat(blocks).length < length; i++) {
		previous = createHmac("sha256", prk)
			.update(Buffer.concat([previous, Buffer.from(info), Buffer.of(i)]))
			.digest();
		blocks.push(previous);
	}
	return Buffer.concat(blocks).subarray(0, length);
}

/** A 32-byte master key stretched to a 64-byte encryption + MAC key. */
export function stretchMasterKey(masterKey: Buffer): Buffer {
	return Buffer.concat([
		hkdfExpand(masterKey, "enc", 32),
		hkdfExpand(masterKey, "mac", 32),
	]);
}

/** A new RSA-2048 key pair for one sign-in request (SPKI and PKCS#8, DER). */
export function signInRequestKeyPair() {
	const pair = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "der" },
		privateKeyEncoding: { type: "pkcs8", format: "der" },
	});
	return { spki: pair.publicKey, pkcs8: pair.privateKey };
}

/** The phrase Bitwarden shows for `material` (the account's email) and a public key. */
export function fingerprintPhrase(material: string, spki: Buffer): string {
	// HKDF-Expand with the SHA-256 of the key as PRK; one 32-byte block.
	const prk = createHash("sha256").update(spki).digest();
	const hash = hkdfExpand(prk, material, 32);
	let number = BigInt(`0x${hash.toString("hex")}`);
	const size = BigInt(EFF_LONG_WORDLIST.length);
	// ceil(64 bits of entropy / log2(7776)) = 5 words.
	const words: string[] = [];
	for (let i = 0; i < 5; i++) {
		words.push(EFF_LONG_WORDLIST[Number(number % size)] ?? "");
		number /= size;
	}
	return words.join("-");
}

/** An access code for a sign-in request: 25 letters and digits. */
export function accessCode(): string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
	let out = "";
	while (out.length < 25) {
		const byte = randomBytes(1)[0] ?? 255;
		// Rejection sampling keeps every character equally likely.
		if (byte < alphabet.length * Math.floor(256 / alphabet.length))
			out += alphabet[byte % alphabet.length];
	}
	return out;
}

export interface AccessTokenMaterial {
	/** The 16 random bytes the token carries after its `:`. */
	readonly seed: Buffer;
	/** `{"encryptionKey": <org key>}`, encrypted with the seed's derived key. */
	readonly encryptedPayload: string;
	/** The derived key, encrypted with the organization key. */
	readonly key: string;
}

/** The derived key of an access token's seed (the SDK's `derive_shareable_key`). */
export function accessTokenKey(seed: Buffer): Buffer {
	return Buffer.from(
		hkdfSync("sha256", seed, "bitwarden-accesstoken", "sm-access-token", 64),
	);
}

/** What a new Secrets Manager access token needs, made as Bitwarden's clients make it. */
export function accessTokenMaterial(
	organizationKey: Buffer,
): AccessTokenMaterial {
	const seed = randomBytes(16);
	const derived = accessTokenKey(seed);
	try {
		return {
			seed,
			encryptedPayload: encryptEncString(
				JSON.stringify({
					encryptionKey: symmetricKey(organizationKey).toString("base64"),
				}),
				derived,
			),
			key: encryptEncString(derived.toString("base64"), organizationKey),
		};
	} finally {
		wipe(derived);
	}
}

/** Zero key material the run no longer needs. */
export function wipe(...keys: (Buffer | undefined)[]): void {
	for (const key of keys) key?.fill(0);
}
