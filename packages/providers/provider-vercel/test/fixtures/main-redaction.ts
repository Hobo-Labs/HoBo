/**
 * `redactProviderText` as it stood on main (382e9a982df8), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand; do not import it from src.
 */

/** Shapes that must never survive into an error message, log line, or receipt. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	// Prisma Postgres hands out prisma+postgres://…?api_key=… as well as a
	// direct postgres:// string, so both shapes are stripped.
	/prisma\+postgres:\/\/\S+/giu,
	/postgres(?:ql)?:\/\/\S+/giu,
	/\bapi[_-]?key\s*[=:]\s*\S+/giu,
	/\bBearer\s+\S+/giu,
	/\b(?:password|pgpassword|pwd)\s*[=:]\s*\S+/giu,
	// Vercel claim/transfer codes are bearer authority on this path.
	/\bcode\s*[=:]\s*[A-Za-z0-9-]{8,}/giu,
	/\b(?:sk|pk)[-_][A-Za-z0-9_-]{8,}/giu,
	/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.\S*/giu,
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
	for (const pattern of CREDENTIAL_PATTERNS)
		out = out.replace(pattern, "[redacted]");
	out = flattenControlChars(out).trim();
	return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
