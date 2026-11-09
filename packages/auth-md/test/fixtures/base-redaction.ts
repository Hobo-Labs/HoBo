/**
 * `redactText` as it stood on the base branch (169d87fcf819), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand but for one name the lint
 * refuses (`SECRET_SHAPED_PATTERNS`); do not import it from src.
 */

/**
 * Redaction primitives.
 *
 * Two complementary mechanisms, because either one alone leaks:
 *
 * 1. `SensitiveRef` — material is held in a module-private `WeakMap` keyed by
 *    the reference object, so the value is not a property of anything that
 *    `JSON.stringify`, a structured logger, or a debugger inspection can
 *    reach. Only `discloseSensitive` can read it, and only holders of the ref.
 * 2. `redactDeep` / `formatRedacted` — a defence-in-depth scrubber for values
 *    assembled elsewhere (raw provider payloads, error details) that removes
 *    secret-named fields and secret-shaped strings before they are serialized.
 */

// public-contract: callers and tests assert on this exact placeholder in serialized output.
const REDACTED = "[redacted]";

const SECRET_TEXT_PATTERNS: readonly RegExp[] = [
	// Compact JWS/JWT: three base64url segments.
	/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/gu,
	// PEM blocks of any key type.
	/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/gu,
	// `Bearer <token>` in prose or headers.
	/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/giu,
	// Long opaque high-entropy handles (claim/access tokens).
	/\b[A-Za-z0-9_-]{40,}\b/gu,
];

/** Scrub secret-shaped substrings out of a free-text string. */
export function redactText(value: string): string {
	let output = value;
	for (const pattern of SECRET_TEXT_PATTERNS) {
		output = output.replace(pattern, REDACTED);
	}
	return output;
}
