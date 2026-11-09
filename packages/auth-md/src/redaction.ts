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

import {
	JWT_PATTERN,
	PRIVATE_KEY_PATTERN,
	type RedactionPattern,
	redactionPattern,
	redactMatches,
} from "@hobo/provider-redaction";

// public-contract: callers and tests assert on this exact placeholder in serialized output.
export const REDACTED = "[redacted]";

export type SensitiveKind =
	| "agent-private-key"
	| "identity-assertion"
	| "claim-token"
	| "access-token";

/** Opaque locator for material held outside the process boundary. */
export type MaterialLocator = string & {
	readonly __brand: "MaterialLocator";
};

const LOCATOR_PATTERN = /^authmd-secret:\/\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/u;

export function materialLocator(
	kind: SensitiveKind,
	handle: string,
): MaterialLocator {
	const candidate = `authmd-secret://${kind}/${handle}`;
	if (!LOCATOR_PATTERN.test(candidate)) {
		throw new Error(`invalid material locator handle: ${handle}`);
	}
	// SAFETY: the candidate matched LOCATOR_PATTERN, the brand's only invariant.
	return candidate as MaterialLocator;
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- SAFETY: a type guard over a value nobody has parsed is the parse. */
export function isMaterialLocator(value: unknown): value is MaterialLocator {
	return typeof value === "string" && LOCATOR_PATTERN.test(value);
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

/**
 * A handle to secret material. Serializing it yields `"[redacted]"`; the
 * material itself is never a own-property of this object.
 */
export interface SensitiveRef<Kind extends SensitiveKind = SensitiveKind> {
	readonly kind: Kind;
	readonly locator: MaterialLocator;
	readonly redacted: typeof REDACTED;
	toJSON(): typeof REDACTED;
	toString(): string;
}

const vault = new WeakMap<object, string>();
// Identity is tracked separately from material: a forgotten (rotated-away)
// reference must still redact, even though it can no longer disclose.
const sensitiveRefs = new WeakSet<object>();

export function createSensitive<Kind extends SensitiveKind>(
	kind: Kind,
	material: string,
	handle: string,
): SensitiveRef<Kind> {
	const ref: SensitiveRef<Kind> = Object.freeze({
		kind,
		locator: materialLocator(kind, handle),
		redacted: REDACTED,
		toJSON: () => REDACTED,
		toString: () => REDACTED,
	});
	vault.set(ref, material);
	sensitiveRefs.add(ref);
	return ref;
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- SAFETY: a type guard over a value nobody has parsed is the parse. */
export function isSensitiveRef(value: unknown): value is SensitiveRef {
	return (
		typeof value === "object" && value !== null && sensitiveRefs.has(value)
	);
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

/**
 * Read the material behind a reference. Only mediated ports (verifier,
 * rotation, transport) call this; nothing that returns to a caller does.
 */
export function discloseSensitive(ref: SensitiveRef): string {
	const material = vault.get(ref);
	if (material === undefined) {
		throw new Error("sensitive material is not available for this reference");
	}
	return material;
}

/** Forget the material while keeping the (now inert) reference identity. */
export function forgetSensitive(ref: SensitiveRef): void {
	vault.delete(ref);
}

export const SECRET_KEY_PATTERN =
	/(assertion|token|secret|password|passphrase|credential|private[_-]?key|authorization|client[_-]?secret|jwk|jwt)/i;

export const SECRET_TEXT_PATTERNS: readonly RedactionPattern[] = [
	// PEM blocks of any key type, from `@hobo/provider-redaction`: to the
	// key's own END line, or the next BEGIN, or the end of the text. The lazy
	// `[\s\S]*?-----END` this replaced searched from every BEGIN for an END.
	PRIVATE_KEY_PATTERN,
	// Compact JWS/JWT, the shared linear pattern: an `ey` header and two dots.
	JWT_PATTERN,
	// The same shape with this module's shorter segments (`eyJ` and four
	// characters each). Like the shared one it starts only where a run of
	// base64url characters starts and reads that run once, where `\beyJ…`
	// started again at every `eyJ` and read to the end. It ends with the
	// signature's run and no `\b`: a `\b` the signature could fail (one ending
	// in `-`) sent the search back to the next `eyJ`, quadratic again.
	redactionPattern(
		/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4})(?<lead>(?:[A-Za-z0-9_]*-)*?)eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/gu,
	),
	// `Bearer <token>` in prose or headers.
	redactionPattern(/\bBearer\s+[\u017F\u212AA-Za-z0-9._~+/-]{8,}=*/gi),
	// Long opaque high-entropy handles (claim/access tokens).
	redactionPattern(/\b[A-Za-z0-9_-]{40,}\b/gu),
];

/** Scrub secret-shaped substrings out of a free-text string. */
export function redactText(value: string): string {
	// Every pattern over the same text: replaced in turn, a private key taken
	// first left a 40-character handle before it too short for the last one.
	return redactMatches(value, SECRET_TEXT_PATTERNS);
}

/**
 * Structurally redact a value: sensitive refs collapse to `"[redacted]"`,
 * secret-named fields are replaced, and remaining strings are text-scrubbed.
 */
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- SAFETY: redactDeep and formatRedacted take whatever value a caller is about to log or serialize, the one boundary where looking at a value's representation is the job. */
export function redactDeep(
	value: unknown,
	seen = new WeakSet<object>(),
): unknown {
	if (typeof value === "string") return redactText(value);
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "undefined"
	) {
		return value;
	}
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function") return REDACTED;
	if (typeof value !== "object") return REDACTED;

	if (isSensitiveRef(value)) return REDACTED;
	if (seen.has(value)) return "[circular]";
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((entry) => redactDeep(entry, seen));
	}
	if (value instanceof Error) {
		return redactDeep({ name: value.name, message: value.message }, seen);
	}

	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		output[key] = SECRET_KEY_PATTERN.test(key)
			? REDACTED
			: redactDeep(entry, seen);
	}
	return output;
}

/** The formatter every logging/serialization path in this package must use. */
export function formatRedacted(value: unknown): string {
	return JSON.stringify(redactDeep(value));
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening */
