import {
	createHash,
	createPrivateKey,
	createPublicKey,
	createSign,
	type KeyObject,
} from "node:crypto";
import { type CdIssuerSigningKey, createIssuerKms } from "@hobo/hobo-cd";
import { JwtSvidIssuer, type KmsLike } from "@hobo/identity";
import type { CdSecretReader } from "./cd-store.js";

// public-contract: the owner-store entry for the CD SVID signing key.
export const CD_SVID_SIGNING_KEY = "HOBO_CD_SVID_SIGNING_KEY";

export type OwnerCdSvidIssuer = Readonly<{
	issuer: JwtSvidIssuer;
	close(): void;
}>;

export function injectedCdSvidIssuer(
	key: CdIssuerSigningKey,
	issuerUrl: string,
): OwnerCdSvidIssuer {
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		try {
			key.close();
		} catch {
			throw new Error("CD signing key cleanup failed");
		}
	};
	try {
		const keyId = key.keyId;
		const signer = createIssuerKms(key);
		if (!signer.hasKey(keyId)) throw new Error("CD signing key unavailable");
		const kms: KmsLike = {
			...signer,
			hasKey(id) {
				try {
					return signer.hasKey(id);
				} catch {
					return false;
				}
			},
			sign(id, payload) {
				try {
					return signer.sign(id, payload);
				} catch {
					throw new Error("CD signing key unavailable");
				}
			},
		};
		return {
			issuer: new JwtSvidIssuer({
				issuerUrl,
				kms,
				activeKeyId: keyId,
				jwksKeyIds: [keyId],
			}),
			close,
		};
	} catch {
		try {
			close();
		} catch {}
		throw new Error("CD signing key unavailable");
	}
}

export async function ownerCdSvidIssuer(
	readSecret: CdSecretReader,
	issuerUrl: string,
): Promise<OwnerCdSvidIssuer> {
	const material = await readSecret(CD_SVID_SIGNING_KEY);
	if (!material || Buffer.byteLength(material) > 32_768)
		throw new Error("CD signing key unavailable");
	let privateKey: KeyObject | undefined = createPrivateKey(material);
	if (
		privateKey.asymmetricKeyType !== "rsa" ||
		(privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
	)
		throw new Error("CD signing key invalid");
	const publicKey = createPublicKey(privateKey);
	const exported = publicKey.export({ format: "jwk" });
	if (!exported.n || !exported.e) throw new Error("CD signing key invalid");
	const kid = createHash("sha256")
		.update(publicKey.export({ format: "der", type: "spki" }))
		.digest("hex");
	const publicJwk = {
		kty: "RSA",
		n: exported.n,
		e: exported.e,
		kid,
		alg: "RS256",
		use: "sig",
	};
	const kms: KmsLike = {
		hasKey: (id) => id === kid && privateKey !== undefined,
		generateRsaKey() {
			throw new Error("CD signing key rotation requires the owner store");
		},
		sign(id, payload) {
			if (id !== kid) throw new Error("CD signing key unavailable");
			if (!privateKey) throw new Error("CD signing key unavailable");
			return createSign("RSA-SHA256").update(payload).end().sign(privateKey);
		},
		publicJwk(id) {
			if (id !== kid) throw new Error("CD signing key unavailable");
			return { ...publicJwk };
		},
	};
	return {
		issuer: new JwtSvidIssuer({
			issuerUrl,
			kms,
			activeKeyId: kid,
			jwksKeyIds: [kid],
		}),
		close() {
			privateKey = undefined;
		},
	};
}
