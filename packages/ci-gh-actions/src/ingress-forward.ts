import {
	signWebhookBody,
	verifyWebhookSignature,
} from "./webhook-signature.js";

/** HMAC-SHA256 over the exact webhook bytes for ingress-to-relay forwarding. */
export function signIngressForward(secret: string, body: Buffer): string {
	if (Buffer.byteLength(secret, "utf8") < 32)
		throw new Error("ingress forward secret too short");
	return signWebhookBody(secret, body);
}

export function verifyIngressForward(
	secret: string,
	body: Uint8Array,
	signature: string | undefined,
): boolean {
	if (Buffer.byteLength(secret, "utf8") < 32) return false;
	return verifyWebhookSignature(secret, body, signature) === "valid";
}
