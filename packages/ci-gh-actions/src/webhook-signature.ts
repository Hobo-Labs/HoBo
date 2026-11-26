import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE = /^sha256=[a-f0-9]{64}$/;

/** `sha256=<hex>` HMAC-SHA256 over the exact body bytes, as GitHub signs a delivery. */
export function signWebhookBody(secret: string, body: Uint8Array): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * The one check of a `sha256=<hex>` body signature. `malformed` is a header
 * that is absent or not a signature at all; `mismatch` is a well-formed
 * signature made with another secret or over other bytes.
 */
export function verifyWebhookSignature(
	secret: string,
	body: Uint8Array,
	signature: string | undefined,
): "valid" | "malformed" | "mismatch" {
	if (signature === undefined || !SIGNATURE.test(signature)) return "malformed";
	const expected = createHmac("sha256", secret).update(body).digest();
	return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"))
		? "valid"
		: "mismatch";
}
