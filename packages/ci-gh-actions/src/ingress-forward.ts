import { createHmac, timingSafeEqual } from "node:crypto";

const prefix = "sha256=";

/** HMAC-SHA256 over the exact webhook bytes for ingress-to-relay forwarding. */
export function signIngressForward(
	secret: string,
	body: Buffer,
): string {
	if (Buffer.byteLength(secret, "utf8") < 32)
		throw new Error("ingress forward secret too short");
	return `${prefix}${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyIngressForward(
	secret: string,
	body: Buffer,
	signature: string | undefined,
): boolean {
	if (!signature || Buffer.byteLength(secret, "utf8") < 32) return false;
	if (!signature.startsWith(prefix)) return false;
	const expected = createHmac("sha256", secret).update(body).digest("hex");
	const actual = signature.slice(prefix.length);
	if (actual.length !== 64 || !/^[a-f0-9]+$/.test(actual)) return false;
	try {
		return timingSafeEqual(
			Buffer.from(expected, "hex"),
			Buffer.from(actual, "hex"),
		);
	} catch {
		return false;
	}
}
