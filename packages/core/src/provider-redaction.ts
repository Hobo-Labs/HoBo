/**
 * The one redactor for provider text: an API error body, CLI output, an
 * apiserver Status, a host fault. Every provider package that puts such text in
 * an error message, a log line, or a receipt redacts it here, through
 * `redactProviderText` or a redactor `createProviderRedactor` builds from a
 * profile of its own shapes, so the shapes and the bounds below exist once.
 *
 * The text is hostile: a body is whatever the other end sent, and the error
 * path is the one place it is read whole. So every shape here is linear in the
 * text (none can start again inside a run it has already scanned to its end),
 * only a window of the text is searched, and a longer text is marked cut.
 *
 * Reached through the `@hobo/core/provider-redaction` subpath, not the package
 * root: the flagship surface is provider-neutral, and this module names
 * provider credential shapes.
 */

/** What a redacted span becomes. */
export const REDACTION_MARKER = "[redacted]";

/** The mark a cut text ends with. */
export const CUT_MARKER = "…";

/**
 * How much of a text the shapes are searched in: its first REDACTION_WINDOW
 * characters, or four times `maxLength` when that is more, and the rest of the
 * run of non-whitespace that cut falls in (`windowOf`). An error message is cut
 * far shorter than this, so a longer text only costs time: a hostile body of a
 * megabyte with whitespace in it is searched no further than this, and one
 * without is searched in linear time.
 */
export const REDACTION_WINDOW = 8192;

declare const redactionPatternBrand: unique symbol;

/**
 * A pattern parsed for use as a redaction shape: global, so every occurrence is
 * replaced, and not sticky, so a match is looked for anywhere. A shape must
 * also be linear in the text; that is a property of how it is written, which a
 * parse cannot see, so each shape here has a 1 MB adversarial test.
 */
export type RedactionPattern = RegExp & {
	readonly [redactionPatternBrand]: true;
};

export class RedactionPatternError extends Error {
	readonly code = "REDACTION_PATTERN_INVALID" as const;

	constructor(source: string, reason: string) {
		super(`redaction pattern /${source}/ ${reason}`);
		this.name = "RedactionPatternError";
	}
}

function isPattern(pattern: RegExp): pattern is RedactionPattern {
	return pattern.global && !pattern.sticky;
}

/** Parse a pattern into a redaction shape, or refuse it. */
export function redactionPattern(pattern: RegExp): RedactionPattern {
	if (!isPattern(pattern)) {
		throw new RedactionPatternError(
			pattern.source,
			pattern.sticky
				? "is sticky, so it would match only where the last match ended"
				: "is not global, so it would redact only the first occurrence",
		);
	}
	return pattern;
}

/**
 * A private key, from its BEGIN line to its own END line (another END line,
 * such as a certificate's, inside it does not end it), or to the next BEGIN
 * line, or to the end of the text when there is neither (as when the text was
 * cut inside the key): never a search from every BEGIN to the end. A label is
 * anything up to the next `-` (`RSA`, `ENCRYPTED`, `OPENSSH`, one with a
 * digit), so it is read once from each marker. The END line is looked for only
 * where `-----END` starts.
 */
export const PRIVATE_KEY_PATTERN = redactionPattern(
	/-----BEGIN[^-]*PRIVATE KEY-----(?:(?!-----BEGIN|-----END[^-]*PRIVATE KEY-----)[\s\S])*(?:-----END[^-]*PRIVATE KEY-----)?/giu,
);

/**
 * A compact JWS: `ey…` header, a dot, a payload, a dot, and the signature to
 * the next whitespace. The header starts at a word boundary, which inside a run
 * of base64url characters is only after a `-`.
 *
 * The match starts only where a run of base64url characters starts, and the
 * lookahead reads that run and the payload's once, so `-ey-ey-ey…` is one
 * search, not one from every `ey` to the end. Once the lookahead holds, the
 * first `ey` in the run with eight characters after it matches, because every
 * `ey` in a run reads to the same dot. So a JWT after a `-` is still found (the
 * run start was the only way to keep the search linear, and a lookbehind on a
 * base64url character alone would have lost it), and the run's start before the
 * `-` goes with it.
 */
export const JWT_PATTERN = redactionPattern(
	/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.)(?:[A-Za-z0-9_]*-)*?ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.\S*/giu,
);

/**
 * Shapes every provider shares, in the order they are searched (the private
 * key first: it is the one shape that spans whitespace, and another shape
 * matching inside it would leave the rest of it behind).
 */
export const CREDENTIAL_PATTERNS: readonly RedactionPattern[] = Object.freeze([
	PRIVATE_KEY_PATTERN,
	JWT_PATTERN,
	redactionPattern(/\bBearer\s+\S+/giu),
	// Connection strings, whole: the password sits in the authority section,
	// and Prisma Postgres hands out prisma+postgres://…?api_key=….
	redactionPattern(/(?:prisma\+)?postgres(?:ql)?:\/\/\S+/giu),
	redactionPattern(/\brediss?:\/\/\S+/giu),
	redactionPattern(/\b(?:mysql|mongodb(?:\+srv)?|amqps?):\/\/\S+/giu),
	// Any other URL with inline credentials, whole. The scheme starts only where
	// a run of scheme characters starts, so `a.a.a.…` is one search.
	redactionPattern(
		/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"':/@]+:[^\s"'/@]+@\S+/giu,
	),
	// Inline credentials with no scheme in front of them.
	redactionPattern(/\/\/[^/\s:@]+:[^/\s:@]+@/gu),
	// A secret-named key and its value. The name may be prefixed
	// (`NETLIFY_AUTH_TOKEN`, `pgpassword`, `x-api-key`), so the match starts
	// where a run of name characters starts and reads it once. Quotes and
	// markdown emphasis around the separator (`"token": "…"`, `**Token:** …`)
	// do not stand in for the value.
	redactionPattern(
		/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]*(?:token|secret|auth|session|password|passwd|pwd|requirepass|api[_-]?key|secret[_-]?key|session[_-]?id)["'*]*\s*[=:][\s"'*]*[^\s"'*]\S*/giu,
	),
	// Prefixed keys: Stripe-style sk_/pk_, GitHub, GitLab, Slack.
	redactionPattern(
		/\b(?:sk|pk|ghp|gho|ghs|glpat|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/giu,
	),
]);

/**
 * Detectors for a refusal rather than a redaction (`.test`, no `g`, so they
 * carry no `lastIndex` between calls): the same linear shapes, for guards that
 * refuse a payload holding one.
 */
export const JWT_DETECTOR: RegExp =
	/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.)(?:[A-Za-z0-9_]*-)*?ey[A-Za-z0-9_-]{8,}\./iu;

/** A private key's BEGIN line. */
export const PRIVATE_KEY_DETECTOR: RegExp = /-----BEGIN[^-]*PRIVATE KEY-----/u;

/**
 * `text` cut at `window` characters, or, when that cut falls inside a run of
 * non-whitespace, at the end of that run. Every shape but the private key ends
 * at whitespace, so none is cut through and a credential leaves nothing behind;
 * a private key cut after its BEGIN line is redacted to the end of what is
 * searched. A long body with no whitespace, such as compact JSON, is then
 * searched whole (the shapes are linear in it), and its start is still shown,
 * redacted.
 */
export function windowOf(text: string, window: number): string {
	if (text.length <= window) return text;
	const whitespace = /\s/gu;
	whitespace.lastIndex = window;
	const next = whitespace.exec(text);
	return next === null ? text : text.slice(0, next.index);
}

function isControl(code: number): boolean {
	return code <= 31 || code === 127;
}

/**
 * Each C0 control character and DEL as a space. Copied a stretch at a time,
 * not a character at a time: a text searched whole can be a megabyte.
 */
export function flattenControlChars(text: string): string {
	let out = "";
	let from = 0;
	for (let index = 0; index < text.length; index++) {
		if (isControl(text.charCodeAt(index))) {
			out += `${text.slice(from, index)} `;
			from = index + 1;
		}
	}
	return from === 0 ? text : out + text.slice(from);
}

export function containsControlChar(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		if (isControl(text.charCodeAt(index))) return true;
	}
	return false;
}

function isHexDigit(unit: string | undefined): boolean {
	return unit !== undefined && /^[0-9a-f]$/iu.test(unit);
}

/**
 * Percent-decoding repeated until nothing decodes, in one pass. Decoding the
 * whole text again until it stops changing undoes one layer of `%25` a pass,
 * so `%2525…41` took a pass per layer: quadratic. Here each `%hh` is decoded as
 * soon as its last digit is read, and what it decodes to is checked against
 * the two units before it. `%hh` sequences never overlap, so the order they are
 * decoded in does not change the result: it is the same text.
 */
export function decodePercentFully(text: string): string {
	if (!text.includes("%")) return text;
	const units: string[] = [];
	for (let index = 0; index < text.length; index++) {
		units.push(text.charAt(index));
		for (;;) {
			const length = units.length;
			const high = units[length - 2];
			const low = units[length - 1];
			if (
				length < 3 ||
				units[length - 3] !== "%" ||
				!isHexDigit(high) ||
				!isHexDigit(low)
			)
				break;
			units.length = length - 3;
			units.push(String.fromCharCode(Number.parseInt(`${high}${low}`, 16)));
		}
	}
	return units.join("");
}

/** What one provider adds to the shared redaction. */
export type ProviderRedactionProfile = {
	/**
	 * The provider's own shapes, searched after the private key and before the
	 * other shared shapes.
	 */
	readonly patterns?: readonly RegExp[];
	/**
	 * Spans that are kept whole, never redacted (an artifact's digest identifies
	 * it, and appears in every receipt). Searched before any shape.
	 */
	readonly keep?: RegExp;
	/** Percent-decode the text fully before it is searched. */
	readonly decodePercent?: boolean;
	/** Collapse runs of whitespace (CLI output has plenty) to one space. */
	readonly collapseWhitespace?: boolean;
};

/** Redact a provider text and cut it to `maxLength` (256 by default). */
export type ProviderTextRedactor = (text: string, maxLength?: number) => string;

type ParsedProfile = {
	readonly patterns: readonly RedactionPattern[];
	readonly keep: RedactionPattern | undefined;
	readonly decodePercent: boolean;
	readonly collapseWhitespace: boolean;
};

function parseProfile(profile: ProviderRedactionProfile): ParsedProfile {
	return {
		// The private key first, then the provider's shapes: a shape written for
		// one provider's format knows where its credential ends, and a shared
		// shape that matched inside it first would leave the rest behind.
		patterns: Object.freeze([
			PRIVATE_KEY_PATTERN,
			...(profile.patterns ?? []).map(redactionPattern),
			...CREDENTIAL_PATTERNS.filter(
				(pattern) => pattern !== PRIVATE_KEY_PATTERN,
			),
		]),
		keep:
			profile.keep === undefined ? undefined : redactionPattern(profile.keep),
		decodePercent: profile.decodePercent ?? false,
		collapseWhitespace: profile.collapseWhitespace ?? false,
	};
}

// A kept span is held out of the search behind a private-use placeholder that
// names its index. The placeholder breaks a run, so no shape reads through it;
// a shape that swallows one anyway drops that span, which is the safe failure.
const KEEP_OPEN = String.fromCharCode(0xe000);
const KEEP_CLOSE = String.fromCharCode(0xe001);
const KEEP_SLOT = new RegExp(`${KEEP_OPEN}(\\d+)${KEEP_CLOSE}`, "gu");
const KEEP_DELIMITERS = new RegExp(`[${KEEP_OPEN}${KEEP_CLOSE}]`, "gu");
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

function redactKeeping(
	text: string,
	keep: RedactionPattern,
	patterns: readonly RedactionPattern[],
): string {
	const kept: string[] = [];
	let out = text
		.replace(KEEP_DELIMITERS, REPLACEMENT_CHARACTER)
		.replace(keep, (span) => `${KEEP_OPEN}${kept.push(span) - 1}${KEEP_CLOSE}`);
	for (const pattern of patterns) out = out.replace(pattern, REDACTION_MARKER);
	return out.replace(
		KEEP_SLOT,
		(_slot, index: string) => kept[Number(index)] ?? "",
	);
}

/**
 * A redactor for one provider: the shared shapes and the profile's. Replace
 * anything credential-shaped with REDACTION_MARKER and flatten control
 * characters so provider text cannot forge a log record. Only the window
 * (REDACTION_WINDOW) is searched and kept; a text longer than it is marked cut.
 */
export function createProviderRedactor(
	profile: ProviderRedactionProfile = {},
): ProviderTextRedactor {
	const parsed = parseProfile(profile);
	return (text, maxLength = 256) => {
		const decoded = parsed.decodePercent ? decodePercentFully(text) : text;
		const searched = windowOf(
			decoded,
			Math.max(REDACTION_WINDOW, 4 * maxLength),
		);
		let out: string;
		if (parsed.keep === undefined) {
			out = searched;
			for (const pattern of parsed.patterns)
				out = out.replace(pattern, REDACTION_MARKER);
		} else {
			out = redactKeeping(searched, parsed.keep, parsed.patterns);
		}
		out = flattenControlChars(out);
		if (parsed.collapseWhitespace) out = out.replace(/\s{2,}/gu, " ");
		out = out.trim();
		return out.length > maxLength || searched.length < decoded.length
			? `${out.slice(0, maxLength)}${CUT_MARKER}`
			: out;
	};
}

/** The shared shapes alone. */
export const redactProviderText: ProviderTextRedactor =
	createProviderRedactor();
