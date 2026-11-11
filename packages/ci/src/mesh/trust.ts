/**
 * Whose advertisement is this? A node's identity key, the signature it puts
 * on what it advertises, and what a reader makes of that signature.
 *
 * A node holds an Ed25519 key pair. The private half never leaves the node.
 * The public half travels with every advertisement, beside a signature over a
 * fixed encoding of what the advertisement says, the node's id and its expiry
 * among it. A reader that verifies the signature knows the advertisement was
 * written by whoever holds that key, for that node id, to be believed until
 * that time, and has not been altered since. It cannot be moved to another
 * node id or given a later expiry without the key.
 *
 * That is all the signature proves. It does not say what software the node
 * runs, that its numbers are true, or that the key belongs to a machine the
 * operator knows. The last of those is what the trusted-key set is for: a
 * reader calls a node `trusted` when its key is in that set, `unverified`
 * when the signature is good (or absent, on an older node) but the key is not
 * in it, and `invalid` when a signature is present and does not verify.
 *
 * Nothing here reads a clock, the network or a file.
 */
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

/** What a reader made of a node's signature and key. */
export type MeshTrust = "trusted" | "unverified" | "invalid";

/** The public key a node signs with and its signature over one advertisement. */
export type MeshIdentityProof = Readonly<{
	/** The raw Ed25519 public key, base64url without padding (43 characters). */
	publicKey: string;
	/** The Ed25519 signature over `meshAdvertSigningPayload`, base64url (86 characters). */
	signature: string;
}>;

/** A node's key pair as the node itself holds it. */
export type MeshIdentity = Readonly<{
	publicKey: string;
	/** Signs a payload; the private key stays inside. */
	sign(payload: string): string;
}>;

/** One key the mesh's operator vouches for. */
export type MeshTrustedKey = Readonly<{
	publicKey: string;
	/** When set, the key is trusted for this node id only. */
	nodeId?: string | undefined;
}>;

/** Which keys a reader trusts, and whether it ranks anyone else. */
export type MeshTrustPolicy = Readonly<{
	trustedKeys: readonly MeshTrustedKey[];
	requireTrusted: boolean;
}>;

/** A raw Ed25519 public key as base64url. */
export const MESH_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
/** An Ed25519 signature as base64url. */
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

/** A new key pair: the identity, and the PKCS#8 PEM the node must keep private. */
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

/** The identity a stored PKCS#8 PEM holds. Throws when it is not an Ed25519 key. */
export function meshIdentityFromPem(privateKeyPem: string): MeshIdentity {
	return identityOf(createPrivateKey(privateKeyPem));
}

/**
 * The exact text a node signs: a JSON array of fixed fields in a fixed
 * order, led by a context string so the signature means nothing anywhere
 * else. An absent field is `null`, which a zero is not. The node id, the
 * expiry and the signing key are all inside, so a signed advertisement cannot
 * be re-attributed, extended or claimed by another key.
 *
 * Fields a reader computes (`trust`, `seenAtMs`) are not part of it.
 */
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
		publicKey,
	]);
}

/** The advertisement as the node sends it: without what only a reader computes. */
function sendable(node: MeshNode): MeshNode {
	const { trust: _trust, seenAtMs: _seenAtMs, ...sent } = node;
	return sent;
}

/** The advertisement with the node's key and signature attached. */
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

/**
 * Whether the advertisement's signature holds: `unsigned` when it carries
 * none, `invalid` when the key or signature is malformed or the signature
 * does not match what the advertisement now says.
 */
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

/**
 * What a reader holding `policy` makes of an advertisement. A key bound to a
 * node id is trusted for that id only: under any other id it is an unknown
 * key, not a forgery.
 */
export function assessMeshTrust(
	node: MeshNode,
	policy: MeshTrustPolicy,
): MeshTrust {
	const verdict = verifyMeshAdvert(node);
	if (verdict === "invalid") return "invalid";
	if (verdict === "unsigned") return "unverified";
	const publicKey = node.identity?.publicKey;
	return policy.trustedKeys.some(
		(entry) =>
			entry.publicKey === publicKey &&
			(entry.nodeId === undefined || entry.nodeId === node.id),
	)
		? "trusted"
		: "unverified";
}

/**
 * The policy a reader works by. A mesh whose operator has listed keys is
 * taken at its word. One with no list trusts only the reader's own key, so
 * every other node is `unverified` until someone lists it.
 */
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

/**
 * A board that signs what this node advertises and says, of everything it
 * reads, how far the reader trusts it. Every advertisement is still returned,
 * the invalid ones too, so they can be reported; ranking leaves them out
 * (`fitJob`).
 */
export function createTrustedMeshBoard(options: {
	board: MeshBoard;
	/** This node's key pair. Without one it advertises unsigned and trusts by policy alone. */
	identity?: MeshIdentity | undefined;
	/** The policy in force right now; read on every call. */
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
