/**
 * A differential test for a redactor that replaced another: generated texts
 * full of credential shapes, separators and control characters, each carrying
 * markers (`SECR` and eight random characters) wherever a credential could
 * sit, run through both. Wherever the old redactor hid half of a marker's
 * random tail, the new one must hide it too: it may redact more, never less.
 * The one exception is a marker inside a locator's path (`hobo-token://…`,
 * `secret://…`) or the name of the key it is the value of: a locator names
 * where a secret is kept and is the useful part of an error, so the shared
 * redactor keeps it where the old ones did not. The texts carry credentials at
 * their real lengths, percent-encodings, non-ASCII, zero-width and direction
 * characters, secret names used as schemes, and digests a value is glued to.
 *
 * Reached through the `@hobo/provider-redaction/redaction-differential` subpath, for tests.
 */

import { anyCase, SECRET_KEY_NAMES } from "./any-case.js";
/** What a redaction left of a text: the text a person or a log would see. */
export type Redact = (text: string) => string;

/** Starts, separators and fillers the generated texts are made of. */
export const FUZZ_PIECES: readonly string[] = Object.freeze([
	"Bearer ",
	"bearer\t",
	"Basic ",
	"Token ",
	"token=",
	"password: ",
	"api_key=",
	'"token": "',
	"Authorization: ",
	"authorization=",
	"postgres://u:",
	"redis://default:",
	"mongodb://a:",
	"https://admin:",
	"@db.example.com",
	"-----BEGIN PRIVATE KEY-----",
	"-----END PRIVATE KEY-----",
	"eyJ",
	"eyJhbGciOiJIUzI1NiJ9.",
	"sk-",
	"sk_live_",
	"ghp_",
	"npg_",
	"nfp_",
	"proj_",
	"AKIA",
	"hobo-token://",
	"secret://",
	"**Token:** ",
	"**Token**: ",
	"code=",
	"UPSTASH_REDIS_REST_TOKEN=",
	" ",
	"\t",
	"\n",
	".",
	"-",
	"_",
	"%",
	"+",
	":",
	'"',
	"'",
	"*",
	"=",
	"/",
	"@",
	",",
	"%20",
	String.fromCharCode(0),
	String.fromCharCode(7),
	String.fromCharCode(27),
	"a",
	"Z",
	"9",
	"error",
	"ok",
	// Percent-encodings, a decoder's work.
	"%3D",
	"%3A",
	"%2F",
	"%40",
	"%25",
	"token%3D",
	"Bearer%20",
	// Unicode: letters a class may not hold, zero-width and direction marks,
	// and a no-break space, which is whitespace to `\s`.
	"é",
	"Ω",
	"\u0627",
	"\u200b",
	"\u200d",
	"\u202e",
	"\u00a0",
	// A scheme on its own, after a credential's name, and a secret's name used
	// as a scheme.
	"://",
	"Token ://",
	"password://",
	"pwd://",
	"api-key://",
	"token://",
	"x-token://",
	// A kept digest, which a value can be glued to.
	`sha256:${"0123456789abcdef".repeat(4)}`,
	// A `-----BEGIN` that is not a BEGIN line, inside a key's body, and the
	// pieces another shape takes of an END line.
	"-----BEGINx\n",
	"-----BEGIN PRIVATE KEY-----*",
	"Bearer -----END PRIVATE KEY-----",
	"KEY-----",
	// Letters `i` folds to ASCII under the `u` flag: `ſ` to `s`, `K` to `k`.
	"ſ",
	"\u212a",
	// More key names.
	"access_key=",
	"secret_access_key=",
	"aws_secret_access_key=",
	"client_secret=",
	"private_key=",
]);

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const MARKER_CHARS =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A seeded generator of integers below a bound (mulberry32): a linear
 * congruential one taken modulo a small bound repeats its low bits within a
 * few calls, so most texts were never built.
 */
function seeded(seed: number): (bound: number) => number {
	let state = seed >>> 0;
	return (bound) => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), state | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return Math.floor(
			(((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296) * bound,
		);
	};
}

/** A generated text and the random tails of the markers it carries. */
export type FuzzText = {
	readonly text: string;
	readonly tails: readonly string[];
};

type Draw = (bound: number) => number;

function drawn(draw: Draw, chars: string, length: number): string {
	let out = "";
	for (let char = 0; char < length; char++) out += chars[draw(chars.length)];
	return out;
}

/**
 * Credentials at their real lengths, each with a marker inside its body: a
 * marker alone is shorter than the minimum many shapes ask for, and a shape
 * only redacts what is long enough to be one.
 */
const CREDENTIALS: readonly ((draw: Draw) => FuzzText)[] = [
	(draw) => {
		const tail = drawn(draw, UPPER, 8);
		return { text: `AKIASECR${tail}${drawn(draw, UPPER, 4)}`, tails: [tail] };
	},
	...[
		(tail: string, draw: Draw) =>
			`ghp_SECR${tail}${drawn(draw, MARKER_CHARS, 24)}`,
		(tail: string, draw: Draw) =>
			`sk_live_SECR${tail}${drawn(draw, MARKER_CHARS, 12)}`,
		(tail: string, draw: Draw) =>
			`rk_test_SECR${tail}${drawn(draw, MARKER_CHARS, 12)}`,
		(tail: string, draw: Draw) =>
			`glpat-SECR${tail}${drawn(draw, MARKER_CHARS, 8)}`,
		(tail: string, draw: Draw) =>
			`xoxb-1234567890-SECR${tail}${drawn(draw, MARKER_CHARS, 12)}`,
		(tail: string, draw: Draw) =>
			`eyJhbGciOiJIUzI1NiJ9.eyJSECR${tail}${drawn(draw, MARKER_CHARS, 6)}.${drawn(draw, MARKER_CHARS, 22)}`,
		(tail: string) =>
			`-----BEGIN PRIVATE KEY-----\nMIIBSECR${tail}\n-----END PRIVATE KEY-----`,
		(tail: string) => `-----BEGIN RSA PRIVATE KEY-----\nSECR${tail}`,
		(tail: string, draw: Draw) =>
			`eyAiYWxnIjoiSFMSECR${tail}.eyAic3ViIjoiU0VDUiJ9.${drawn(draw, MARKER_CHARS, 12)}`,
		(tail: string) =>
			`-----BEGIN PRIVATE KEY-----\n-----BEGINx\nSECR${tail}\nBearer -----END PRIVATE KEY-----\n`,
	].map((credential) => (draw: Draw): FuzzText => {
		const tail = drawn(draw, MARKER_CHARS, 8);
		return { text: credential(tail, draw), tails: [tail] };
	}),
];

/**
 * `count` texts from a seeded generator, so a failure names a text that
 * replays. Each is up to 24 pieces: a fifth of them markers, a tenth
 * credentials at their real lengths with a marker inside, the rest pieces.
 */
export function* fuzzTexts(
	count: number,
	seed = 20_261_109,
): Generator<FuzzText> {
	const next = seeded(seed);
	for (let index = 0; index < count; index++) {
		let text = "";
		const tails: string[] = [];
		const pieces = 1 + next(24);
		for (let piece = 0; piece < pieces; piece++) {
			const kind = next(10);
			const credential = CREDENTIALS[next(CREDENTIALS.length)];
			if (kind < 2) {
				const tail = drawn(next, MARKER_CHARS, 8);
				tails.push(tail);
				text += `SECR${tail}`;
			} else if (kind === 2 && credential !== undefined) {
				const made = credential(next);
				tails.push(...made.tails);
				text += made.text;
			} else {
				text += FUZZ_PIECES[next(FUZZ_PIECES.length)];
			}
		}
		yield { text, tails };
	}
}

/**
 * A locator the shared redactor keeps: its path a run of 256 characters or
 * fewer with no control character in it, ending at whitespace or the end, and,
 * when it is a key's value, that key's name (the shared redactor's names). A
 * marker anywhere else in the run, before the name or glued to it from
 * another credential, is not exempt.
 */
export const LOCATOR_RUN = new RegExp(
	String.raw`(?:(?<![A-Za-z0-9_-])[\u017F\u212AA-Za-z0-9_-]*(?:${SECRET_KEY_NAMES})["'*]*\s*[=:][\s"'*]*|(?<![A-Za-z0-9_-]))(?:${anyCase("hobo-token|hobo-secret|secret|env")}):\/\/[^\s\p{Cc}]{0,256}(?!\S)`,
	"gu",
);

function insideLocator(text: string, tail: string): boolean {
	const at = text.indexOf(`SECR${tail}`);
	if (at < 0) return false;
	for (const locator of text.matchAll(LOCATOR_RUN)) {
		if (locator.index <= at && at + 12 <= locator.index + locator[0].length)
			return true;
	}
	return false;
}

/** The halves of a marker's tail that `out` still shows. */
function shownHalves(out: string, tail: string): readonly string[] {
	return [tail.slice(0, 4), tail.slice(4)].filter((half) => out.includes(half));
}

/** A text the new redactor showed more of than the old one did. */
export type Revealed = {
	readonly text: string;
	readonly half: string;
	readonly old: string;
	readonly now: string;
};

export class RevealedMoreError extends Error {
	readonly code = "REDACTION_REVEALED_MORE" as const;
	readonly revealed: readonly Revealed[];

	constructor(revealed: readonly Revealed[], total: number) {
		super(
			`showed ${total} marker halves the old redactor hid, first: ${revealed
				.map(
					(each) =>
						`${JSON.stringify(each.text)} shows ${each.half}: old ${JSON.stringify(each.old)}, now ${JSON.stringify(each.now)}`,
				)
				.join("; ")}`,
		);
		this.name = "RevealedMoreError";
		this.revealed = revealed;
	}
}

/**
 * Throw unless `now` hides, on every generated text, every marker half `old`
 * hid. Returns how many halves `old` hid, so a test can check it saw some.
 */
export type RevealOptions = {
	/** How many texts to generate (20k by default). */
	readonly count?: number;
	readonly seed?: number;
	/**
	 * What the redactor does to a text before it searches it (a full
	 * percent-decoding), so a locator is told apart in the text it sees.
	 */
	readonly decode?: (text: string) => string;
};

export function assertRevealsNoMore(
	old: Redact,
	now: Redact,
	options: RevealOptions = {},
): number {
	const decode = options.decode ?? ((text: string) => text);
	const revealed: Revealed[] = [];
	let total = 0;
	let hidden = 0;
	for (const { text, tails } of fuzzTexts(
		options.count ?? 20_000,
		options.seed,
	)) {
		const before = old(text);
		const after = now(text);
		for (const tail of tails) {
			if (insideLocator(decode(text), tail)) continue;
			const shownBefore = shownHalves(before, tail);
			for (const half of [tail.slice(0, 4), tail.slice(4)]) {
				if (shownBefore.includes(half)) continue;
				hidden++;
				if (!after.includes(half)) continue;
				total++;
				if (revealed.length < 5)
					revealed.push({ text, half, old: before, now: after });
			}
		}
	}
	if (total > 0) throw new RevealedMoreError(revealed, total);
	return hidden;
}

const NUL = String.fromCharCode(0);

/** Pieces a JWT detector's texts are made of: segments, dots, and a hostname. */
export const JWT_PIECES: readonly string[] = Object.freeze([
	"ey",
	"eyJ",
	"eyAAAAAAAAAA",
	"eyJAAAAAAAAAA.",
	"AAAAAAAAAA.",
	"AAAAAAAAAA",
	"A",
	"9",
	".",
	"-",
	"_",
	" ",
	"my-eyewear-store.myshopify.com",
	"%",
	NUL,
]);

/** Pieces a claim or drop URL detector's texts are made of. */
export const URL_PIECES: readonly string[] = Object.freeze([
	"https://",
	"http://",
	"a.com/",
	"claim",
	"transfer",
	"drop",
	"/",
	"?",
	"#",
	"token=",
	"code=",
	"key=",
	"x",
	"-",
	"_",
	" ",
	NUL,
]);

/** Pieces a connection-string detector's texts are made of. */
export const DSN_PIECES: readonly string[] = Object.freeze([
	"postgres://",
	"postgresql://",
	"redis://",
	"rediss://",
	"mysql://",
	"mongodb://",
	"mongodb+srv://",
	"u",
	":",
	"p",
	"@",
	'"',
	"/",
	" ",
	"a",
]);

/** Pieces a private-key detector's texts are made of. */
export const PEM_PIECES: readonly string[] = Object.freeze([
	"-----BEGIN ",
	"-----BEGIN",
	"PRIVATE KEY-----",
	"RSA ",
	"EC ",
	"-",
	" ",
	"A",
]);

/** `count` texts of up to 16 of `pieces` each, from a seeded generator. */
export function* pieceTexts(
	pieces: readonly string[],
	count: number,
	seed = 20_261_109,
): Generator<string> {
	const next = seeded(seed);
	for (let index = 0; index < count; index++) {
		let text = "";
		const length = 1 + next(16);
		for (let piece = 0; piece < length; piece++)
			text += pieces[next(pieces.length)];
		yield text;
	}
}

export class FoundLessError extends Error {
	readonly code = "DETECTOR_FOUND_LESS" as const;
	readonly missed: readonly string[];

	constructor(missed: readonly string[], total: number) {
		super(
			`missed ${total} texts the old detector found, first: ${missed
				.map((text) => JSON.stringify(text))
				.join("; ")}`,
		);
		this.name = "FoundLessError";
		this.missed = missed;
	}
}

/**
 * Throw unless `now` finds every generated text `old` found: a detector that
 * replaced another may refuse more, never less. Returns how many `old` found.
 */
export function assertFindsNoLess(
	old: (text: string) => boolean,
	now: (text: string) => boolean,
	pieces: readonly string[],
	count = 150_000,
	seed?: number,
): number {
	const missed: string[] = [];
	let total = 0;
	let found = 0;
	for (const text of pieceTexts(pieces, count, seed)) {
		if (!old(text)) continue;
		found++;
		if (now(text)) continue;
		total++;
		if (missed.length < 5) missed.push(text);
	}
	if (total > 0) throw new FoundLessError(missed, total);
	return found;
}
