/**
 * A growth sweep for a text pattern: it is run on long runs of every character
 * class the pattern reads and every pair of them, and on its own words with
 * those runs after them, so a class nobody thought to build an input from (an
 * underscore, a run of spaces) cannot hide a quadratic case.
 *
 * Each input is a run of n characters. One call on n = 64 Ki characters that
 * takes under SWEEP_FLOOR_MS of CPU is linear on it: a quadratic search of 64 Ki
 * characters, even one that starts again only at every 27th character, takes
 * tens of milliseconds or more, against a fraction of a millisecond for a
 * linear one. An input above the floor is timed again as four calls on a
 * quarter of the length, which cost the same as the one call if the pattern is
 * linear and a quarter of it if it is quadratic, and is settled when the one
 * call cost under twice the four; any other is measured as growth with
 * `measureGrowth`, from n = 1 Ki up to 16 Ki and 4n up to 64 Ki, and must grow
 * by less than LINEAR_GROWTH_LIMIT.
 *
 * Reached through the `@hobo/core/linear-sweep` subpath, for tests.
 */
import {
	type Growth,
	grewLinearly,
	HANG_BACKSTOP_MS,
	LINEAR_GROWTH_LIMIT,
	MissingCpuClockError,
	measureGrowth,
	OperationHangError,
} from "./linear-time.js";
import { redactionPattern, redactMatches } from "./provider-redaction.js";

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

/**
 * One call on SWEEP_LENGTH characters under this much CPU is linear on them: a
 * quadratic search of that many characters takes a tenth of a second or more.
 */
export const SWEEP_FLOOR_MS = 8;

/** The length of the one call that decides whether an input is measured. */
export const SWEEP_LENGTH = 65_536;

export type SweepResult = {
	readonly input: string;
	/** CPU time of one call on SWEEP_LENGTH characters. */
	readonly floorMs: number;
	/** The growth, measured only for an input above the floor. */
	readonly growth?: Growth;
};

function cpuMs(): number {
	const used = globalThis.process?.threadCpuUsage?.();
	if (used === undefined) throw new MissingCpuClockError();
	return (used.user + used.system) / 1000;
}

function timeOnce(run: (input: string) => void, input: string): number {
	const startedCpu = cpuMs();
	const startedWall = performance.now();
	run(input);
	const wall = performance.now() - startedWall;
	if (wall > HANG_BACKSTOP_MS) throw new OperationHangError(input.length, wall);
	return cpuMs() - startedCpu;
}

export type SweepOptions = {
	/** The length of the deciding call (default SWEEP_LENGTH). */
	readonly floorLength?: number;
};

function timeQuarters(run: (input: string) => void, quarter: string): number {
	let total = 0;
	for (let call = 0; call < 4; call++) total += timeOnce(run, quarter);
	return total;
}

/** The sweep's result for every input. */
export function sweepGrowth(
	run: (input: string) => void,
	spec: SweepSpec,
	options: SweepOptions = {},
): readonly SweepResult[] {
	const floorLength = options.floorLength ?? SWEEP_LENGTH;
	return sweepInputs(spec).map((input) => {
		const floorMs = timeOnce(run, input.text(floorLength));
		if (floorMs < SWEEP_FLOOR_MS) return { input: input.name, floorMs };
		// A quick look first: four calls on a quarter of the length cost what
		// the one call did, if the pattern is linear, and a quarter of it if it is
		// quadratic. Both sides are as long as the deciding call, so long enough
		// to time; only an input that might be quadratic is measured in full.
		const quarter = input.text(floorLength / 4);
		const quartersMs = timeQuarters(run, quarter);
		if (floorMs < 2 * quartersMs) return { input: input.name, floorMs };
		const growth = measureGrowth(run, input.text, {
			startLength: 1024,
			maxLength: SWEEP_LENGTH / 4,
			minMs: 20,
			runs: 2,
		});
		return { input: input.name, floorMs, growth };
	});
}

export class SweepGrowthError extends Error {
	readonly code = "SWEEP_NONLINEAR" as const;
	readonly offenders: readonly SweepResult[];

	constructor(offenders: readonly SweepResult[]) {
		super(
			`grew ${LINEAR_GROWTH_LIMIT}x or more on: ${offenders
				.map(
					(offender) =>
						`${offender.input} (${offender.growth?.ratio.toFixed(1)}x from ${offender.growth?.length} characters)`,
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
	const offenders = results.filter(
		(result) => result.growth !== undefined && !grewLinearly(result.growth),
	);
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
 * Throw unless the redactor's search of `pattern` over a text (every match,
 * each one's value searched again from its first whitespace) grows linearly
 * on the whole sweep, with `aZ9` and the pattern's own words unless `spec`
 * says otherwise.
 */
export function assertPatternSweepLinear(
	pattern: RegExp,
	spec: SweepSpec = { alphabet: "aZ9", words: patternWords(pattern) },
): readonly SweepResult[] {
	const flags = pattern.flags.includes("g")
		? pattern.flags
		: `${pattern.flags}g`;
	const search = redactionPattern(new RegExp(pattern.source, flags));
	return assertSweepLinear((text) => {
		redactMatches(text, [search]);
	}, spec);
}
