/**
 * The capture form seals the value before it leaves the form, so the MCP
 * host that relays the form's `tools/call` (and any log the host keeps of a
 * View-initiated call, which the MCP Apps spec asks hosts to keep) sees only
 * ciphertext. Each ticket has its own P-256 key pair; the private half never
 * leaves this process and is dropped when the ticket closes.
 *
 * Construction (ECDH-ES, as in JWE's ECDH-ES with a direct key, but with
 * HKDF): the form makes an ephemeral P-256 key, derives the shared secret
 * with the ticket's public key, runs HKDF-SHA256 (salt: the ticket id; info:
 * `hobo-secret-capture/v1`) to a 256-bit AES-GCM key, and encrypts with a
 * random 96-bit IV and `<ticketId>:<name>` as associated data, so a sealed
 * value cannot be replayed into another ticket or another secret.
 */

import {
	createDecipheriv,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
} from "node:crypto";
import { fromJson } from "@bufbuild/protobuf";
import {
	type SecretCaptureKey,
	type SecretCaptureSealed,
	SecretCaptureSealedSchema,
} from "../_generated/secret_capture_pb.js";
import type { JsonValue } from "../json.js";
import { SecretCaptureError } from "./errors.js";

// public-contract: the HKDF info string the form and the server both use.
export const SECRET_CAPTURE_SEAL_INFO = "hobo-secret-capture/v1";

/** The largest ciphertext accepted: 32 KiB of value plus the tag, in base64url. */
const MAX_CIPHERTEXT_CHARS = 44_000;
const B64U = /^[A-Za-z0-9_-]+$/u;
const COORDINATE = /^[A-Za-z0-9_-]{43}$/u;

export type CapturePublicKey = Readonly<{
	kty: "EC";
	crv: "P-256";
	x: string;
	y: string;
}>;

export interface CaptureKeyPair {
	readonly publicKey: CapturePublicKey;
	/** Open a sealed value; throws `SECRET_CAPTURE_SEAL_INVALID` on any failure. */
	open(sealed: ParsedSealedSecret, aad: string): string;
	/** Drop the private key: `open` refuses afterwards. */
	destroy(): void;
}

declare const parsedSealed: unique symbol;

export type ParsedSealedSecret = Readonly<{
	ticketId: string;
	epk: CapturePublicKey;
	iv: Buffer;
	ciphertext: Buffer;
	readonly [parsedSealed]: true;
}>;

function sealInvalid(): never {
	throw new SecretCaptureError(
		"SECRET_CAPTURE_SEAL_INVALID",
		"The form's sealed value did not open with this capture's key.",
		"Reload the form and submit again.",
	);
}

function parseKey(key: SecretCaptureKey | undefined): CapturePublicKey {
	if (
		key === undefined ||
		key.kty !== "EC" ||
		key.crv !== "P-256" ||
		!COORDINATE.test(key.x) ||
		!COORDINATE.test(key.y)
	)
		return sealInvalid();
	return Object.freeze({ kty: "EC", crv: "P-256", x: key.x, y: key.y });
}

/** Parse what a form sent. Nothing about it is quoted in a refusal. */
export function parseSealedSecret(json: JsonValue): ParsedSealedSecret {
	let record: SecretCaptureSealed;
	try {
		record = fromJson(SecretCaptureSealedSchema, json);
	} catch {
		return sealInvalid();
	}
	if (
		!/^cap_[A-Za-z0-9_-]{22}$/u.test(record.ticketId) ||
		!B64U.test(record.iv) ||
		!B64U.test(record.ciphertext) ||
		record.ciphertext.length > MAX_CIPHERTEXT_CHARS
	)
		return sealInvalid();
	const iv = Buffer.from(record.iv, "base64url");
	const ciphertext = Buffer.from(record.ciphertext, "base64url");
	if (iv.length !== 12 || ciphertext.length <= 16) return sealInvalid();
	// SAFETY: every field above was checked; the brand records that.
	return Object.freeze({
		ticketId: record.ticketId,
		epk: parseKey(record.epk),
		iv,
		ciphertext,
	}) as ParsedSealedSecret;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export function createCaptureKeyPair(): CaptureKeyPair {
	const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	let privateKey: KeyObject | undefined = pair.privateKey;
	const jwk = pair.publicKey.export({ format: "jwk" });
	if (!jwk.x || !jwk.y)
		throw new SecretCaptureError(
			"SECRET_CAPTURE_INVALID_INPUT",
			"could not create a capture key",
		);
	const publicKey: CapturePublicKey = Object.freeze({
		kty: "EC",
		crv: "P-256",
		x: jwk.x,
		y: jwk.y,
	});
	return {
		publicKey,
		open(sealed, aad) {
			if (privateKey === undefined) return sealInvalid();
			try {
				const shared = diffieHellman({
					privateKey,
					publicKey: createPublicKey({
						key: { ...sealed.epk },
						format: "jwk",
					}),
				});
				const key = Buffer.from(
					hkdfSync(
						"sha256",
						shared,
						Buffer.from(sealed.ticketId, "utf8"),
						Buffer.from(SECRET_CAPTURE_SEAL_INFO, "utf8"),
						32,
					),
				);
				const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - 16);
				const body = sealed.ciphertext.subarray(
					0,
					sealed.ciphertext.length - 16,
				);
				const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv, {
					authTagLength: 16,
				});
				decipher.setAAD(Buffer.from(aad, "utf8"));
				decipher.setAuthTag(tag);
				const plain = Buffer.concat([decipher.update(body), decipher.final()]);
				const text = strictUtf8.decode(plain);
				plain.fill(0);
				key.fill(0);
				return text;
			} catch {
				// The cause is not kept: a crypto error says nothing useful and
				// nothing about the value.
				return sealInvalid();
			}
		},
		destroy() {
			privateKey = undefined;
		},
	};
}

/**
 * The form's sealing function, as browser JavaScript (Web Crypto). It is
 * embedded verbatim in the capture page, and the tests run this same source
 * against `createCaptureKeyPair().open`, so the two cannot drift apart.
 * `hoboSeal(subtle, ticketKey, value, ticketId, aad)` resolves to
 * `{ epk, iv, ciphertext }`.
 */
// public-contract: the browser sealing function the capture page embeds.
export const SECRET_CAPTURE_SEAL_SOURCE = `async function hoboSeal(subtle, ticketKey, value, ticketId, aad) {
  var enc = new TextEncoder();
  var server = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: ticketKey.x, y: ticketKey.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  var eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  var shared = await subtle.deriveBits({ name: "ECDH", public: server }, eph.privateKey, 256);
  var ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  var key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode(ticketId), info: enc.encode("${SECRET_CAPTURE_SEAL_INFO}") }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  var iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  var sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: enc.encode(aad) }, key, enc.encode(value)));
  var epk = await subtle.exportKey("jwk", eph.publicKey);
  function b64u(bytes) {
    var text = "";
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  return { epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y }, iv: b64u(iv), ciphertext: b64u(sealed) };
}`;
