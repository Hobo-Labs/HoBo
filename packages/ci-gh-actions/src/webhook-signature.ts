import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE = /^sha256=[a-f0-9]{64}$/;

export function signWebhookBody(secret: string, body: Uint8Array): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

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
