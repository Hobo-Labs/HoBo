import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@hobo/core";

const tagOf = Object.prototype.toString;

export function isText<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isNumeric<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]" && Number.isFinite(value);
}

export function isRecord<T>(value: T): value is T & JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

export function isList<T>(value: T): value is T & JsonValue[] {
	return Array.isArray(value);
}

export function parseJson(text: string): JsonValue | undefined {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

export function field(
	value: JsonValue | undefined,
	key: string,
): JsonValue | undefined {
	return isRecord(value) ? value[key] : undefined;
}

export function text(
	value: JsonValue | undefined,
	key: string,
): string | undefined {
	const found = field(value, key);
	return isText(found) ? found : undefined;
}

export function list(
	value: JsonValue | undefined,
	key: string,
): readonly JsonValue[] {
	const found = field(value, key);
	return isList(found) ? found : [];
}

export function canonical(value: JsonValue): string {
	if (isList(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function sha256Hex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Digest(bytes: Uint8Array | string): `sha256:${string}` {
	return `sha256:${sha256Hex(bytes)}`;
}

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isDigest(value: string): value is `sha256:${string}` {
	return DIGEST_PATTERN.test(value);
}

export function latin1Bytes(body: string): Uint8Array | undefined {
	const bytes = new Uint8Array(body.length);
	for (let index = 0; index < body.length; index += 1) {
		const code = body.charCodeAt(index);
		if (code > 0xff) return undefined;
		bytes[index] = code;
	}
	return bytes;
}

export function latin1Text(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("latin1");
}

export function utf8(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

export function encode(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}
