/**
 * `redactProviderText` as it stood on the base branch (169d87fcf819), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand; do not import it from src.
 */

/** Shapes that must never survive into an error message, log line, or receipt. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	// The claim URL carries its session material in the fragment, so the
	// fragment has to go with it.
	/https?:\/\/[^\s"']*app\.netlify\.com\/claim\S*/giu,
	/\bBearer\s+\S+/giu,
	// nfp_… is Netlify's personal access token prefix; nf_ covers session ids.
	/\bnf(?:p)?_[A-Za-z0-9]{8,}/giu,
	// A database URL with inline credentials. CLI and build output carries
	// `DATABASE_URL` more often than it carries anything Netlify-shaped, and
	// the password sits in the authority section where no other pattern looks.
	/\b[a-z][a-z0-9+.-]*:\/\/[^\s"':/@]+:[^\s"'/@]+@\S+/giu,
	// The key name may be prefixed (`NETLIFY_AUTH_TOKEN`), and `_` is a word
	// character, so a leading \b would not match. Anchor on the separator
	// instead and let the prefix be anything non-spacing.
	/[A-Za-z0-9_-]*(?:access[_-]?token|auth[_-]?token|api[_-]?key|secret[_-]?key|session[_-]?id)\s*[=:]\s*\S+/giu,
	/[A-Za-z0-9_-]*(?:password|passwd|pwd)\s*[=:]\s*\S+/giu,
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
 * characters, which CLI output has plenty of and which can otherwise forge a
 * log record.
 */
export function redactProviderText(text: string, maxLength = 256): string {
	let out = text;
	for (const pattern of CREDENTIAL_PATTERNS)
		out = out.replace(pattern, "[redacted]");
	out = flattenControlChars(out)
		.replace(/\s{2,}/gu, " ")
		.trim();
	return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
