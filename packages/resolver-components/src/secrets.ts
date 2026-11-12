// The secret scanner (I9). The host is the only party that ever holds
// credential material for a call: it resolves the locator, attaches the
// result to allowlisted requests, and then scans everything that crosses back
// out — upstream responses before the component sees them (redacted), and
// every request, log line and result the component produces (refused). The
// scanner knows the exact values injected for this call, so it looks for
// those values and their common encodings rather than guessing at shapes.

// public-contract: the placeholder written in place of credential material.
export const REDACTED = "[REDACTED]";

/** Values shorter than this are not scanned for (they would match noise). */
const MIN_SECRET_LENGTH = 4;
/** Encoded cores shorter than this are not matched inside larger blobs. */
const MIN_CORE_LENGTH = 8;
/** Authorization scheme words are not material on their own. */
const AUTH_SCHEME = /^(?:bearer|basic|digest|token|dpop|apikey|key)$/iu;

export interface SecretScanner {
	/** True when no material is known (nothing was injected). */
	readonly empty: boolean;
	/** Does `text` carry any injected value, in any recognised encoding? */
	find(text: string): boolean;
	/** `text` with every recognised occurrence replaced by REDACTED. */
	redact(text: string): string;
}

/**
 * Build a scanner over the material injected for one call. A header value
 * such as `Bearer abc` contributes both the full value and its token part.
 */
export function createSecretScanner(material: readonly string[]): SecretScanner {
	const needles = new Set<string>();
	for (const value of material) {
		for (const part of [value, ...value.split(/\s+/u)]) {
			if (part.length < MIN_SECRET_LENGTH || AUTH_SCHEME.test(part)) continue;
			for (const variant of variants(part)) {
				if (variant.length >= MIN_SECRET_LENGTH) needles.add(variant);
			}
		}
	}
	// Longest first, so redaction removes a full header before its token part.
	const ordered = [...needles].sort((left, right) => right.length - left.length);
	return Object.freeze({
		empty: ordered.length === 0,
		find(text: string): boolean {
			if (ordered.length === 0 || text.length === 0) return false;
			const lower = text.toLowerCase();
			return ordered.some(
				(needle) => text.includes(needle) || lower.includes(needle.toLowerCase()),
			);
		},
		redact(text: string): string {
			let out = text;
			for (const needle of ordered) {
				out = replaceInsensitive(out, needle);
			}
			return out;
		},
	});
}

function variants(value: string): readonly string[] {
	const bytes = Buffer.from(value, "utf8");
	const out = [
		value,
		[...value].reverse().join(""),
		encodeURIComponent(value),
		JSON.stringify(value).slice(1, -1),
		bytes.toString("hex"),
	];
	// base64 / base64url at the three byte alignments, so the value is found
	// inside a larger encoded blob: drop the edge characters a neighbour byte
	// would change and keep the stable core.
	for (const offset of [0, 1, 2]) {
		const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
		for (const encoding of ["base64", "base64url"] as const) {
			const encoded = padded.toString(encoding).replace(/=+$/u, "");
			const start = offset === 0 ? 0 : 4;
			const core = encoded.slice(start, Math.max(start, encoded.length - 4));
			if (offset === 0) out.push(encoded);
			if (core.length >= MIN_CORE_LENGTH) out.push(core);
		}
	}
	return out;
}

function replaceInsensitive(text: string, needle: string): string {
	const lowerNeedle = needle.toLowerCase();
	let out = "";
	let cursor = 0;
	const lower = text.toLowerCase();
	for (;;) {
		const at = lower.indexOf(lowerNeedle, cursor);
		if (at < 0) break;
		out += text.slice(cursor, at) + REDACTED;
		cursor = at + needle.length;
	}
	return out + text.slice(cursor);
}
