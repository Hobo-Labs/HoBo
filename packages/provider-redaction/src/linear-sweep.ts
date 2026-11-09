/**
 * A growth sweep for a text pattern: it is run on long runs of every character
 * class the pattern reads and every pair of them, on its own words with those
 * runs after them, and on runs between its literal fragments (`patternFragments`):
 * a fragment, a run, and a fragment or a terminator after it, or a terminator
 * and then a fragment. So a class nobody thought to build an input from (an
 * underscore, a run of spaces) and a literal the search looks ahead for cannot
 * hide a quadratic case.
 *
 * Each input is a run of SWEEP_LENGTH characters (2 Ki). Its call is timed
 * against the reference, the fastest of REFERENCE_SCANS scans of as many
 * characters by the redactor's own search (`referenceFloor`, once a sweep):
 * under SWEEP_SCREEN_RATIO (32) times it, the better of three calls, it is
 * linear. Linear patterns cost up to about 23 on every input of their sweeps,
 * and quadratic ones 160 or more. The screen is in wall time because a call at
 * 2 Ki takes well under the CPU clock's tick (Linux counts a thread's CPU in
 * ticks of a few milliseconds, so most calls read 0). Load only ever slows a
 * run, so it cannot lift the fastest of many scans, and a slowed call only
 * sends an input to be measured. An input above the ratio is measured as growth
 * with `measureGrowth`, in CPU time over runs long enough for that clock, and
 * must grow by less than LINEAR_GROWTH_LIMIT. A call that reaches the hang
 * backstop is an offender too, named.
 *
 * Reached through the `@hobo/provider-redaction/linear-sweep` subpath, for tests.
 */
import {
	type Growth,
	grewLinearly,
	HANG_BACKSTOP_MS,
	LINEAR_GROWTH_LIMIT,
	measureGrowth,
	OperationHangError,
} from "./linear-time.js";
import {
	CREDENTIAL_PATTERNS,
	JSON_JWT_PATTERN,
	JWT_DETECTOR,
	PRIVATE_KEY_DETECTOR,
	redactionPattern,
	redactMatches,
	SIGNED_JWT_PATTERN,
} from "./provider-redaction.js";

/**
 * Separator classes every sweep includes: what a run of a credential-shaped
 * text is broken by, or continued through.
 */
export const SEPARATOR_CLASSES: readonly string[] = Object.freeze([
	"_",
	" ",
	"\t",
	"\n",
	".",
	"-",
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
	String.fromCharCode(0),
	String.fromCharCode(7),
]);

/** What a pattern reads: the characters of its classes, and its words. */
export type SweepSpec = {
	/** One character from each class the pattern reads (`aZ9` for alphanumerics). */
	readonly alphabet: string;
	/** Literal words the pattern starts with or looks for (`Bearer`, `postgres://`). */
	readonly words?: readonly string[];
	/**
	 * Literal fragments of the pattern (`patternFragments`), each put before and
	 * after a run: `-----END` + `aaa…` + `-----END` is the shape that finds a
	 * search that reads a run again from every place a later literal could
	 * start. The words are used as fragments too.
	 */
	readonly fragments?: readonly string[];
};

export type SweepInput = {
	readonly name: string;
	readonly text: (length: number) => string;
};

function repeat(unit: string, prefix = ""): (length: number) => string {
	return (length) =>
		prefix +
		unit.repeat(Math.max(1, Math.ceil((length - prefix.length) / unit.length)));
}

/** `prefix`, `unit` repeated, `suffix`: `length` characters in all. */
function around(
	prefix: string,
	unit: string,
	suffix: string,
): (length: number) => string {
	return (length) =>
		prefix +
		unit.repeat(Math.max(1, length - prefix.length - suffix.length)) +
		suffix;
}

function shown(unit: string): string {
	return JSON.stringify(unit);
}

/** Every input a sweep builds for `spec`. */
export function sweepInputs(spec: SweepSpec): readonly SweepInput[] {
	const classes = [...new Set([...spec.alphabet, ...SEPARATOR_CLASSES])];
	const inputs: SweepInput[] = [];
	for (const one of classes)
		inputs.push({ name: `${shown(one)} repeated`, text: repeat(one) });
	for (const first of classes)
		for (const second of classes)
			if (first !== second)
				inputs.push({
					name: `${shown(first + second)} repeated`,
					text: repeat(first + second),
				});
	// Every word and fragment: a word holding a fragment is not one, since the
	// fragment alone is put after a run, where the word puts more.
	const pieces = [
		...new Set([...(spec.words ?? []), ...(spec.fragments ?? [])]),
	];
	for (const prefix of ["", ...pieces])
		for (const one of classes) {
			for (const suffix of pieces)
				inputs.push({
					name: `${shown(prefix)}, ${shown(one)} repeated, ${shown(suffix)}`,
					text: around(prefix, one, suffix),
				});
			// A run that ends at each terminator, where a search that read it to
			// its end has to give it back.
			for (const end of SEPARATOR_CLASSES)
				if (end !== one)
					inputs.push({
						name: `${shown(prefix)}, ${shown(one)} repeated, then ${shown(end)}`,
						text: around(prefix, one, end),
					});
		}
	// A run, a terminator and a fragment after it: a search that reads the run
	// and then looks ahead for a fragment it does not find reads it again from
	// every place it could give a character back (`… aaa -----END`).
	// The prefix is "" or a whole sample (a word): the run comes after a match,
	// as every fragment's own inputs above already put it after each fragment.
	for (const prefix of ["", ...(spec.words ?? [])])
		for (const one of new Set(spec.alphabet))
			for (const end of SEPARATOR_CLASSES)
				for (const suffix of pieces)
					inputs.push({
						name: `${shown(prefix)}, ${shown(one)} repeated, then ${shown(end + suffix)}`,
						text: around(prefix, one, end + suffix),
					});
	for (const word of spec.words ?? []) {
		inputs.push({ name: `${shown(word)} repeated`, text: repeat(word) });
		for (const one of classes) {
			inputs.push({
				name: `${shown(word)} then ${shown(one)} repeated`,
				text: repeat(one, word),
			});
			inputs.push({
				name: `${shown(word + one)} repeated`,
				text: repeat(word + one),
			});
		}
	}
	return inputs;
}

/** The length each input is screened at. */
export const SWEEP_LENGTH = 2048;

/**
 * An input whose call costs under this many times the reference scan's
 * (`referenceFloor`) is linear on it. Linear patterns on every input of their
 * sweeps cost up to about 23 at SWEEP_LENGTH characters, and quadratic ones 160
 * to 440 (`test/linear-time.test.ts` pins the margin).
 */
export const SWEEP_SCREEN_RATIO = 32;

/**
 * The CPU time a timed run of a screened-out input's growth must reach, and the
 * same `minMs` its verdict is read with (`grewLinearly`): read with another,
 * an uncalibrated quadratic run could pass as one that costs next to nothing.
 */
export const SWEEP_GROWTH_MIN_MS = 20;

export type SweepResult = {
	readonly input: string;
	/** The call's cost over the reference scan's best (`screenRatio`). */
	readonly ratio?: number;
	/** How long one call ran before the hang backstop stopped it. */
	readonly hungMs?: number;
	/** The growth, measured only for an input the screen could not settle. */
	readonly growth?: Growth;
};

function wallOnce(run: (input: string) => void, input: string): number {
	const started = performance.now();
	run(input);
	const wall = performance.now() - started;
	if (wall > HANG_BACKSTOP_MS) throw new OperationHangError(input.length, wall);
	return wall;
}

const NEVER = redactionPattern(/(?!)/g);

/** A linear scan of `text` by the redactor's own search: the reference cost. */
function scan(text: string): void {
	redactMatches(text, [NEVER]);
}

/**
 * A call's cost over `floor` (`referenceFloor`), the better of up to `tries`
 * calls, the next taken only while the ratio is at SWEEP_SCREEN_RATIO or more.
 */
export function screenRatio(
	run: (input: string) => void,
	text: string,
	floor = referenceFloor(text.length),
	tries = 3,
): number {
	let call = wallOnce(run, text);
	for (
		let attempt = 1;
		attempt < tries && call / floor >= SWEEP_SCREEN_RATIO;
		attempt++
	)
		call = Math.min(call, wallOnce(run, text));
	return call / floor;
}

/**
 * The reference: the fastest of REFERENCE_SCANS scans of `length` characters
 * by the redactor's own search, in milliseconds. A busy machine only slows a
 * run, so the fastest of many is as near the scan's real cost as the clock
 * shows, and load cannot lift it: a slowed call reads high, which costs a
 * growth measurement and misjudges nothing, and only a lifted reference could
 * read a quadratic call low, which would take every one of the scans slowed.
 * Plain ASCII is the cheapest text to scan, so an input's own scan costs at
 * least this.
 */
export function referenceFloor(length = SWEEP_LENGTH): number {
	const text = "a".repeat(length);
	let floor = Number.POSITIVE_INFINITY;
	for (let scanned = 0; scanned < REFERENCE_SCANS; scanned++)
		floor = Math.min(floor, wallOnce(scan, text));
	return Math.max(floor, 0.001);
}

/** How many scans the reference is the fastest of. */
export const REFERENCE_SCANS = 32;

export type SweepOptions = {
	/** The length each input is screened at (default SWEEP_LENGTH). */
	readonly length?: number;
	/** Stop at the first input that is not linear (for a negative control). */
	readonly failFast?: boolean;
};

/** The sweep's result for every input. */
export function sweepGrowth(
	run: (input: string) => void,
	spec: SweepSpec,
	options: SweepOptions = {},
): readonly SweepResult[] {
	const length = options.length ?? SWEEP_LENGTH;
	const floor = referenceFloor(length);
	const results: SweepResult[] = [];
	for (const input of sweepInputs(spec)) {
		let result: SweepResult;
		try {
			result = judgeInput(run, input, length, floor);
		} catch (error) {
			if (!(error instanceof OperationHangError)) throw error;
			result = { input: input.name, hungMs: error.wallMs };
		}
		results.push(result);
		if (options.failFast && offends(result)) break;
	}
	return results;
}

/** Whether a sweep result is not linear: it hung, or grew by the limit or more. */
export function offends(result: SweepResult): boolean {
	return (
		result.hungMs !== undefined ||
		(result.growth !== undefined &&
			!grewLinearly(result.growth, SWEEP_GROWTH_MIN_MS))
	);
}

/**
 * One input: its call on `length` characters over `floor`, the reference scan's
 * best (`referenceFloor`), the better of up to three calls (`screenRatio`). Under
 * SWEEP_SCREEN_RATIO it is linear. Above it, the growth from n to 4n is
 * measured in CPU time (`measureGrowth`), where linear work gives about 4 and
 * quadratic about 16.
 */
export function judgeInput(
	run: (input: string) => void,
	input: SweepInput,
	length = SWEEP_LENGTH,
	floor = referenceFloor(length),
): SweepResult {
	const ratio = screenRatio(run, input.text(length), floor);
	if (ratio < SWEEP_SCREEN_RATIO) return { input: input.name, ratio };
	const growth = measureGrowth(run, input.text, {
		startLength: Math.max(256, length / 8),
		maxLength: length,
		minMs: SWEEP_GROWTH_MIN_MS,
		runs: 2,
	});
	return { input: input.name, ratio, growth };
}

export class SweepGrowthError extends Error {
	readonly code = "SWEEP_NONLINEAR" as const;
	readonly offenders: readonly SweepResult[];

	constructor(offenders: readonly SweepResult[]) {
		super(
			`grew ${LINEAR_GROWTH_LIMIT}x or more on: ${offenders
				.map((offender) =>
					offender.hungMs === undefined
						? `${offender.input} (${offender.growth?.ratio.toFixed(1)}x from ${offender.growth?.length} characters)`
						: `${offender.input} (one call ran ${Math.round(offender.hungMs)} ms)`,
				)
				.join("; ")}`,
		);
		this.name = "SweepGrowthError";
		this.offenders = offenders;
	}
}

/** Throw unless `run` grows linearly on every input the sweep builds. */
export function assertSweepLinear(
	run: (input: string) => void,
	spec: SweepSpec,
	options: SweepOptions = {},
): readonly SweepResult[] {
	const results = sweepGrowth(run, spec, options);
	const offenders = results.filter(offends);
	if (offenders.length > 0) throw new SweepGrowthError(offenders);
	return results;
}

/**
 * The literal words a pattern's source spells out (`console`, `Token`,
 * `postgres`), each run of three or more letters: what a sweep builds its
 * word inputs from when nobody lists them.
 */
export function patternWords(pattern: RegExp): readonly string[] {
	return [...new Set(pattern.source.match(/[A-Za-z]{3,}/gu) ?? [])];
}

const CLASS_ESCAPES = new Set("dDwWsSbB");

/** The literal a `\\x` escape stands for, or undefined for a class (`\\s`). */
function escaped(next: string): string | undefined {
	if (CLASS_ESCAPES.has(next)) return undefined;
	if (next === "n") return "\n";
	if (next === "t") return "\t";
	if (next === "r") return "\r";
	return next;
}

/**
 * Where a character class that starts at `from` ends: the index of its `]`.
 */
function classEnd(source: string, from: number): number {
	let at = from + 1;
	if (source[at] === "^") at++;
	if (source[at] === "]") at++;
	while (at < source.length && source[at] !== "]")
		at += source[at] === "\\" ? 2 : 1;
	return at;
}

/** Where a group's modifiers (`?:`, `?=`, `?<!`, `?<name>`) end, from its `(`. */
function groupBodyStart(source: string, open: number): number {
	if (source[open + 1] !== "?") return open + 1;
	const kind = source[open + 2];
	if (kind === "<" && (source[open + 3] === "=" || source[open + 3] === "!"))
		return open + 4;
	if (kind === "<") return source.indexOf(">", open) + 1;
	return open + 3;
}

/**
 * The literal fragments of a pattern's source: every run of three or more
 * characters it spells out (`-----BEGIN`, `PRIVATE KEY-----`, `://`, `Bearer`),
 * and `=` and `:` where it reads them. A character a quantifier follows is not
 * part of the run before it (`rediss?` gives `redis`).
 */
export function patternFragments(pattern: RegExp): readonly string[] {
	const source = pattern.source;
	const found = new Set<string>();
	let literal = "";
	const flush = (): void => {
		if (literal.length >= 3) found.add(literal);
		for (const separator of ["=", ":"])
			if (literal.includes(separator)) found.add(separator);
		literal = "";
	};
	for (let at = 0; at < source.length; at++) {
		const char = source.charAt(at);
		if (char === "\\") {
			const next = source.charAt(++at);
			const meant = escaped(next);
			if (meant === undefined || next === "p" || next === "P") {
				if (next === "p" || next === "P") at = source.indexOf("}", at);
				flush();
			} else literal += meant;
		} else if (char === "[") {
			flush();
			at = classEnd(source, at);
		} else if ("?*+{".includes(char)) {
			literal = literal.slice(0, -1);
			flush();
			if (char === "{") at = source.indexOf("}", at);
			if (source[at + 1] === "?") at++;
		} else if (char === "(") {
			flush();
			at = groupBodyStart(source, at) - 1;
		} else if (")|^$.".includes(char)) {
			flush();
		} else literal += char;
	}
	flush();
	return longest([...found]);
}

/** `pieces` without one inside a longer one, separators (one character) kept. */
function longest(pieces: readonly string[]): string[] {
	return pieces.filter(
		(piece) =>
			piece.length === 1 ||
			!pieces.some((other) => other !== piece && other.includes(piece)),
	);
}

const SHARED_PATTERNS = new Set<RegExp>([
	...CREDENTIAL_PATTERNS,
	JSON_JWT_PATTERN,
	JWT_DETECTOR,
	PRIVATE_KEY_DETECTOR,
	SIGNED_JWT_PATTERN,
]);

/**
 * `patterns` without the shared ones (`@hobo/provider-redaction`'s own
 * objects), which core's tests sweep: what a caller adds.
 */
export function ownPatterns(patterns: readonly RegExp[]): readonly RegExp[] {
	return patterns.filter((pattern) => !SHARED_PATTERNS.has(pattern));
}

/** Every pattern a redaction profile searches: its own, its fallbacks, its keep. */
export function profilePatterns(profile: {
	readonly patterns?: readonly RegExp[];
	readonly fallbacks?: readonly RegExp[];
	readonly keep?: RegExp;
}): readonly RegExp[] {
	return [
		...(profile.patterns ?? []),
		...(profile.fallbacks ?? []),
		...(profile.keep === undefined ? [] : [profile.keep]),
	];
}

/**
 * Throw unless the redactor's search of `pattern` over a text grows linearly
 * on the whole sweep, with `aZ9` and the pattern's own fragments
 * (`patternFragments`) unless `spec` says otherwise.
 */
export function assertPatternSweepLinear(
	pattern: RegExp,
	spec: SweepSpec = { alphabet: "aZ9", fragments: patternFragments(pattern) },
): readonly SweepResult[] {
	const flags = pattern.flags.includes("g")
		? pattern.flags
		: `${pattern.flags}g`;
	const search = redactionPattern(new RegExp(pattern.source, flags));
	return assertSweepLinear((text) => {
		redactMatches(text, [search]);
	}, spec);
}
