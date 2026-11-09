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
 * Reached through the `@hobo/provider-redaction` subpath, not the package
 * root: the flagship surface is provider-neutral, and this module names
 * provider credential shapes.
 */

import { anyCase, SECRET_KEY_NAMES } from "./any-case.js";
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
 * input (`@hobo/redaction-test-harness/linear-time`).
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
 * A private key, from its BEGIN line to the next BEGIN line or the end of the
 * text: the shape a search for one starts from. `redactMatches`, and every
 * redactor built on it, ends a key at its END line in code (`keySpans`), which
 * a regular expression could only do by looking ahead from every place it
 * could give a character back: to the last END line before the next BEGIN
 * line, when that END line starts a line, with the rest of its run. A label is
 * anything up to the next `-` (`RSA`, `ENCRYPTED`, `OPENSSH`, one with a
 * digit); BEGIN and END are matched in any case.
 */
export const PRIVATE_KEY_PATTERN = redactionPattern(
	/-----BEGIN[^-]*PRIVATE KEY-----(?:(?!-----BEGIN)[\s\S])*/gi,
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
 * `ey` in a run reads to the same dot. So a JWT after a `-` is still found;
 * the run's start before it is read as the `lead` group and kept, as the
 * provider copies' `\bey` kept it (`token-[redacted]`).
 */
export const JWT_PATTERN = redactionPattern(
	/(?<![\u017F\u212AA-Za-z0-9_-])(?=[\u017F\u212AA-Za-z0-9_-]*\.[\u017F\u212AA-Za-z0-9_-]{10,}\.)(?<lead>(?:[A-Za-z0-9_]*[-\u017F\u212A])*?)ey[\u017F\u212AA-Za-z0-9_-]{10,}\.[\u017F\u212AA-Za-z0-9_-]{10,}\.\S*/gi,
);

/**
 * A compact JWS with a JSON header, `eyJ`, and three segments of eight
 * characters or more after it (the Kubernetes and browser copies' minimums),
 * searched the same linear way. With JWT_PATTERN it covers both, and a
 * hostname such as `my-eyewear-store.myshopify.com` is neither.
 */
export const JSON_JWT_PATTERN = redactionPattern(
	/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8})(?<lead>(?:[A-Za-z0-9_]*-)*?)eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
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
	redactionPattern(/\bBearer\s+\S+/gi),
	// An Authorization header in any scheme. One optional quote, and the spaces
	// after it, as one optional group: `\s*["']?\s*` read a run of spaces two
	// ways at once and was quadratic in it.
	redactionPattern(
		/\bauthorization["']?\s*[=:]\s*(?:["']\s*)?(?:basic|bearer|token|digest|negotiate)\s+\S+/gi,
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
	redactionPattern(/(?:prisma\+)?postgres(?:ql)?:\/\/\S+/gi),
	redactionPattern(/rediss?:\/\/\S+/gi),
	redactionPattern(/(?:mysql|mongodb(?:\+srv)?|amqps?):\/\/\S+/gi),
	// Any other URL with inline credentials, whole, from the start of its run of
	// scheme characters (`-x-redis://…` from its `-`, as the provider copies'
	// `\b` took it). It starts only there, so `a.a.a.…` is one search. A user
	// alone is a credential too: a token is often the user
	// (`https://ghp_…@github.com/…`), and `Token ://…@host` is one with no scheme.
	redactionPattern(
		/(?<![\u017F\u212Aa-z0-9+.-])[\u017F\u212Aa-z0-9+.-]*:\/\/[^\s"':/@]+(?::[^\s"'/@]*)?@\S+/gi,
	),
	// Inline credentials with no scheme in front of them.
	redactionPattern(/\/\/[^/\s:@]+:[^/\s:@]+@/gu),
	// A secret-named key and its value. The name may be prefixed
	// (`NETLIFY_AUTH_TOKEN`, `pgpassword`, `x-api-key`), so the match starts
	// where a run of name characters starts and reads it once. Quotes and
	// markdown emphasis around the separator (`"token": "…"`, `**Token:** …`)
	// do not stand in for the value. A locator is a reference, not a secret,
	// and the useful part of an error: `hobo-token://…` is a scheme, not a key
	// and its value, and `token: secret://camp/x` names where the secret is.
	// Only the locator schemes are (`hobo-token://`, `hobo-secret://`,
	// `secret://`): `password://…` and `api-key://…` are a key and its value,
	// and so is `token=//…`, since a scheme ends in `:`.
	// Only a clean one is kept: its run ends at whitespace or the end of the
	// text within 256 characters, with no control character in it, because a
	// run reads on through a control character and so does what it hides
	// (`hobo-token://x\u001bSECRET` is redacted whole). The bound keeps the
	// look-ahead from reading a run again from every start in it. A value
	// that ends in a separator, or has one after it, is itself a name
	// (`api_key=password: …`, `token=Token =…`), so the run after it is taken
	// too, and the one after that while each ends in one (`api_key=a,password=
	// b= SECRET`). A search resumes at a match's last run (`pushMatches`), so a
	// chain of `token: ` is read once. A value of quotes or emphasis alone
	// (`api_key='`, cut short) is one too.
	redactionPattern(
		new RegExp(
			String.raw`(?<![\u017F\u212AA-Za-z0-9_-])[\u017F\u212AA-Za-z0-9_-]*(?:${SECRET_KEY_NAMES})["'*]*\s*(?:=|:(?!\/\/[^\s\p{Cc}]{0,256}(?!\S))|(?<!(?<![\u017F\u212AA-Za-z0-9_-])(?:${anyCase("hobo-token|hobo-secret|secret")})):)(?![\s"'*]*(?:${anyCase("hobo-token|hobo-secret|secret|env")}):\/\/[^\s\p{Cc}]{0,256}(?!\S))(?:[\s"'*]*[^\s"'*]\S*(?:(?<=[=:])[\s"'*]+[^\s"'*]\S*|\s*[=:][\s"'*]*[^\s"'*]\S*)*|[\s"'*]*["'*](?!\S))`,
			"gu",
		),
	),
	// Prefixed keys: Stripe-style sk_/pk_, GitHub, GitLab, Slack. Like the JWT
	// shapes it starts where a run starts and takes the run's start before a
	// `-` with it: starting at the prefix left `AAAA…-` behind, part of the key.
	redactionPattern(
		/(?<![\u017F\u212AA-Za-z0-9_-])(?:[A-Za-z0-9_]*[-\u017F\u212A])*?(?:sk|pk|ghp|gho|ghs|glpat|github_pat|xox[abprs])[-_][\u017F\u212AA-Za-z0-9_-]{8,}/gi,
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
 * The profile of a provider whose only rule of its own was that any run of
 * twenty or more token characters is a credential (Azure, Cloudflare,
 * DigitalOcean, GCP, Hetzner, Hostinger): that rule as a fallback, searched
 * after the shared shapes. One object, so its tests run once, here.
 */
export const LONG_TOKEN_RUN_PROFILE: ProviderRedactionProfile = Object.freeze({
	fallbacks: Object.freeze([redactionPattern(/[A-Za-z0-9_-]{20,}/gu)]),
});

/**
 * Every shared shape, the patterns and the detectors: what a caller's tests
 * leave to this package's (`ownPatterns(profilePatterns(profile), SHARED_SHAPES)`
 * from `@hobo/redaction-test-harness/linear-sweep` is what a caller adds).
 */
export const SHARED_SHAPES: readonly RegExp[] = Object.freeze([
	...CREDENTIAL_PATTERNS,
	JWT_DETECTOR,
	PRIVATE_KEY_DETECTOR,
]);

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
	return unit !== undefined && /^[0-9A-Fa-f]$/u.test(unit);
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

/** Where the last run of a match starts, or its end when it has one run. */
function lastRunStart(match: string): number {
	for (let at = match.length - 1; at > 0; at--)
		if (WHITESPACE.test(match.charAt(at))) return at + 1;
	return match.length;
}

const WHITESPACE = /\s/u;

/**
 * Every match of `pattern` in `text`. The search resumes at the last run of a
 * match, not at its end, so a match that starts inside it is still found
 * (`**Token**: api_key=**Token:** …`, `Bearer Bearer x`). The runs before the
 * last are not searched again: a later start in them reads on through the
 * same runs, so it ends no further. Each character is read again at most once,
 * however many runs a match spans.
 */
function pushMatches(
	spans: Span[],
	text: string,
	pattern: RedactionPattern,
	accept?: AcceptMatch,
): void {
	const search = new RegExp(pattern.source, pattern.flags);
	for (
		let match = search.exec(text);
		match !== null;
		match = search.exec(text)
	) {
		const length = match[0].length;
		// A shape may read context it does not redact, named `lead`: a JWT is
		// searched from the start of its run, for one search per run, and
		// redacted from its `ey` (`token-[redacted]`).
		const lead = match.groups?.lead?.length ?? 0;
		if (length > lead && (accept === undefined || accept(match[0], pattern)))
			spans.push([match.index + lead, match.index + length]);
		search.lastIndex = match.index + Math.max(lastRunStart(match[0]), 1);
	}
}

const BEGIN_LINE = /-----BEGIN[^-]*PRIVATE KEY-----/gi;
// Case-sensitive, as every redactor this replaced matched it: a key ends only
// on an END line written the way keys write it, so a `-----end …` inside a
// body cannot end it early and show the rest.
const END_LINE = /-----END[^-]*PRIVATE KEY-----/g;
const RUN = /\S*/uy;

/** Whether `at` starts a line: after whitespace, the start, or an escaped `\n`. */
function startsLine(text: string, at: number): boolean {
	if (at === 0) return true;
	const before = text.charAt(at - 1);
	if (WHITESPACE.test(before)) return true;
	return text.charAt(at - 2) === "\\" && (before === "n" || before === "r");
}

/** Where the run of non-whitespace that starts at `from` ends. */
function runEnd(text: string, from: number): number {
	RUN.lastIndex = from;
	RUN.exec(text);
	return RUN.lastIndex;
}

/**
 * The private key that starts at `from` (a BEGIN line ending at `bodyStart`):
 * to the last END line before `stop` (the next BEGIN line, or the end of the
 * text), with the rest of that line's run, when that line starts a line and no
 * other match runs over it; otherwise to `stop`. `ends` are the END lines in
 * order, and `next` is the first one that may lie after `bodyStart`.
 */
function keyAt(
	text: string,
	from: number,
	bodyStart: number,
	stop: number,
	ends: readonly RegExpExecArray[],
	reaches: (before: number, past: number) => boolean,
): Span {
	let low = 0;
	let high = ends.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((ends[middle]?.index ?? stop) < stop) low = middle + 1;
		else high = middle;
	}
	const last = ends[low - 1];
	if (
		last === undefined ||
		last.index < bodyStart ||
		!startsLine(text, last.index)
	)
		return [from, stop];
	const endLine = last.index + last[0].length;
	// A key whose END line another shape took goes on to the next BEGIN line.
	if (reaches(endLine, last.index)) return [from, stop];
	return [from, runEnd(text, endLine)];
}

/**
 * Every private key in `text`. A key starts at a BEGIN line (in any case) and
 * runs as `keyAt` says. A BEGIN line is also one that only appears once the
 * other shapes' matches are taken out, as each redactor this replaced took
 * them out first: `-----BEGIN eyJ…-x… PRIVATE KEY-----`, whose label a JWT with
 * a `-` in it broke. So the text is searched again with every match so far
 * (the other shapes' and the keys found) masked by a character that is
 * neither a `-` nor whitespace, until no new BEGIN line appears: a key taken
 * out can make the BEGIN line of one around it. Each round is linear, and a
 * round finds a new BEGIN line or ends; past MADE_ROUNDS the rest is redacted.
 */
function keySpans(text: string, others: readonly Span[]): Span[] {
	if (!/-----BEGIN/iu.test(text)) return [];
	const ends = [...text.matchAll(END_LINE)];
	const reaches = overlapping([...others]);
	const starts = new Map<number, number>();
	for (const begin of text.matchAll(BEGIN_LINE))
		starts.set(begin.index, begin.index + begin[0].length);
	// Real BEGIN lines stop each other; a key from a BEGIN line that only the
	// masking made is held to the next BEGIN line of either kind. A made line
	// never shortens a real key: every key here only adds what is redacted.
	const real = [...starts.keys()];
	const keys: Span[] = [];
	const bodies: Span[] = [];
	const lines: Span[] = [];
	const add = (from: number, stop: number): void => {
		const bodyStart = starts.get(from) ?? from;
		const key = keyAt(text, from, bodyStart, stop, ends, reaches);
		keys.push(key);
		bodies.push([bodyStart, key[1]]);
		lines.push([from, bodyStart]);
	};
	real.forEach((from, index) => {
		add(from, real[index + 1] ?? text.length);
	});
	if (others.length === 0) return keys;
	for (let round = 0; ; round++) {
		// Masked four ways, and every BEGIN line any of them shows is one: with
		// each key whole, which can make the BEGIN line of a key around it, or
		// its body only, which keeps the end of its BEGIN line for one that
		// reaches it through a match; and with every `-----BEGIN` and
		// `PRIVATE KEY-----` outside the keys' own BEGIN lines masked or kept,
		// since the redactors this replaced took the other shapes out in
		// different orders (a JWT before the key, a long run after it).
		const made = new Map<number, number>();
		for (const masked of [
			maskSpans(text, others, keys),
			maskSpans(text, others, bodies),
			maskSpans(text, others, keys, lines),
			maskSpans(text, others, bodies, lines),
		])
			for (const begin of masked.matchAll(BEGIN_LINE))
				if (!starts.has(begin.index))
					made.set(begin.index, begin.index + begin[0].length);
		if (made.size === 0) return keys;
		// A key nested in more BEGIN lines than MADE_ROUNDS takes a round each,
		// and a text could nest one per few characters: past that, everything
		// from the first such BEGIN line on is redacted, which hides more and
		// costs one more pass.
		if (round === MADE_ROUNDS) {
			keys.push([
				[...made.keys()].reduce((low, from) => Math.min(low, from)),
				text.length,
			]);
			return keys;
		}
		for (const [from, bodyStart] of made) starts.set(from, bodyStart);
		const all = [...starts.keys()].sort((left, right) => left - right);
		const next = new Map(all.map((from, index) => [from, all[index + 1]]));
		for (const from of made.keys()) add(from, next.get(from) ?? text.length);
	}
}

/** How many rounds of BEGIN lines made by masking `keySpans` follows. */
const MADE_ROUNDS = 8;

/**
 * `text` with every span's characters an `x`, which is neither a `-` nor
 * whitespace. With `lines` (the keys' own BEGIN lines), every `-----BEGIN`
 * and `PRIVATE KEY-----` outside those lines is then left as it was, as a
 * redactor that found the key before the shape that took it saw them
 * (`…abcdef-----BEGIN …`, a long run that ran into it, or the run after a
 * key's END line).
 */
function maskSpans(
	text: string,
	others: readonly Span[],
	keys: readonly Span[],
	lines?: readonly Span[],
): string {
	const units = text.split("");
	const mask = (spans: readonly Span[]): void => {
		for (const [from, to] of spans)
			for (let at = from; at < to; at++) units[at] = "x";
	};
	mask(others);
	mask(keys);
	if (lines !== undefined) {
		const inLine = overlapping([...lines]);
		for (const token of KEY_TOKENS)
			for (const found of text.matchAll(token)) {
				const end = found.index + found[0].length;
				if (inLine(end, found.index)) continue;
				for (let at = found.index; at < end; at++) units[at] = text.charAt(at);
			}
	}
	return units.join("");
}

// What a key's BEGIN line is made of, kept inside another shape's match.
const KEY_TOKENS = [/-----BEGIN/giu, /PRIVATE KEY-----/giu];

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
 * leave anything behind that any one of them matches. PRIVATE_KEY_PATTERN is
 * found by `keySpans`, and a key whose END line another shape's match takes
 * any of (`Bearer -----END …`, `KEY-----glpat-…` to a long-run rule) goes on to
 * the next BEGIN line or the end, as it did when that shape ran first.
 */
function credentialSpans(
	text: string,
	patterns: readonly RedactionPattern[],
	accept?: AcceptMatch,
): Span[] {
	const flattened = flattenControlChars(text);
	const searched = flattened === text ? [text] : [text, flattened];
	const others: Span[] = [];
	for (const pattern of patterns)
		if (pattern !== PRIVATE_KEY_PATTERN)
			for (const each of searched) pushMatches(others, each, pattern, accept);
	if (!patterns.includes(PRIVATE_KEY_PATTERN)) return others;
	const spans = [...others];
	for (const each of searched) spans.push(...keySpans(each, others));
	return spans;
}

/**
 * Whether a span of `spans` starts before `before` and ends after `past`:
 * `spans` sorted by start, with the furthest end of any span up to each one.
 */
function overlapping(spans: Span[]): (before: number, past: number) => boolean {
	const sorted = [...spans].sort((left, right) => left[0] - right[0]);
	const furthest: number[] = [];
	let reach = -1;
	for (const [, to] of sorted) {
		reach = Math.max(reach, to);
		furthest.push(reach);
	}
	return (before, past) => {
		let low = 0;
		let high = sorted.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((sorted[middle]?.[0] ?? before) < before) low = middle + 1;
			else high = middle;
		}
		return low > 0 && (furthest[low - 1] ?? -1) > past;
	};
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
	return replaceSpans(text, credentialSpans(text, patterns, accept), marker);
}

// What a kept span is searched as: a run character (`password=sha256:…-x`
// is one run, and its value is taken whole) that no credential shape's class
// holds, so no long-run rule matches the span itself.
const KEPT = String.fromCharCode(0xe000);

/**
 * `text` with every credential span redacted, and every span `keep` matches
 * kept whole where no credential span reaches it. The whole text is searched
 * with each kept span masked, not the pieces between them: searched apart, a
 * value glued to a kept digest (`password=sha256:…-SECRET`) was its own piece,
 * with no name before it. A kept span a credential span reaches is redacted
 * with it, whole.
 */
function redactSpans(
	text: string,
	patterns: readonly RedactionPattern[],
	keep: RedactionPattern | undefined,
): string {
	if (keep === undefined) return redactMatches(text, patterns);
	const kept: Span[] = [];
	let masked = "";
	let from = 0;
	for (const span of text.matchAll(keep)) {
		const to = span.index + span[0].length;
		if (to === span.index) continue;
		kept.push([span.index, to]);
		masked += text.slice(from, span.index) + KEPT.repeat(to - span.index);
		from = to;
	}
	masked += text.slice(from);
	const spans = credentialSpans(masked, patterns);
	const reaches = overlapping(spans);
	for (const [start, end] of kept)
		if (reaches(end, start)) spans.push([start, end]);
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

/**
 * A locator the shared redactor keeps, for a test that holds it to another
 * redactor (`assertRevealsNoMore`'s `kept`): its path a run of 256 characters or
 * fewer with no control character in it, ending at whitespace or the end, and,
 * when it is a key's value, that key's name (the shared redactor's names). A
 * marker anywhere else in the run, before the name or glued to it from
 * another credential, is not exempt.
 */
export const KEPT_LOCATOR = new RegExp(
	String.raw`(?:(?<![\u017F\u212AA-Za-z0-9_-])[\u017F\u212AA-Za-z0-9_-]*(?:${SECRET_KEY_NAMES})["'*]*\s*[=:][\s"'*]*|(?<![\u017F\u212AA-Za-z0-9_-]))(?:${anyCase("hobo-token|hobo-secret|secret|env")}):\/\/[^\s\p{Cc}]{0,256}(?!\S)`,
	"gu",
);
