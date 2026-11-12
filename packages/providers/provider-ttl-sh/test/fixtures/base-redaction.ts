/**
 * `redactProviderText` as it stood on the base branch (9d3fe8c2d723), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand; do not import it from src.
 */

/**
 * A digest is the artifact's identity, not a secret, and neither is the
 * content-addressed name derived from it. Both are masked out before the credential
 * rules run and restored afterwards.
 */
const DIGEST_PATTERN = /\bsha(?:256|512)[:-][0-9a-f]{32,128}\b/giu;

const DIGEST_PLACEHOLDER = "\u0001DIGEST\u0002";

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/\b(?:Bearer|Basic)\s+\S+/giu,
	/\b(?:password|passwd|token|secret|auth)\s*[=:]\s*\S+/giu,
	/\b(?:sk|pk|ghp|gho|ghs|glpat)[-_][A-Za-z0-9_-]{8,}/giu,
	/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/giu,
	/\/\/[^/\s:@]+:[^/\s:@]+@/giu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/giu,
	// A long opaque run with no recognisable prefix, for credential formats nobody
	// has catalogued yet. Deliberately excludes `/` and `.`, so a URL path is not
	// mistaken for one long token — the identifiers worth keeping (digests,
	// content-addressed names) are masked out above, but a redaction that ate every
	// registry path would make the error messages useless.
	/\b[A-Za-z0-9+_-]{40,}={0,2}\b/gu,
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
 * Redact credential-shaped material and flatten control characters.
 *
 * Digests survive: they identify the artifact, they appear in every receipt, and a
 * redaction that ate them would make the audit trail useless.
 */
export function redactProviderText(text: string, maxLength = 256): string {
	const digests: string[] = [];
	let out = text.replace(DIGEST_PATTERN, (match) => {
		digests.push(match);
		return DIGEST_PLACEHOLDER;
	});
	for (const pattern of CREDENTIAL_PATTERNS)
		out = out.replace(pattern, "[redacted]");
	let index = 0;
	out = out.replace(
		new RegExp(DIGEST_PLACEHOLDER, "gu"),
		() => digests[index++] ?? "",
	);
	out = flattenControlChars(out).trim();
	return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
