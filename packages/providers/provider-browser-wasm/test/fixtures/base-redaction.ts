/**
 * `redactHostText` as it stood on the base branch (9d3fe8c2d723), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand; do not import it from src.
 */

/** Shapes that must never survive into a message, console line, or receipt. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/\bBearer\s+\S+/giu,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
	// The usual way a secret reaches a browser: in the URL.
	/\b(?:access_token|id_token|session|api[_-]?key|token)=[^&\s"']+/giu,
	/\b(?:sk|pk)[-_][A-Za-z0-9_-]{8,}/gu,
];

function flattenControlChars(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		out += code <= 31 || code === 127 ? " " : ch;
	}
	return out;
}

export function redactHostText(text: string, maxLength = 256): string {
	let out = text;
	for (const pattern of CREDENTIAL_PATTERNS) {
		out = out.replace(pattern, "[redacted]");
	}
	out = flattenControlChars(out).trim();
	return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
