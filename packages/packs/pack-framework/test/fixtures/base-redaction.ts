/**
 * `redactPackText` as it stood on the base branch (9d3fe8c2d723), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand; do not import it from src.
 */

/** Shapes that must never survive into a message, a log line, or a receipt. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/postgres(?:ql)?:\/\/\S+/giu,
	/rediss?:\/\/\S+/giu,
	/\bBearer\s+\S+/giu,
	/\b(?:password|pgpassword|requirepass|pwd)\s*[=:]\s*\S+/giu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu,
];

function stripControlChars(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		out += code <= 0x1f || code === 0x7f ? " " : text[i];
	}
	return out;
}

/**
 * Redact credential-shaped substrings and flatten control characters.
 *
 * A container runtime echoes back the command line it was handed, so text from
 * a pack operation is exactly the text most likely to carry a credential.
 */
export function redactPackText(text: string, maxLength = 256): string {
	let out = text;
	for (const pattern of CREDENTIAL_PATTERNS)
		out = out.replace(pattern, "[redacted]");
	out = stripControlChars(out).trim();
	return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
