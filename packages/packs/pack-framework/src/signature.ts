import { createHash } from "node:crypto";

import { PackError } from "./errors.js";
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

export const PACK_SIGNATURE_ALGORITHMS = [
	"ed25519",
	"ecdsa-p256-sha256",
	"rsa-pss-sha256",
] as const;

export type PackSignatureAlgorithm = (typeof PACK_SIGNATURE_ALGORITHMS)[number];

export type PackSignature = {
	readonly algorithm: PackSignatureAlgorithm;
	readonly keyId: string;
	readonly value: string;
	readonly payloadDigest: string;
	readonly signedAt: string;
};

export type PackSignatureVerdict = "valid" | "invalid" | "unknown";

export type PackSignatureVerificationRequest = {
	readonly payload: string;
	readonly signature: PackSignature;
};

export interface PackSignatureVerifier {
	verify(request: PackSignatureVerificationRequest): PackSignatureVerdict;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export function parsePackSignature(input: PackSignature): PackSignature {
	if (
		// SAFETY: `!(PACK_SIGNATURE_ALGORITHMS as readonly string[]).includes(input.algorithm)` is required at this I/O or test boundary.
		!(PACK_SIGNATURE_ALGORITHMS as readonly string[]).includes(input.algorithm)
	) {
		throw new PackError(
			"PACK_INTEGRITY_UNVERIFIED",
			`signature algorithm ${JSON.stringify(String(input.algorithm))} is not supported`,
		);
	}
	if (!KEY_ID.test(input.keyId)) {
		throw new PackError(
			"PACK_INTEGRITY_UNVERIFIED",
			"signature keyId is not a valid identifier",
		);
	}
	if (input.value.length === 0 || !BASE64.test(input.value)) {
		throw new PackError(
			"PACK_INTEGRITY_UNVERIFIED",
			"signature value must be non-empty base64",
		);
	}
	if (!SHA256.test(input.payloadDigest)) {
		throw new PackError(
			"PACK_INTEGRITY_UNVERIFIED",
			"signature payloadDigest must be sha256:<64 hex>",
		);
	}
	if (!ISO_INSTANT.test(input.signedAt)) {
		throw new PackError(
			"PACK_INTEGRITY_UNVERIFIED",
			"signature signedAt must be an ISO-8601 UTC instant",
		);
	}
	return input;
}

export function canonicalJson(value: JsonValue): string {
	if (value === null) return "null";
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	if (isJsonString(value)) return JSON.stringify(value);
	if (isJsonNumber(value)) {
		if (!Number.isFinite(value)) {
			throw new PackError(
				"PACK_MANIFEST_INVALID",
				"a pack manifest cannot contain a non-finite number",
			);
		}
		return JSON.stringify(value);
	}
	if (isJsonBoolean(value)) return value ? "true" : "false";
	if (isJsonObject(value)) {
		const entries = Object.entries(value)
			.filter(([, entryValue]) => entryValue !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries
			.map(
				([key, entryValue]) =>
					`${JSON.stringify(key)}:${canonicalJson(entryValue ?? null)}`,
			)
			.join(",")}}`;
	}
	throw new PackError(
		"PACK_MANIFEST_INVALID",
		"a pack manifest cannot contain a non-JSON value",
	);
}

export function sha256Of(payload: string): string {
	return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

export function canonicalizeForSigning(manifest: {
	readonly signature?: PackSignature;
}): string {
	const { signature: _signature, ...rest } = manifest;
	return canonicalJson(rest);
}
