import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
} from "node:crypto";

export type MachineIdentity = Readonly<{
	publicKey: string;
	sign(payload: string): string;
}>;

export type GeneratedMachineIdentity = Readonly<{
	identity: MachineIdentity;
	privateKeyPem: string;
}>;

export const MACHINE_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
export const MACHINE_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

function identityOf(privateKey: KeyObject): MachineIdentity {
	if (privateKey.asymmetricKeyType !== "ed25519")
		throw new Error("machine identity key must be Ed25519");
	const publicKey = createPublicKey(privateKey).export({ format: "jwk" }).x;
	if (publicKey === undefined || !MACHINE_PUBLIC_KEY.test(publicKey))
		throw new Error("machine identity key has no public half");
	return {
		publicKey,
		sign: (payload) =>
			sign(null, Buffer.from(payload, "utf8"), privateKey).toString(
				"base64url",
			),
	};
}

export function generateMachineIdentity(): GeneratedMachineIdentity {
	const { privateKey } = generateKeyPairSync("ed25519");
	return {
		identity: identityOf(privateKey),
		privateKeyPem: privateKey
			.export({ format: "pem", type: "pkcs8" })
			.toString(),
	};
}

export function machineIdentityFromPem(privateKeyPem: string): MachineIdentity {
	return identityOf(createPrivateKey(privateKeyPem));
}
