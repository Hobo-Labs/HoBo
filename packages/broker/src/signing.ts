import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign as edSign,
	verify as edVerify,
	generateKeyPairSync,
	type KeyObject,
} from "node:crypto";
import {
	cloneAsJson,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "./json.js";

import { BrokerParseError } from "./policies.js";
import type { ResolutionReceipt, ResolutionRejection } from "./types.js";

// Receipt integrity (the HOBO-529 evidence requirement, now runtime): every
// receipt/rejection can be Ed25519-signed over its canonical JSON form so a
// Yard consuming a resolution can verify it came from the broker that holds
// the key, and that not one byte of the placement evidence changed in
// transit. Tampering with any field — a provider id, a price, a policy hash —
// fails verification.

// public-contract: the signature algorithm identifier recorded on every signature.
export const RESOLUTION_SIGNATURE_ALGORITHM = "ed25519";

// domain-view: detached resolution signature; wire form is ResolutionSignature in data-models/broker.proto.
export interface ResolutionSignature {
	algorithm: typeof RESOLUTION_SIGNATURE_ALGORITHM;
	publicKeyPem: string;
	signature: string;
	payloadDigest: string;
}

// Canonical JSON: recursively key-sorted, no whitespace — the same document
// always serializes to the same bytes, so signatures are replayable.
export function canonicalResolutionJson<T>(value: T): string {
	return canonicalJsonValue(cloneAsJson(value));
}

function canonicalJsonValue(value: JsonValue): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJsonValue).join(",")}]`;
	}
	if (value !== null && isJsonObject(value)) {
		// SAFETY: assertion required at this I/O or test boundary.
		const entries = Object.entries(value as JsonObject)
			.filter(([, entryValue]) => entryValue !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(
				([key, entryValue]) =>
					`${JSON.stringify(key)}:${canonicalJsonValue(entryValue)}`,
			);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

export interface ResolutionSigningKey {
	privateKey: KeyObject;
	publicKeyPem: string;
}

export function generateResolutionSigningKey(): ResolutionSigningKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		privateKey,
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
	};
}

export function importResolutionSigningKey(
	privateKeyPem: string,
): ResolutionSigningKey {
	const privateKey = createPrivateKey(privateKeyPem);
	const publicKeyPem = createPublicKey(privateKey)
		.export({ type: "spki", format: "pem" })
		.toString();
	return { privateKey, publicKeyPem };
}

export function signResolution(
	resolution: ResolutionReceipt | ResolutionRejection,
	key: ResolutionSigningKey,
): ResolutionSignature {
	const payload = canonicalResolutionJson(resolution);
	const payloadBytes = Buffer.from(payload, "utf8");
	const signature = edSign(null, payloadBytes, key.privateKey);
	return {
		algorithm: RESOLUTION_SIGNATURE_ALGORITHM,
		publicKeyPem: key.publicKeyPem,
		signature: signature.toString("base64"),
		payloadDigest: `sha256:${createHash("sha256").update(payloadBytes).digest("hex")}`,
	};
}

export function verifyResolution(
	resolution: ResolutionReceipt | ResolutionRejection,
	signature: ResolutionSignature,
): boolean {
	if (signature.algorithm !== RESOLUTION_SIGNATURE_ALGORITHM) {
		throw new BrokerParseError(
			"unsupported-signature-algorithm",
			`unsupported-signature-algorithm: ${String(signature.algorithm)}`,
		);
	}
	const payloadBytes = Buffer.from(canonicalResolutionJson(resolution), "utf8");
	try {
		return edVerify(
			null,
			payloadBytes,
			createPublicKey(signature.publicKeyPem),
			Buffer.from(signature.signature, "base64"),
		);
	} catch {
		return false;
	}
}
