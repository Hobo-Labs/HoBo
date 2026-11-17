import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import type { MeshBoard } from "./coordinator.js";
import type { MeshNode } from "./rendezvous.js";

export type MeshTrust = "trusted" | "unverified" | "invalid";

export type MeshIdentityProof = Readonly<{
	publicKey: string;
	signature: string;
}>;

export type MeshIdentity = Readonly<{
	publicKey: string;
	sign(payload: string): string;
}>;

export type MeshTrustedKey = Readonly<{
	publicKey: string;
	nodeId?: string | undefined;
}>;

export type MeshTrustPolicy = Readonly<{
	trustedKeys: readonly MeshTrustedKey[];
	requireTrusted: boolean;
}>;

export const MESH_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
export const MESH_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

// public-contract: the domain separator of the signed encoding; a change to what is signed needs a new one.
export const MESH_ADVERT_SIGNING_CONTEXT = "hobo-ci-mesh-advert/v1";

function identityOf(privateKey: KeyObject): MeshIdentity {
	if (privateKey.asymmetricKeyType !== "ed25519")
		throw new Error("mesh identity key must be Ed25519");
	const publicKey = createPublicKey(privateKey).export({ format: "jwk" }).x;
	if (publicKey === undefined || !MESH_PUBLIC_KEY.test(publicKey))
		throw new Error("mesh identity key has no public half");
	return {
		publicKey,
		sign: (payload) =>
			sign(null, Buffer.from(payload, "utf8"), privateKey).toString(
				"base64url",
			),
	};
}

export type GeneratedMeshIdentity = Readonly<{
	identity: MeshIdentity;
	privateKeyPem: string;
}>;

export function generateMeshIdentity(): GeneratedMeshIdentity {
	const { privateKey } = generateKeyPairSync("ed25519");
	return {
		identity: identityOf(privateKey),
		privateKeyPem: privateKey
			.export({ format: "pem", type: "pkcs8" })
			.toString(),
	};
}

export function meshIdentityFromPem(privateKeyPem: string): MeshIdentity {
	return identityOf(createPrivateKey(privateKeyPem));
}

export function meshAdvertSigningPayload(
	node: MeshNode,
	publicKey: string,
): string {
	return JSON.stringify([
		MESH_ADVERT_SIGNING_CONTEXT,
		node.id,
		node.validUntilMs,
		node.freeSlots,
		node.totalSlots ?? null,
		node.healthy,
		[...node.labels],
		node.free?.memoryMb ?? null,
		node.free?.diskMb ?? null,
		node.platform?.os ?? null,
		node.platform?.arch ?? null,
		node.reliability ?? null,
		node.samples?.delivered ?? null,
		node.samples?.dropped ?? null,
		node.sinceMs ?? null,
		node.repository ?? null,
		publicKey,
	]);
}

function sendable(node: MeshNode): MeshNode {
	const { trust: _trust, seenAtMs: _seenAtMs, ...sent } = node;
	return sent;
}

export function signMeshAdvert(
	node: MeshNode,
	identity: MeshIdentity,
): MeshNode {
	const unsigned = sendable(node);
	return {
		...unsigned,
		identity: {
			publicKey: identity.publicKey,
			signature: identity.sign(
				meshAdvertSigningPayload(unsigned, identity.publicKey),
			),
		},
	};
}

export function verifyMeshAdvert(
	node: MeshNode,
): "valid" | "unsigned" | "invalid" {
	const proof = node.identity;
	if (proof === undefined) return "unsigned";
	if (
		!MESH_PUBLIC_KEY.test(proof.publicKey) ||
		!MESH_SIGNATURE.test(proof.signature)
	)
		return "invalid";
	try {
		const key = createPublicKey({
			key: { kty: "OKP", crv: "Ed25519", x: proof.publicKey },
			format: "jwk",
		});
		return verify(
			null,
			Buffer.from(meshAdvertSigningPayload(node, proof.publicKey), "utf8"),
			key,
			Buffer.from(proof.signature, "base64url"),
		)
			? "valid"
			: "invalid";
	} catch {
		return "invalid";
	}
}

export function assessMeshTrust(
	node: MeshNode,
	policy: MeshTrustPolicy,
): MeshTrust {
	const verdict = verifyMeshAdvert(node);
	if (verdict === "invalid") return "invalid";
	const publicKey = node.identity?.publicKey;
	const bound = policy.trustedKeys.filter((entry) => entry.nodeId === node.id);
	if (bound.length > 0)
		return verdict === "valid" &&
			bound.some((entry) => entry.publicKey === publicKey)
			? "trusted"
			: "invalid";
	if (verdict === "unsigned") return "unverified";
	return policy.trustedKeys.some(
		(entry) => entry.nodeId === undefined && entry.publicKey === publicKey,
	)
		? "trusted"
		: "unverified";
}

export function effectiveMeshTrust(
	configured: MeshTrustPolicy | undefined,
	selfPublicKey: string | undefined,
): MeshTrustPolicy {
	if (configured && configured.trustedKeys.length > 0) return configured;
	return {
		trustedKeys:
			selfPublicKey === undefined ? [] : [{ publicKey: selfPublicKey }],
		requireTrusted: configured?.requireTrusted ?? false,
	};
}

export function createTrustedMeshBoard(options: {
	board: MeshBoard;
	identity?: MeshIdentity | undefined;
	policy: () => MeshTrustPolicy;
}): MeshBoard {
	const { board, identity } = options;
	return {
		async advertise(node) {
			await board.advertise(
				identity ? signMeshAdvert(node, identity) : sendable(node),
			);
		},
		async nodes() {
			const policy = options.policy();
			return (await board.nodes()).map((node) => ({
				...node,
				trust: assessMeshTrust(node, policy),
			}));
		},
	};
}
