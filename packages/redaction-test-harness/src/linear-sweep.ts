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
 * sends an input to be measured.
 *
 * How many reference scans a quadratic call costs depends on the machine: the
 * regular expression engine's inner loop against the reference's. Where the
 * engine is quick, a search that starts once a period reads under the ratio
 * (28 for `ab{7}[ab]*!` on one machine, 160 on another). So an input under
 * the ratio is also called on four times the length, the better of up to
 * SCREEN_GROWTH_CALLS calls at each (`screenGrowth`): a call that grew
 * LINEAR_GROWTH_LIMIT times or more is not settled either, whatever its ratio.
 * That is a ratio of two calls of the same search, which no machine's speed
 * changes.
 *
 * An input the screen does not settle is measured as growth with
 * `measureGrowth`, in CPU time over runs long enough for that clock, and must
 * grow by less than LINEAR_GROWTH_LIMIT. A call that reaches the hang backstop
 * is an offender too, named.
 *
 * Reached through the `@hobo/redaction-test-harness/linear-sweep` subpath, for tests.
 */
import {
	type Growth,
	grewLinearly,
	HANG_BACKSTOP_MS,
	LINEAR_GROWTH_LIMIT,
	measureGrowth,
	OperationHangError,
} from "./linear-time.js";

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
	/**
	 * How many times the sweep's length this input is screened at: a periodic
	 * input with a long period starts a match once a period, so a quadratic
	 * search shows only once the text holds many periods.
	 */
	readonly scale?: number;
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

/** The periods of the sweep's periodic inputs. */
export const PERIODS: readonly number[] = Object.freeze([4, 16, 64]);

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
	// Every piece over and over, alone and with each separator after it: a
	// search that starts at each copy and reads on to the end
	// (`(?:xyz)+!`, `Bearer[^!]*!`) starts once a copy.
	for (const piece of pieces) {
		inputs.push({ name: `${shown(piece)} repeated`, text: repeat(piece) });
		for (const separator of SEPARATOR_CLASSES)
			inputs.push({
				name: `${shown(piece + separator)} repeated`,
				text: repeat(piece + separator),
			});
	}
	// Periodic texts: one character and then another for the rest of a period,
	// over and over. A search that needs the long part before it can start
	// (`ab{7}[ab]*!`) starts once a period, which no run of one class or of a
	// pair shows; the text is screened at as many periods as a short one.
	for (const period of PERIODS)
		for (const first of classes)
			for (const rest of new Set(spec.alphabet))
				if (first !== rest)
					inputs.push({
						name: `${shown(first)} and ${period - 1} of ${shown(rest)}, repeated`,
						text: repeat(first + rest.repeat(period - 1)),
						scale: Math.max(1, period / 8),
					});
	for (const word of spec.words ?? []) {
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
 * An input whose call costs this many times the reference scan's
 * (`referenceFloor`) or more is measured. Linear patterns on every input of
 * their sweeps cost up to about 23 at SWEEP_LENGTH characters, and quadratic
 * ones 160 to 440 where this was set (`test/linear-time.deep.test.ts` pins the
 * margin for a search that starts at every character). The margin is the
 * machine's, so an input under the ratio is screened by its growth too
 * (`screenGrowth`).
 */
export const SWEEP_SCREEN_RATIO = 32;

/** The most calls at each of the two lengths `screenGrowth` takes the best of. */
export const SCREEN_GROWTH_CALLS = 3;

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
	/**
	 * The call's cost on four times the length over its cost on the length
	 * (`screenGrowth`), for an input under the ratio.
	 */
	readonly screenGrowth?: number;
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

const NEVER = /(?!)/g;

/**
 * The default reference: one pass over `text` reading each character's code
 * (as a redactor's control-character check does) and a search that fails at
 * every position. What a redactor that finds nothing costs, about.
 */
export function referenceScan(text: string): void {
	let controls = 0;
	for (let at = 0; at < text.length; at++)
		if (text.charCodeAt(at) < 32) controls++;
	NEVER.lastIndex = 0;
	if (NEVER.exec(text) !== null || controls < 0)
		throw new Error("a search that fails everywhere matched");
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
 * How a call's cost grows from `small` to `large`, a text four times as long,
 * in wall time: the better of up to `calls` calls on each, the two taking
 * turns, and `smallMs`, a call on `small` already timed (`screenRatio`'s).
 * Linear work reads about 4 and quadratic about 16, on any machine. A reading
 * under LINEAR_GROWTH_LIMIT ends it: load only slows a call, so a quadratic
 * call reads under the limit only with every call on `small` so far slowed to
 * twice its cost, and a reading at or over it is taken again, since one slowed
 * call on `large` gives that too. A call too quick for the clock counts as one
 * microsecond, which only lowers the ratio of a call that costs next to
 * nothing at both lengths.
 */
export function screenGrowth(
	run: (input: string) => void,
	small: string,
	large: string,
	smallMs = Number.POSITIVE_INFINITY,
	calls = SCREEN_GROWTH_CALLS,
): number {
	let shortMs = smallMs;
	let longMs = Number.POSITIVE_INFINITY;
	const growth = (): number => longMs / Math.max(shortMs, 0.001);
	for (let call = 0; call < calls; call++) {
		longMs = Math.min(longMs, wallOnce(run, large));
		shortMs = Math.min(shortMs, wallOnce(run, small));
		if (growth() < LINEAR_GROWTH_LIMIT) break;
	}
	return growth();
}

/**
 * The reference: the fastest of at least REFERENCE_SCANS scans of `length`
 * characters by `scan` (`referenceScan`, or a redactor's own search with a
 * pattern that never matches), in milliseconds. A busy machine only slows a
 * run, so the fastest of many is as near the scan's real cost as the clock
 * shows, and load cannot lift it: a slowed call reads high, which costs a
 * growth measurement and misjudges nothing, and only a lifted reference could
 * read a quadratic call low, which would take every one of the scans slowed.
 * Plain ASCII is the cheapest text to scan, so an input's own scan costs at
 * least this.
 */
export function referenceFloor(
	length = SWEEP_LENGTH,
	scan: (text: string) => void = referenceScan,
): number {
	const text = "a".repeat(length);
	const cached = floors.get(scan)?.get(length);
	let floor = cached ?? Number.POSITIVE_INFINITY;
	// The first scans run before the engine has compiled the scan, and a floor
	// from them would be lifted: a quadratic call read against it could pass.
	// So scan until REFERENCE_SCANS have run and the last half of them found
	// nothing faster; a floor taken before is only ever lowered.
	let since = 0;
	for (
		let scanned = 0;
		scanned < MAX_REFERENCE_SCANS &&
		(scanned < (cached === undefined ? REFERENCE_SCANS : 4) ||
			since < REFERENCE_SCANS / 2);
		scanned++
	) {
		const took = wallOnce(scan, text);
		if (took < floor) {
			floor = took;
			since = 0;
		} else since++;
	}
	floor = Math.max(floor, 0.001);
	const byLength = floors.get(scan) ?? new Map<number, number>();
	byLength.set(length, floor);
	floors.set(scan, byLength);
	return floor;
}

// One floor per reference and length for the whole process, lowered by every
// sweep that scans faster: load can only lift a scan, never speed one up.
const floors = new Map<(text: string) => void, Map<number, number>>();

/** How many scans the reference is the fastest of. */
export const REFERENCE_SCANS = 32;

/** The most scans one call to `referenceFloor` takes. */
const MAX_REFERENCE_SCANS = 1024;

export type SweepOptions = {
	/** The length each input is screened at (default SWEEP_LENGTH). */
	readonly length?: number;
	/** Stop at the first input that is not linear (for a negative control). */
	readonly failFast?: boolean;
	/**
	 * The reference a call is screened against (`referenceScan` by default): a
	 * redactor's own search with a pattern that never matches, for a sweep of
	 * that redactor, so the screen's ratio is of like with like.
	 */
	readonly reference?: (text: string) => void;
};

/** The sweep's result for every input. */
export function sweepGrowth(
	run: (input: string) => void,
	spec: SweepSpec,
	options: SweepOptions = {},
): readonly SweepResult[] {
	const base = options.length ?? SWEEP_LENGTH;
	const results: SweepResult[] = [];
	for (const input of sweepInputs(spec)) {
		const length = base * (input.scale ?? 1);
		let result: SweepResult;
		try {
			result = judgeInput(
				run,
				input,
				length,
				referenceFloor(length, options.reference),
			);
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
 * best (`referenceFloor`), the better of up to three calls (`screenRatio`), and,
 * under SWEEP_SCREEN_RATIO, how the call grows to four times the length
 * (`screenGrowth`). Under the ratio and under LINEAR_GROWTH_LIMIT it is linear.
 * Otherwise the growth from n to 4n is measured in CPU time (`measureGrowth`),
 * where linear work gives about 4 and quadratic about 16.
 */
export function judgeInput(
	run: (input: string) => void,
	input: SweepInput,
	length = SWEEP_LENGTH,
	floor = referenceFloor(length),
): SweepResult {
	const text = input.text(length);
	const ratio = screenRatio(run, text, floor);
	const screened =
		ratio < SWEEP_SCREEN_RATIO
			? {
					screenGrowth: screenGrowth(
						run,
						text,
						input.text(4 * length),
						ratio * floor,
					),
				}
			: {};
	if (
		screened.screenGrowth !== undefined &&
		screened.screenGrowth < LINEAR_GROWTH_LIMIT
	)
		return { input: input.name, ratio, ...screened };
	const options = {
		startLength: Math.max(256, length / 8),
		maxLength: length,
		minMs: SWEEP_GROWTH_MIN_MS,
		runs: 2,
	};
	const growth = measureGrowth(run, input.text, options);
	if (grewLinearly(growth, SWEEP_GROWTH_MIN_MS))
		return { input: input.name, ratio, ...screened, growth };
	// A heavily loaded machine can lift a CPU-time ratio past the limit too
	// (one read 8.6 at load 27 where the input grows 4.0): measured again with
	// longer runs, an input offends only if it grows past the limit both times.
	// Quadratic work grows about 16 each time, so taking the lower never passes
	// it.
	const again = measureGrowth(run, input.text, {
		...options,
		minMs: 2 * SWEEP_GROWTH_MIN_MS,
		runs: 3,
	});
	return {
		input: input.name,
		ratio,
		...screened,
		growth: again.ratio < growth.ratio ? again : growth,
	};
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

/**
 * Throw unless `run` screens linear on one fixed input (`judgeInput`, at
 * SWEEP_LENGTH characters): a millisecond or so for a linear operation, and a
 * growth measurement only when the screen reads it as quadratic. For the
 * hostile inputs a review found, held in a fast tier where a whole sweep is
 * too slow.
 */
export function assertInputLinear(
	run: (input: string) => void,
	text: (length: number) => string,
	name = "input",
	options: SweepOptions = {},
): SweepResult {
	const length = options.length ?? SWEEP_LENGTH;
	let result: SweepResult;
	try {
		result = judgeInput(
			run,
			{ name, text },
			length,
			referenceFloor(length, options.reference),
		);
	} catch (error) {
		if (!(error instanceof OperationHangError)) throw error;
		result = { input: name, hungMs: error.wallMs };
	}
	if (offends(result)) throw new SweepGrowthError([result]);
	return result;
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

/**
 * The escape at `source[at]` (a backslash): the character it stands for
 * (`\\n`, `\\u017F`, `\\x41`, `\\-`), or a representative of the class it
 * names (`\\d` is `0`, `\\s` a space), and where it ends. `literal` says
 * whether it is one character, rather than a class.
 */
function escapeAt(source: string, at: number): Escape {
	const next = source.charAt(at + 1);
	if (next === "u" && source[at + 2] === "{") {
		const close = source.indexOf("}", at);
		const code = Number.parseInt(source.slice(at + 3, close), 16);
		return { char: String.fromCodePoint(code), literal: true, end: close };
	}
	if (next === "u" || next === "x") {
		const width = next === "u" ? 4 : 2;
		const code = Number.parseInt(source.slice(at + 2, at + 2 + width), 16);
		return {
			char: String.fromCharCode(code),
			literal: true,
			end: at + 1 + width,
		};
	}
	if (next === "p" || next === "P")
		return { char: "a", literal: false, end: source.indexOf("}", at) };
	const named = CLASS_ESCAPES.get(next);
	if (named !== undefined) return { char: named, literal: false, end: at + 1 };
	return {
		char: CONTROL_ESCAPES.get(next) ?? next,
		literal: true,
		end: at + 1,
	};
}

/** A regular expression escape, read: what it stands for and where it ends. */
type Escape = {
	readonly char: string;
	readonly literal: boolean;
	readonly end: number;
};

/** A representative of each class escape (`\\b` and `\\B` read nothing). */
const CLASS_ESCAPES = new Map([
	["d", "0"],
	["D", "a"],
	["w", "a"],
	["W", " "],
	["s", " "],
	["S", "a"],
	["b", ""],
	["B", ""],
]);

const CONTROL_ESCAPES = new Map([
	["n", "\n"],
	["t", "\t"],
	["r", "\r"],
]);

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
			const escaping = escapeAt(source, at);
			at = escaping.end;
			if (escaping.literal) literal += escaping.char;
			else flush();
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

/**
 * One character for each thing a pattern's classes hold: every literal
 * character and both ends of every range in its character classes, negated
 * ones too (their characters are what end a run), each literal character
 * outside a class (`!` in `_+!`), a representative of each
 * class escape (`\\d`, `\\w`, `\\s`, `\\S`), a letter for `.`, and, under
 * the `i` flag, the other case of each ASCII letter. So a sweep's alphabet is
 * read from the pattern rather than listed by whoever wrote the test, and a
 * class that holds `ſ` and `K` puts runs of them in the sweep.
 */
export function patternAlphabet(pattern: RegExp): string {
	const source = pattern.source;
	const found = new Set<string>();
	const add = (char: string): void => {
		if (char === "") return;
		found.add(char);
		if (pattern.flags.includes("i") && /^[A-Za-z]$/u.test(char)) {
			found.add(char.toLowerCase());
			found.add(char.toUpperCase());
		}
	};
	for (let at = 0; at < source.length; at++) {
		const char = source.charAt(at);
		if (char === "\\") {
			const escaping = escapeAt(source, at);
			at = escaping.end;
			if (!escaping.literal) add(escaping.char);
		} else if (char === ".") add("a");
		else if (char === "(") at = groupBodyStart(source, at) - 1;
		else if (char === "{") at = source.indexOf("}", at);
		else if (char === "[") {
			const end = classEnd(source, at);
			let inner = at + 1;
			if (source[inner] === "^") inner++;
			while (inner < end) {
				let one = source.charAt(inner);
				if (one === "\\") {
					const escaping = escapeAt(source, inner);
					one = escaping.char;
					inner = escaping.end;
				}
				add(one);
				inner++;
				if (source[inner] === "-" && inner + 1 < end) {
					inner++;
					let last = source.charAt(inner);
					if (last === "\\") {
						const escaping = escapeAt(source, inner);
						last = escaping.char;
						inner = escaping.end;
					}
					add(last);
					inner++;
				}
			}
			at = end;
		} else if (!")|^$?*+".includes(char)) add(char);
	}
	return [...found].join("");
}

/** `pieces` without one inside a longer one, separators (one character) kept. */
function longest(pieces: readonly string[]): string[] {
	return pieces.filter(
		(piece) =>
			piece.length === 1 ||
			!pieces.some((other) => other !== piece && other.includes(piece)),
	);
}

/**
 * `patterns` without the `shared` ones (by identity): what a caller adds to a
 * shared redactor, and so what its own tests sweep.
 */
export function ownPatterns(
	patterns: readonly RegExp[],
	shared: readonly RegExp[],
): readonly RegExp[] {
	const known = new Set(shared);
	return patterns.filter((pattern) => !known.has(pattern));
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

/** How a pattern is searched over a text: a redactor's own search, say. */
export type PatternSearch = (text: string, pattern: RegExp) => void;

/**
 * `pattern` if it is global, or a global copy of it, the same copy each time:
 * what a redactor's search needs from a detector written for `test`.
 */
export function asGlobal(pattern: RegExp): RegExp {
	if (pattern.global) return pattern;
	const known = globalCopies.get(pattern);
	if (known !== undefined) return known;
	const copy = new RegExp(pattern.source, `${pattern.flags}g`);
	globalCopies.set(pattern, copy);
	return copy;
}

const globalCopies = new WeakMap<RegExp, RegExp>();

/** Every match of a global copy of `pattern`, as `matchAll` finds them. */
export function matchAllSearch(text: string, pattern: RegExp): void {
	const global = asGlobal(pattern);
	global.lastIndex = 0;
	for (const match of text.matchAll(global))
		if (match.index < 0) throw new Error("a match before the text");
}

/** The sweep spec read from a pattern: its classes, `aZ9`, its fragments. */
export function patternSpec(
	pattern: RegExp,
	extra: Partial<SweepSpec> = {},
): SweepSpec {
	return {
		alphabet: `aZ9${patternAlphabet(pattern)}${extra.alphabet ?? ""}`,
		words: extra.words ?? [],
		fragments: [...patternFragments(pattern), ...(extra.fragments ?? [])],
	};
}

/**
 * Throw unless `search` of `pattern` over a text grows linearly on the whole
 * sweep of `patternSpec(pattern)` (its own classes and fragments), screened
 * against `search` with a pattern that never matches.
 */
export function assertPatternSweepLinear(
	pattern: RegExp,
	search: PatternSearch = matchAllSearch,
	spec: SweepSpec = patternSpec(pattern),
	options: SweepOptions = {},
): readonly SweepResult[] {
	const run = (text: string): void => search(text, pattern);
	if (search === matchAllSearch) return assertSweepLinear(run, spec, options);
	return assertSweepLinear(run, spec, {
		reference: referenceFor(search, /(?!)/g),
		...options,
	});
}

// One reference function per search, so the floor cache holds one floor for
// each rather than a new one per call.
const references = new WeakMap<PatternSearch, (text: string) => void>();
function referenceFor(
	search: PatternSearch,
	never: RegExp,
): (text: string) => void {
	const known = references.get(search);
	if (known !== undefined) return known;
	const made = (text: string): void => search(text, never);
	references.set(search, made);
	return made;
}
