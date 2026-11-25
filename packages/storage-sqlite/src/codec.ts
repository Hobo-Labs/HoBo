import {
	isJsonObject,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";

export type PayloadCodec = "json-v1" | "protobuf-v1";

// public-contract: default journal payload codec id.
export const DEFAULT_PAYLOAD_CODEC: PayloadCodec = "json-v1";
// public-contract: default stream metadata codec id.
export const DEFAULT_METADATA_CODEC: PayloadCodec = "json-v1";
// public-contract: default actor state codec id.
export const DEFAULT_STATE_CODEC: PayloadCodec = "json-v1";

export class UnsupportedCodecError extends Error {
	readonly code = "UNSUPPORTED_CODEC" as const;
	constructor(
		readonly codec: string,
		readonly field: string,
	) {
		super(`unsupported codec "${codec}" for ${field}`);
		this.name = "UnsupportedCodecError";
	}
}

export function encodeJson<T>(value: T): Uint8Array {
	const text = JSON.stringify(value ?? null);
	return new TextEncoder().encode(text);
}

export function decodeJson(bytes: Uint8Array): JsonValue {
	const text = new TextDecoder().decode(bytes);
	if (text.length === 0) return null;
	return parseJsonValue(text);
}

export function encodeLegacyJsonText<T>(value: T): string {
	return JSON.stringify(value ?? null);
}

export function decodeLegacyJsonText(text: string): JsonValue {
	return parseJsonValue(text);
}

export type DecodedPayload = JsonValue | Uint8Array;

export function encodePayload<T>(codec: PayloadCodec, value: T): Uint8Array {
	switch (codec) {
		case "json-v1":
			return encodeJson(value);
		case "protobuf-v1":
			if (value instanceof Uint8Array) return value;
			throw new TypeError("protobuf-v1 payload must be Uint8Array");
		default:
			throw new UnsupportedCodecError(`${codec}`, "payload");
	}
}

export function decodePayload(
	codec: string,
	bytes: Uint8Array,
): DecodedPayload {
	switch (codec) {
		case "json-v1":
			return decodeJson(bytes);
		case "protobuf-v1":
			return bytes;
		default:
			throw new UnsupportedCodecError(codec, "payload");
	}
}

export function encodeMetadata(
	codec: PayloadCodec,
	value: JsonObject,
): Uint8Array {
	return encodePayload(codec, value);
}

export function decodeMetadata(codec: string, bytes: Uint8Array): JsonObject {
	const decoded = decodePayload(codec, bytes);
	return isJsonObject(decoded) ? decoded : {};
}

export function parseCodec<T>(value: T, field: string): PayloadCodec {
	if (value === "json-v1") return "json-v1";
	if (value === "protobuf-v1") return "protobuf-v1";
	throw new UnsupportedCodecError(`${value}`, field);
}
