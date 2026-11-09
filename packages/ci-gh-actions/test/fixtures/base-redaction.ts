/**
 * `redactSecrets` as it stood on the base branch (169d87fcf819), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand; do not import it from src.
 */

/** Shapes that are credentials, never references. Never echo the match. */
const SECRET_PATTERNS: readonly RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bdepot_(?:project|org|user)_[A-Za-z0-9]{16,}\b/g,
	/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
	/\b(?:boat|bsm|jog)_[A-Za-z0-9]{20,}\b/g,
];

function entropy(value: string): number {
	const counts = new Map<string, number>();
	for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;
	for (const count of counts.values()) {
		const p = count / value.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

const OPAQUE_RUN = /[A-Za-z0-9+_=-]{32,}/g;
const DIGEST = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function opaqueCredential(run: string): boolean {
	return (
		!DIGEST.test(run) &&
		/[0-9]/.test(run) &&
		/[a-z]/.test(run) &&
		/[A-Z]/.test(run) &&
		entropy(run) >= 4
	);
}

/** Remove credential-shaped substrings and any explicitly known secret values. */
export function redactSecrets(
	text: string,
	known: readonly string[] = [],
): string {
	let out = text;
	for (const secret of known)
		if (secret.length >= 8) out = out.split(secret).join("[REDACTED]");
	for (const pattern of SECRET_PATTERNS)
		out = out.replace(pattern, "[REDACTED]");
	return out.replace(OPAQUE_RUN, (run) =>
		opaqueCredential(run) ? "[REDACTED]" : run,
	);
}
