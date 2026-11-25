/**
 * Property oracles over trainable functions and their blessed gold seeds.
 * Gold suites exact-match examples; silver suites run these checks.
 */

import type { FuzzValue } from "./manifest.js";
import { hasPrototypePollution } from "./manifest.js";
import { type InvariantVerdict, verdict } from "./model.js";

// public-contract: silver-fuzz report schema id
export const TRAINABLE_FUZZ_SCHEMA = "hobo.fuzz.trainable-verdict/v1" as const;

export type TrainableFn = (input: FuzzValue) => FuzzValue;

export interface TrainableFuzzSeed {
	readonly input: FuzzValue;
	readonly output?: FuzzValue;
}

export interface TrainableFuzzReport {
	readonly schema: typeof TRAINABLE_FUZZ_SCHEMA;
	readonly methodRef: string;
	readonly ok: boolean;
	readonly numRuns: number;
	readonly deterministic: boolean;
	readonly failClosed: boolean;
	readonly noPollution: boolean;
	readonly seedHolds: boolean;
	readonly bounded: boolean;
	readonly verdicts: readonly InvariantVerdict[];
}

export interface SilverEvidence {
	readonly deterministic: boolean;
	readonly failClosed: boolean;
	readonly noPollution: boolean;
	readonly seedHolds: boolean;
	readonly bounded: boolean;
}

export const TRAINABLE_OUTPUT_BOUND = 65_536;

const ASYNC_SENTINEL = Symbol("hobo.fuzz.async-trainable");

const GARBAGE_INPUTS: readonly FuzzValue[] = [
	null,
	0,
	"",
	[],
	{ constructor: { admin: true } },
	{ __proto__: { admin: true } },
	{ toJSON: "nope" },
];

export function fuzzTrainable(
	fn: TrainableFn,
	seeds: readonly TrainableFuzzSeed[],
	opts: { methodRef?: string; numRuns?: number } = {},
): TrainableFuzzReport {
	const methodRef = opts.methodRef ?? "trainable";
	const numRuns = Math.max(1, opts.numRuns ?? 16);
	let failClosed = true;
	let sawAsync = false;
	const invokeOnce = (input: FuzzValue): FuzzValue | undefined => {
		const output = invoke(fn, input);
		if (output === ASYNC_SENTINEL) {
			sawAsync = true;
			return undefined;
		}
		return output;
	};
	const seedHolds = seeds.every((seed) => {
		if (!Object.hasOwn(seed, "output")) return true;
		return same(invokeOnce(seed.input), seed.output);
	});
	const deterministic = seeds.every((seed) =>
		same(invokeOnce(seed.input), invokeOnce(seed.input)),
	);
	const noPollution = seeds.every((seed) => {
		const output = invokeOnce(seed.input);
		return (
			!hasPrototypePollution(seed.input) &&
			!hasPrototypePollution(seed.output) &&
			!hasPrototypePollution(output)
		);
	});
	const bounded = seeds.every((seed) => withinBound(invokeOnce(seed.input)));
	const probes = [...GARBAGE_INPUTS, ...mutateSeeds(seeds, numRuns)];
	for (const input of probes) {
		const output = invokeOnce(input);
		if (hasPrototypePollution(output) || !withinBound(output)) {
			failClosed = false;
			break;
		}
	}
	if (sawAsync) failClosed = false;

	const verdicts = [
		flag(
			"trainable-seed-holds",
			seedHolds,
			"blessed gold seeds still match",
			"trainable drifted from a blessed gold seed",
		),
		flag(
			"trainable-deterministic",
			deterministic,
			"same input produced the same output",
			"trainable is not deterministic",
		),
		flag(
			"trainable-no-pollution",
			noPollution,
			"seeds and outputs have no prototype injection",
			"prototype pollution in a seed or output",
		),
		flag(
			"trainable-fail-closed",
			failClosed,
			"malformed input did not pollute or explode the bound",
			"malformed input escaped fail-closed checks",
		),
		flag(
			"trainable-bounded",
			bounded,
			"outputs stay under the silver size bound",
			"an output exceeded the silver size bound",
		),
	];
	return {
		schema: TRAINABLE_FUZZ_SCHEMA,
		methodRef,
		ok: verdicts.every((row) => row.ok),
		numRuns: probes.length,
		deterministic,
		failClosed,
		noPollution,
		seedHolds,
		bounded,
		verdicts,
	};
}

export function silverEvidenceFromCorpus(
	seeds: readonly TrainableFuzzSeed[],
): SilverEvidence {
	return {
		deterministic: true,
		failClosed: true,
		noPollution: seeds.every(
			(seed) =>
				!hasPrototypePollution(seed.input) &&
				!hasPrototypePollution(seed.output),
		),
		seedHolds: false,
		bounded: seeds.every((seed) => withinBound(seed.output)),
	};
}

function flag(
	invariant: string,
	ok: boolean,
	pass: string,
	fail: string,
): InvariantVerdict {
	return verdict(invariant, ok, ok ? pass : fail);
}

function invoke(fn: TrainableFn, input: FuzzValue): FuzzValue | undefined {
	try {
		const output = fn(input);
		if (isThenable(output)) {
			return ASYNC_SENTINEL;
		}
		return output;
	} catch {
		return undefined;
	}
}

function isThenable(value: FuzzValue | undefined): boolean {
	if (!value || Object(value) !== value) return false;
	// SAFETY: Object identity above establishes the non-null object contract.
	const objectValue = value as object;
	return Object.getPrototypeOf(objectValue) !== null && "then" in objectValue;
}

function withinBound(value: FuzzValue | undefined): boolean {
	if (value === undefined) return true;
	try {
		return stable(value).length <= TRAINABLE_OUTPUT_BOUND;
	} catch {
		return false;
	}
}

function mutateSeeds(
	seeds: readonly TrainableFuzzSeed[],
	budget: number,
): FuzzValue[] {
	const out: FuzzValue[] = [];
	for (const seed of seeds.slice(0, budget)) {
		out.push(seed.input);
		if (Array.isArray(seed.input)) {
			out.push([...seed.input, null]);
			out.push([]);
			continue;
		}
		if (seed.input && Object(seed.input) === seed.input) {
			// SAFETY: this branch establishes an object input before spreading it.
			out.push({ ...(seed.input as object), extra: true });
			out.push({});
			out.push({ constructor: { admin: true } });
		}
	}
	return out;
}

function same(
	left: FuzzValue | undefined,
	right: FuzzValue | undefined,
): boolean {
	return stable(left) === stable(right);
}

function stable(
	value: FuzzValue | undefined,
	seen: WeakSet<object> = new WeakSet(),
): string {
	if (value === undefined) return "undefined";
	const kind = Object.prototype.toString.call(value);
	if (kind === "[object BigInt]") return `${String(value)}n`;
	if (kind === "[object Symbol]") return String(value);
	if (kind === "[object Function]") {
		// SAFETY: callable values expose the standard optional function name.
		return `fn:${(value as { name?: string }).name ?? "anonymous"}`;
	}
	if (kind === "[object Number]") {
		if (Number.isNaN(value)) return "NaN";
		if (Object.is(value, -0)) return "-0";
		if (!Number.isFinite(value)) return String(value);
	}
	if (value === null || Object(value) !== value) {
		try {
			return JSON.stringify(value);
		} catch {
			return kind;
		}
	}
	// SAFETY: Object identity above establishes the WeakSet object contract.
	const objectValue = value as object;
	if (seen.has(objectValue)) return '"[Cycle]"';
	seen.add(objectValue);
	if (value instanceof Date) {
		return `Date:${Number.isNaN(value.getTime()) ? "Invalid" : value.toISOString()}`;
	}
	if (value instanceof RegExp) return String(value);
	if (value instanceof Map) {
		const entries = [...value.entries()].map(
			([key, entry]) => `${stable(key, seen)}=>${stable(entry, seen)}`,
		);
		return `Map:{${entries.join(",")}}`;
	}
	if (value instanceof Set) {
		return `Set:[${[...value].map((entry) => stable(entry, seen)).join(",")}]`;
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stable(entry, seen)).join(",")}]`;
	}
	// SAFETY: this non-array object is traversed as a property dictionary.
	const rec = value as Record<string, FuzzValue>;
	return `{${Object.keys(rec)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stable(rec[key], seen)}`)
		.join(",")}}`;
}
