// Sealing and session keys with the exact parameters of design §7.4.
//
// seal: an ephemeral X25519 key;
//   key = HKDF-SHA-256(ikm = X25519(ephemeral, recipient),
//                      salt = ephemeral_public ‖ recipient_public,
//                      info = utf8(context), 32 bytes);
//   ChaCha20-Poly1305, a random 12-byte nonce, additional data
//   utf8(context) ‖ 0x00 ‖ associatedData.
// sessionKeys: HKDF-SHA-256(ikm = shared secret, salt = utf8(session_id),
//   info = "hobo-fleet/session/v1/i2a" or ".../a2i", 32 bytes).
import {
	createCipheriv,
	createDecipheriv,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	KeyPurpose,
	type PublicKeyRef,
	type SealedBox,
	SealedBoxSchema,
} from "../_generated/fleet_pb.js";
import type { FleetContext, Outcome } from "../ports.js";
import { signingInput } from "./envelope.js";
import { refuse } from "./jose.js";

const X25519_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const CIPHER = "chacha20-poly1305";
// public-contract: HKDF info of the initiator-to-acceptor session key (§7.4).
export const SESSION_INFO_I2A = "hobo-fleet/session/v1/i2a";
// public-contract: HKDF info of the acceptor-to-initiator session key (§7.4).
export const SESSION_INFO_A2I = "hobo-fleet/session/v1/a2i";

/** An X25519 public key from its raw 32 bytes, base64url; undefined when it is not one. */
export function x25519PublicKey(raw: string): KeyObject | undefined {
	const bytes = Buffer.from(raw, "base64url");
	if (bytes.length !== X25519_BYTES || bytes.toString("base64url") !== raw)
		return undefined;
	try {
		return createPublicKey({
			key: { kty: "OKP", crv: "X25519", x: raw },
			format: "jwk",
		});
	} catch {
		return undefined;
	}
}

/** The raw X25519 public key (base64url) of an X25519 key object, public or private. */
export function rawX25519(key: KeyObject): string {
	const publicKey = key.type === "public" ? key : createPublicKey(key);
	const jwk = publicKey.export({ format: "jwk" });
	if (jwk.crv !== "X25519" || jwk.x === undefined)
		throw new Error("not an X25519 key");
	return jwk.x;
}

function sealKey(
	shared: Buffer,
	ephemeralPublic: string,
	recipientPublic: string,
	context: string,
): Buffer {
	const salt = Buffer.concat([
		Buffer.from(ephemeralPublic, "base64url"),
		Buffer.from(recipientPublic, "base64url"),
	]);
	return Buffer.from(
		hkdfSync("sha256", shared, salt, Buffer.from(context, "utf8"), KEY_BYTES),
	);
}

export function sealTo(
	recipient: PublicKeyRef,
	plaintext: Uint8Array,
	context: FleetContext,
	associatedData: Uint8Array,
): SealedBox {
	if (recipient.purpose !== KeyPurpose.SEAL)
		throw new Error(`key ${recipient.keyId} is not a SEAL key`);
	const recipientKey = x25519PublicKey(recipient.value);
	if (recipientKey === undefined)
		throw new Error(`key ${recipient.keyId} is not a raw X25519 key`);
	const ephemeral = generateKeyPairSync("x25519");
	const ephemeralPublic = rawX25519(ephemeral.publicKey);
	const shared = diffieHellman({
		privateKey: ephemeral.privateKey,
		publicKey: recipientKey,
	});
	const key = sealKey(shared, ephemeralPublic, recipient.value, context);
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv(CIPHER, key, nonce, {
		authTagLength: TAG_BYTES,
	});
	cipher.setAAD(signingInput(context, associatedData), {
		plaintextLength: plaintext.length,
	});
	const ciphertext = Buffer.concat([
		cipher.update(plaintext),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	return create(SealedBoxSchema, {
		recipientKeyId: recipient.keyId,
		ephemeralPublicKey: ephemeralPublic,
		nonce: new Uint8Array(nonce),
		ciphertext: new Uint8Array(ciphertext),
	});
}

export function openSealedBox(
	privateKey: KeyObject,
	box: SealedBox,
	context: FleetContext,
	associatedData: Uint8Array,
): Outcome<Uint8Array> {
	if (box.nonce.length !== NONCE_BYTES || box.ciphertext.length < TAG_BYTES)
		return refuse("invalid-request", "the sealed box is malformed");
	const ephemeral = x25519PublicKey(box.ephemeralPublicKey);
	if (ephemeral === undefined)
		return refuse(
			"invalid-request",
			"the sealed box has no raw X25519 ephemeral key",
		);
	try {
		const recipientPublic = rawX25519(privateKey);
		const shared = diffieHellman({ privateKey, publicKey: ephemeral });
		const key = sealKey(
			shared,
			box.ephemeralPublicKey,
			recipientPublic,
			context,
		);
		const body = box.ciphertext.subarray(0, box.ciphertext.length - TAG_BYTES);
		const tag = box.ciphertext.subarray(box.ciphertext.length - TAG_BYTES);
		const decipher = createDecipheriv(CIPHER, key, box.nonce, {
			authTagLength: TAG_BYTES,
		});
		decipher.setAAD(signingInput(context, associatedData), {
			plaintextLength: body.length,
		});
		decipher.setAuthTag(tag);
		const plain = Buffer.concat([decipher.update(body), decipher.final()]);
		return { ok: true, value: new Uint8Array(plain) };
	} catch {
		return refuse(
			"proof-invalid",
			"the sealed box does not open with this key, context and associated data",
		);
	}
}

export function deriveSessionKeys(
	sharedSecret: Uint8Array,
	sessionId: string,
): Readonly<{
	initiatorToAcceptor: Uint8Array;
	acceptorToInitiator: Uint8Array;
}> {
	const salt = Buffer.from(sessionId, "utf8");
	const derive = (info: string) =>
		new Uint8Array(
			hkdfSync(
				"sha256",
				sharedSecret,
				salt,
				Buffer.from(info, "utf8"),
				KEY_BYTES,
			),
		);
	return Object.freeze({
		initiatorToAcceptor: derive(SESSION_INFO_I2A),
		acceptorToInitiator: derive(SESSION_INFO_A2I),
	});
}
