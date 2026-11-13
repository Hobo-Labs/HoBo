// In-memory `Signer`s over node KeyObjects: ES256 signatures in IEEE P1363
// form (r ‖ s, 64 bytes), EdDSA over Ed25519. The private key stays in the
// closure; nothing here exports it.
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { KeyAlgorithm } from "../_generated/fleet_pb.js";
import { type KeyId, parseKeyId } from "../ids.js";
import type { PublicJwk, Signer } from "../ports.js";
import { publicJwkOfKey, thumbprintOf } from "./jose.js";
import { deviceMemberId } from "./member-id.js";

export function memorySigner(keyId: KeyId, privateKey: KeyObject): Signer {
	const algorithm =
		privateKey.asymmetricKeyType === "ec"
			? KeyAlgorithm.ES256
			: privateKey.asymmetricKeyType === "ed25519"
				? KeyAlgorithm.EDDSA
				: undefined;
	if (algorithm === undefined)
		throw new Error("a signer is an EC P-256 or an Ed25519 key");
	return Object.freeze({
		keyId,
		algorithm,
		async sign(bytes: Uint8Array): Promise<Uint8Array> {
			return new Uint8Array(
				algorithm === KeyAlgorithm.ES256
					? sign("sha256", bytes, {
							key: privateKey,
							dsaEncoding: "ieee-p1363",
						})
					: sign(null, bytes, privateKey),
			);
		},
	} satisfies Signer);
}

/** A freshly generated signing key: the private half stays with its holder. */
export type SigningKey = Readonly<{
	privateKey: KeyObject;
	publicJwk: PublicJwk;
}>;

export function generateSigningKey(
	algorithm: KeyAlgorithm.ES256 | KeyAlgorithm.EDDSA,
): SigningKey {
	const pair =
		algorithm === KeyAlgorithm.ES256
			? generateKeyPairSync("ec", { namedCurve: "P-256" })
			: generateKeyPairSync("ed25519");
	return {
		privateKey: pair.privateKey,
		publicJwk: publicJwkOfKey(pair.publicKey),
	};
}

/** A fresh ES256 key whose signer is named as the identity key of the device it would enroll. */
export function freshDpopKey(): Readonly<{
	signer: Signer;
	publicJwk: PublicJwk;
}> {
	const { privateKey, publicJwk } = generateSigningKey(KeyAlgorithm.ES256);
	const memberId = deviceMemberId(thumbprintOf(publicJwk));
	return Object.freeze({
		signer: memorySigner(parseKeyId(`${memberId}#identity`), privateKey),
		publicJwk,
	});
}
