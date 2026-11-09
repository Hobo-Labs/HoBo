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
 * parse cannot see, so each shape here has a growth test on an adversarial
 * input (`@hobo/core/linear-time`).
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
 * A private key, from its BEGIN line to the last END line before the next
 * BEGIN line, when that END line starts a line: after whitespace, the start of
 * the text, or an escaped `\n` or `\r` (a key inside a JSON string). Otherwise
 * (no END line, as when the text was cut inside the key, or a last one glued
 * to the text before it, `…abc-----END PRIVATE KEY-----`) to the next BEGIN
 * line or the end of the text. An END line inside a key, such as a
 * certificate's, or one another shape's match ran over, does not end it. The rest of the END
 * line's run goes with it (`-----END PRIVATE KEY-----npg_…`). A label is
 * anything up to the next `-` (`RSA`, `ENCRYPTED`, `OPENSSH`, one with a
 * digit). Each BEGIN reads on to the next BEGIN once, and back over it once,
 * trying each END line once and reading from it only to the next: never a
 * search from every BEGIN to the end.
 */
export const PRIVATE_KEY_PATTERN = redactionPattern(
	/-----BEGIN[^-]*PRIVATE KEY-----(?:(?:(?!-----BEGIN)[\s\S])*(?:(?<!\S)|(?<=\\[nr]))-----END[^-]*PRIVATE KEY-----\S*(?=(?:(?!-----BEGIN|-----END)[\s\S])*(?:-----BEGIN|$))|(?:(?!-----BEGIN)[\s\S])*)/giu,
);

/**
 * A compact JWS: an `ey…` header of ten characters or more, a dot, a payload of
 * ten or more, a dot, and the signature to the next whitespace (the minimums
 * the provider copies this replaces used). The header starts at a word
 * boundary, which inside a run of base64url characters is only after a `-`.
 *
 * The match starts only where a run of base64url characters starts, and the
 * lookahead reads that run and the payload's once, so `-ey-ey-ey…` is one
 * search, not one from every `ey` to the end. Once the lookahead holds, the
 * first `ey` in the run with ten characters after it matches, because every
 * `ey` in a run reads to the same dot. So a JWT after a `-` is still found, and
 * the run's start before the `-` goes with it.
 */
export const JWT_PATTERN = redactionPattern(
	/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}\.)(?:[A-Za-z0-9_]*-)*?ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.\S*/giu,
);

/**
 * A compact JWS with a JSON header, `eyJ`, and three segments of eight
 * characters or more after it (the Kubernetes and browser copies' minimums),
 * searched the same linear way. With JWT_PATTERN it covers both, and a
 * hostname such as `my-eyewear-store.myshopify.com` is neither.
 */
export const JSON_JWT_PATTERN = redactionPattern(
	/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8})(?:[A-Za-z0-9_]*-)*?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
);

/**
 * Shapes every provider shares, in the order they are searched (the private
 * key first: it is the one shape that spans whitespace, and another shape
 * matching inside it would leave the rest of it behind).
 */
export const CREDENTIAL_PATTERNS: readonly RedactionPattern[] = Object.freeze([
	PRIVATE_KEY_PATTERN,
	JWT_PATTERN,
	JSON_JWT_PATTERN,
	redactionPattern(/\bBearer\s+\S+/giu),
	// An Authorization header in any scheme. One optional quote, and the spaces
	// after it, as one optional group: `\s*["']?\s*` read a run of spaces two
	// ways at once and was quadratic in it.
	redactionPattern(
		/\bauthorization["']?\s*[=:]\s*(?:["']\s*)?(?:basic|bearer|token|digest|negotiate)\s+\S+/giu,
	),
	// A Basic or Token credential on its own: capitalized, as the schemes are
	// written, eight credential characters or more, with a digit, a symbol, or
	// a capital after the first letter, so a word after it in prose
	// ("Token required", "Basic Authentication") survives.
	redactionPattern(
		/\b(?:Basic|Token)\s+(?![Rr]equired\b|[Aa]uthentication\b|[Ee]xpired\b|[Ii]nvalid\b|[Mm]issing\b)(?=[A-Za-z]*[0-9+/._~=-]|[A-Za-z][a-z]*[A-Z])[A-Za-z0-9+/._~-]{8,}={0,2}/gu,
	),
	// Connection strings, whole: the password sits in the authority section,
	// and Prisma Postgres hands out prisma+postgres://…?api_key=…. Found inside
	// a run too (`…WWWredis://…`), as the provider copies found them.
	redactionPattern(/(?:prisma\+)?postgres(?:ql)?:\/\/\S+/giu),
	redactionPattern(/rediss?:\/\/\S+/giu),
	redactionPattern(/(?:mysql|mongodb(?:\+srv)?|amqps?):\/\/\S+/giu),
	// Any other URL with inline credentials, whole, from the start of its run of
	// scheme characters (`-x-redis://…` from its `-`, as the provider copies'
	// `\b` took it). It starts only there, so `a.a.a.…` is one search.
	redactionPattern(
		/(?<![a-z0-9+.-])[a-z0-9+.-]*:\/\/[^\s"':/@]+:[^\s"'/@]+@\S+/giu,
	),
	// Inline credentials with no scheme in front of them.
	redactionPattern(/\/\/[^/\s:@]+:[^/\s:@]+@/gu),
	// A secret-named key and its value. The name may be prefixed
	// (`NETLIFY_AUTH_TOKEN`, `pgpassword`, `x-api-key`), so the match starts
	// where a run of name characters starts and reads it once. Quotes and
	// markdown emphasis around the separator (`"token": "…"`, `**Token:** …`)
	// do not stand in for the value. A locator is a reference, not a secret,
	// and the useful part of an error: `hobo-token://…` is a scheme, not a key
	// and its value (a scheme ends in `:`, so `token=//…` is a key and its value),
	// and `token: secret://camp/x` names where the secret is.
	// Only a clean one is kept: its run ends at whitespace or the end of the
	// text within 256 characters, with no control character in it, because a
	// run reads on through a control character and so does what it hides
	// (`hobo-token://x\u001bSECRET` is redacted whole). The bound keeps the
	// look-ahead from reading a run again from every start in it. A value
	// that ends in a separator, or has one after it, is itself a name
	// (`api_key=password: …`, `token=Token =…`), so the run after it is taken
	// too: one run, not a chain of them, because a match
	// that read every `token: ` to the end was read again from the next. A
	// value of quotes or emphasis alone (`api_key='`, cut short) is one too.
	redactionPattern(
		/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]*(?:token|secret|auth(?:orization)?|session|password|passwd|pwd|requirepass|api[_-]?key|secret[_-]?key|session[_-]?id)["'*]*\s*(?:=|:(?!\/\/[^\s\p{Cc}]{0,256}(?!\S)))(?![\s"'*]*(?:hobo-token|hobo-secret|secret|env):\/\/[^\s\p{Cc}]{0,256}(?!\S))(?:[\s"'*]*[^\s"'*]\S*(?:(?<=[=:])[\s"'*]+[^\s"'*]\S*|\s*[=:][\s"'*]*[^\s"'*]\S*)?|[\s"'*]*["'*](?!\S))/giu,
	),
	// Prefixed keys: Stripe-style sk_/pk_, GitHub, GitLab, Slack. Like the JWT
	// shapes it starts where a run starts and takes the run's start before a
	// `-` with it: starting at the prefix left `AAAA…-` behind, part of the key.
	redactionPattern(
		/(?<![A-Za-z0-9_-])(?:[A-Za-z0-9_]*-)*?(?:sk|pk|ghp|gho|ghs|glpat|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/giu,
	),
]);

/**
 * Detectors for a refusal rather than a redaction (`.test`, no `g`, so they
 * carry no `lastIndex` between calls): the same linear shapes, for guards that
 * refuse a payload holding one.
 */
export const JWT_DETECTOR: RegExp =
	/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}\.)(?:[A-Za-z0-9_]*-)*?ey[A-Za-z0-9_-]{10,}\./u;

/**
 * A signed compact JWS and nothing after it: an `eyJ` header and a payload and
 * a signature of eight base64url characters or more. For a caller that must
 * neither count an unsigned token nor swallow what follows the signature (the
 * rest of a JSON body). Linear like JWT_PATTERN: it starts only where a run of
 * base64url characters starts, and the look-ahead reads that run and the next
 * two once.
 */
export const SIGNED_JWT_PATTERN = JSON_JWT_PATTERN;

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
	 * The provider's own structured shapes (a claim URL, a token prefix, a CLI
	 * line): searched after the private key and before the other shared shapes,
	 * because each knows where its own credential ends.
	 */
	readonly patterns?: readonly RegExp[];
	/**
	 * Generic fallbacks (a long opaque run): searched last, after every shared
	 * shape, so a JWT, a key, a bearer token or a credential URL is redacted
	 * whole before a fallback can split it and leave part of it behind.
	 */
	readonly fallbacks?: readonly RegExp[];
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
		// Generic fallbacks last: run first, a long-opaque-run rule splits a JWT
		// into pieces the JWT shape no longer matches, and its payload survives.
		patterns: Object.freeze([
			PRIVATE_KEY_PATTERN,
			...(profile.patterns ?? []).map(redactionPattern),
			...CREDENTIAL_PATTERNS.filter(
				(pattern) => pattern !== PRIVATE_KEY_PATTERN,
			),
			...(profile.fallbacks ?? []).map(redactionPattern),
		]),
		keep:
			profile.keep === undefined ? undefined : redactionPattern(profile.keep),
		decodePercent: profile.decodePercent ?? false,
		collapseWhitespace: profile.collapseWhitespace ?? false,
	};
}

type Span = readonly [from: number, to: number];

/** Whether a pattern's match is redacted: for a rule that is a shape and a test. */
export type AcceptMatch = (match: string, pattern: RedactionPattern) => boolean;

/**
 * Every match of `pattern` in `text`, a match's value searched again: the
 * search resumes at the first whitespace inside a match, not at its end, so
 * a value that is itself a name and a separator (`"token": "password: …`,
 * `**Token**: api_key=**Token:** …`) does not hide the match after it. A
 * match that spans no whitespace is searched past whole. Every shape but the
 * private key spans a bounded number of runs, so each character is read again
 * a bounded number of times, and a private key's body once more.
 */
function pushMatches(
	spans: Span[],
	text: string,
	pattern: RedactionPattern,
	offset: number,
	ends?: number[],
	accept?: AcceptMatch,
): void {
	const search = new RegExp(pattern.source, pattern.flags);
	for (
		let match = search.exec(text);
		match !== null;
		match = search.exec(text)
	) {
		const length = match[0].length;
		if (length > 0 && (accept === undefined || accept(match[0], pattern))) {
			spans.push([offset + match.index, offset + match.index + length]);
			// Where a private key's last END line starts, read in the match
			// alone: searched for in the text, a key with none read back to its start.
			const end = match[0].lastIndexOf("-----END");
			ends?.push(end < 0 ? -1 : match.index + end);
		}
		const gap = match[0].search(/\s/u);
		search.lastIndex = match.index + (gap > 0 ? gap : Math.max(length, 1));
	}
}

/**
 * Where every pattern matches in `text`, searched twice: as it came, where a
 * control character is not whitespace, so a credential's run reads on through
 * it (`Bearer abcd\u0007SECRET`), and with each control character a space, so
 * a name or separator one split (`PASSWORD\u0000=…`) is found too. Flattening
 * puts one character for one, so both searches' spans are in the same text.
 *
 * Every pattern searches the text as it came, not what an earlier one left:
 * searched in turn over a text being rewritten, one shape's match cut short a
 * run another needed whole (a long-run rule saw 18 characters where there had
 * been 40), or took another's name (`code=password: …` lost `password` to the
 * `code` shape, and its value survived). So the order of the patterns cannot
 * leave anything behind that any one of them matches.
 */
function credentialSpans(
	spans: Span[],
	text: string,
	patterns: readonly RedactionPattern[],
	offset: number,
	accept?: AcceptMatch,
): void {
	const flattened = flattenControlChars(text);
	const keys: Span[] = [];
	const ends: number[] = [];
	const others: Span[] = [];
	for (const pattern of patterns) {
		const key = pattern === PRIVATE_KEY_PATTERN;
		const found = key ? keys : others;
		pushMatches(found, text, pattern, 0, key ? ends : undefined, accept);
		if (flattened !== text)
			pushMatches(found, flattened, pattern, 0, key ? ends : undefined, accept);
	}
	const ranOver = coverage(others);
	keys.forEach(([from, to], index) => {
		spans.push([
			offset + from,
			offset + keyEnd(text, from, to, ends[index] ?? -1, ranOver),
		]);
	});
	for (const [from, to] of others) spans.push([offset + from, offset + to]);
}

/**
 * Whether a span starts before a position and ends after it: `others` sorted
 * by start, with the furthest end of any span up to each one.
 */
function coverage(others: Span[]): (at: number) => boolean {
	others.sort((left, right) => left[0] - right[0]);
	const furthest: number[] = [];
	let reach = -1;
	for (const [, to] of others) {
		reach = Math.max(reach, to);
		furthest.push(reach);
	}
	return (at) => {
		let low = 0;
		let high = others.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((others[middle]?.[0] ?? at) < at) low = middle + 1;
			else high = middle;
		}
		return low > 0 && (furthest[low - 1] ?? -1) > at;
	};
}

const NEXT_BEGIN = /-----BEGIN/giu;

/**
 * Where a private key's span ends: where its pattern ended it, unless the END
 * line that ended it is inside another shape's match (`Bearer -----END …`,
 * `**Token:** -----END …`), which ran over it. Then that line ends nothing,
 * and the key goes on to the next BEGIN line or the end of the text.
 */
function keyEnd(
	text: string,
	from: number,
	to: number,
	end: number,
	ranOver: (at: number) => boolean,
): number {
	if (end <= from || !ranOver(end)) return to;
	NEXT_BEGIN.lastIndex = from + 1;
	const next = NEXT_BEGIN.exec(text);
	return next === null ? text.length : next.index;
}

/** `text` with each run of overlapping or touching spans one marker. */
function replaceSpans(
	text: string,
	spans: Span[],
	marker = REDACTION_MARKER,
): string {
	if (spans.length === 0) return text;
	spans.sort((left, right) => left[0] - right[0]);
	let out = "";
	let [from, to] = spans[0] ?? [0, 0];
	out += text.slice(0, from);
	for (const [nextFrom, nextTo] of spans) {
		if (nextFrom <= to) {
			to = Math.max(to, nextTo);
			continue;
		}
		out += `${marker}${text.slice(to, nextFrom)}`;
		[from, to] = [nextFrom, nextTo];
	}
	return `${out}${marker}${text.slice(to)}`;
}

/**
 * `text` with every match of every pattern one `marker` (a run of
 * overlapping or touching matches one marker), every pattern searched over the
 * text as it came and with control characters as spaces. For a caller with
 * shapes of its own that must not hide each other's matches; `accept`, when
 * given, says which matches count (a long run that is also high in entropy).
 */
export function redactMatches(
	text: string,
	patterns: readonly RedactionPattern[],
	marker = REDACTION_MARKER,
	accept?: AcceptMatch,
): string {
	const spans: Span[] = [];
	credentialSpans(spans, text, patterns, 0, accept);
	return replaceSpans(text, spans, marker);
}

/**
 * `text` with every credential span redacted, and every span `keep` matches
 * kept whole: the text between kept spans is searched on its own, so no shape
 * reads into one.
 */
function redactSpans(
	text: string,
	patterns: readonly RedactionPattern[],
	keep: RedactionPattern | undefined,
): string {
	if (keep === undefined) return redactMatches(text, patterns);
	const spans: Span[] = [];
	let from = 0;
	for (const kept of text.matchAll(keep)) {
		credentialSpans(spans, text.slice(from, kept.index), patterns, from);
		from = kept.index + kept[0].length;
	}
	credentialSpans(spans, text.slice(from), patterns, from);
	return replaceSpans(text, spans);
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
		let out = flattenControlChars(
			redactSpans(searched, parsed.patterns, parsed.keep),
		);
		if (parsed.collapseWhitespace) out = out.replace(/\s{2,}/gu, " ");
		out = out.trim();
		return out.length > maxLength || searched.length < decoded.length
			? `${out.slice(0, maxLength)}${CUT_MARKER}`
			: out;
	};
}

const sharedRedactor = createProviderRedactor();

/** The shared shapes alone. */
export function redactProviderText(text: string, maxLength = 256): string {
	return sharedRedactor(text, maxLength);
}
