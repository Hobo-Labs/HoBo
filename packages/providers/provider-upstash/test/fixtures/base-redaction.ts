/**
 * `redactProviderText` as it stood on the base branch (9d3fe8c2d723), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand; do not import it from src.
 */

/**
 * Shapes that must never survive into a message, a log line, or a receipt.
 *
 * The generic opaque-blob rule is the important one: Upstash REST tokens are
 * long base64url strings with no fixed prefix to match on, so the rule is
 * structural — any unbroken run of 40+ token characters is treated as
 * credential material. Native UUIDs are also bearer capabilities and are
 * removed independently, including percent-encoded forms.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/https?:\/\/console\.upstash\.com\/redis\/\S+/giu,
	/\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/giu,
	/\*\*\s*Token\s*:?\s*\*\*\s*\S+/giu,
	/\bBearer\s+\S+/giu,
	/\bUPSTASH_REDIS_REST_TOKEN\s*[=:]\s*\S+/giu,
	/\b(?:token|password|pwd)\s*[=:]\s*\S+/giu,
	/\brediss?:\/\/\S+/giu,
	/[A-Za-z0-9_-]{40,}/gu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu,
];

function flattenControlChars(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		out += code <= 31 || code === 127 ? " " : ch;
	}
	return out;
}

/**
 * Replace anything credential-shaped with a marker and flatten control
 * characters so provider text cannot forge a log record.
 */
export function redactProviderText(text: string, maxLength = 256): string {
	let out = text;
	for (;;) {
		const decoded = out.replace(/%[a-f0-9]{2}/giu, (encoded) =>
			String.fromCharCode(Number.parseInt(encoded.slice(1), 16)),
		);
		if (decoded === out) break;
		out = decoded;
	}
	for (const pattern of CREDENTIAL_PATTERNS)
		out = out.replace(pattern, "[redacted]");
	out = flattenControlChars(out)
		.replace(/\s{2,}/gu, " ")
		.trim();
	return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
