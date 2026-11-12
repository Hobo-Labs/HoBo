/**
 * Byte helpers for the Worker. Web platform only (no `node:` imports): this
 * directory is uploaded to Cloudflare as the Worker's modules.
 */

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
	return encoder.encode(text);
}

export function utf8Length(text: string): number {
	return encoder.encode(text).byteLength;
}

/** RFC 4648 §5, padding optional. Undefined for anything else. */
export function base64UrlDecode(
	text: string,
): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(text)) return undefined;
	const plain = text
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.replace(/=+$/u, "");
	const padded = plain + "=".repeat((4 - (plain.length % 4)) % 4);
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		return undefined;
	}
	const out = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++)
		out[index] = binary.charCodeAt(index);
	return out;
}

export function hex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

export async function sha256Hex(text: string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text))));
}

/**
 * Constant-time equality of two strings of the same public length (hex
 * digests here): every byte is compared whatever the earlier ones were.
 * Unequal lengths answer false at once, which reveals only the length.
 */
export function constantTimeEqual(left: string, right: string): boolean {
	const a = utf8(left);
	const b = utf8(right);
	if (a.byteLength !== b.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < a.byteLength; index++)
		difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	return difference === 0;
}

/**
 * The request body, read up to `limit` bytes. Undefined when it is larger
 * (the rest is never buffered) or is not UTF-8.
 */
export async function readBounded(
	request: Request,
	limit: number,
): Promise<string | undefined> {
	const declared = request.headers.get("content-length");
	if (declared !== null && Number(declared) > limit) return undefined;
	const reader = request.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const part = await reader.read();
		if (part.done) break;
		size += part.value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => undefined);
			return undefined;
		}
		chunks.push(part.value);
	}
	const joined = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(joined);
	} catch {
		return undefined;
	}
}
