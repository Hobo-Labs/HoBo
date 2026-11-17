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
	isJsonString,
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

// Canonical JSON: recursively sort keys by UTF-16 code units without locale
// collation or whitespace. The same document serializes to the same bytes.
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
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
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

function isPublicKeyPem(value: string | undefined): value is string {
	return (
		isJsonString(value) &&
		/^\s*-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/u.test(
			value,
		)
	);
}

export function signResolution(
	resolution: ResolutionReceipt | ResolutionRejection,
	key: ResolutionSigningKey,
): ResolutionSignature {
	const privateKey = key.privateKey;
	const advertisedPem = key.publicKeyPem;
	let publicKeyPem: string;
	try {
		if (!isPublicKeyPem(advertisedPem)) throw new Error("public key required");
		const actual = createPublicKey(privateKey);
		const advertised = createPublicKey(advertisedPem);
		if (
			actual.asymmetricKeyType !== "ed25519" ||
			advertised.asymmetricKeyType !== "ed25519" ||
			!actual
				.export({ type: "spki", format: "der" })
				.equals(advertised.export({ type: "spki", format: "der" }))
		) {
			throw new Error("signing key mismatch");
		}
		publicKeyPem = advertised
			.export({ type: "spki", format: "pem" })
			.toString();
	} catch {
		throw new BrokerParseError(
			"signing-key-mismatch",
			"signing-key-mismatch: the Ed25519 private key and advertised public key must match",
		);
	}
	const payload = canonicalResolutionJson(resolution);
	const payloadBytes = Buffer.from(payload, "utf8");
	const signature = edSign(null, payloadBytes, privateKey);
	return {
		algorithm: RESOLUTION_SIGNATURE_ALGORITHM,
		publicKeyPem,
		signature: signature.toString("base64"),
		payloadDigest: `sha256:${createHash("sha256").update(payloadBytes).digest("hex")}`,
	};
}

export function verifyResolution(
	resolution: ResolutionReceipt | ResolutionRejection,
	signature: ResolutionSignature,
	trustedPublicKeyPem: string,
): boolean {
	const {
		algorithm,
		publicKeyPem,
		signature: encoded,
		payloadDigest,
	} = signature;
	if (algorithm !== RESOLUTION_SIGNATURE_ALGORITHM) {
		throw new BrokerParseError(
			"unsupported-signature-algorithm",
			`unsupported-signature-algorithm: ${String(algorithm)}`,
		);
	}
	const payloadBytes = Buffer.from(canonicalResolutionJson(resolution), "utf8");
	if (
		payloadDigest !==
		`sha256:${createHash("sha256").update(payloadBytes).digest("hex")}`
	)
		return false;
	try {
		if (!isPublicKeyPem(trustedPublicKeyPem) || !isPublicKeyPem(publicKeyPem))
			return false;
		const trusted = createPublicKey(trustedPublicKeyPem);
		const advertised = createPublicKey(publicKeyPem);
		if (
			trusted.asymmetricKeyType !== "ed25519" ||
			advertised.asymmetricKeyType !== "ed25519" ||
			!trusted
				.export({ type: "spki", format: "der" })
				.equals(advertised.export({ type: "spki", format: "der" }))
		)
			return false;
		const bytes = Buffer.from(encoded, "base64");
		if (bytes.length !== 64 || bytes.toString("base64") !== encoded)
			return false;
		return edVerify(null, payloadBytes, trusted, bytes);
	} catch {
		return false;
	}
}
