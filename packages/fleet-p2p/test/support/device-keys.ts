/**
 * `DeviceKeys` for the unit tests: an Ed25519 SIGN key held in the closure.
 * Sealing is not used by the transport and fails if called.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
	type DeviceKeys,
	KeyAlgorithm,
	parseKeyId,
	parseMemberId,
	type Signer,
} from "@hobo/fleet";

export function createTestDeviceKeys(): DeviceKeys {
	const memberId = parseMemberId(`dev_${randomBytes(16).toString("hex")}`);
	const pair = generateKeyPairSync("ed25519");
	const signer: Signer = {
		keyId: parseKeyId(`${memberId}#sign`),
		algorithm: KeyAlgorithm.EDDSA,
		async sign(bytes) {
			return new Uint8Array(sign(null, bytes, pair.privateKey));
		},
	};
	const raw = pair.publicKey.export({ format: "jwk" }).x ?? "";
	return {
		memberId,
		identityJwk: JSON.stringify(pair.publicKey.export({ format: "jwk" })),
		identity: signer,
		sign: signer,
		signPublicKey: raw,
		sealPublicKey: randomBytes(32).toString("base64url"),
		async openSealed() {
			throw new Error("the transport never opens a sealed box");
		},
		async agree() {
			throw new Error("the transport never agrees a key");
		},
		heldKey: false,
	};
}
