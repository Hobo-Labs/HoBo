/**
 * Whether a text operation is linear, judged by how its cost grows rather than
 * by how long it takes, so the verdict does not depend on how fast or how
 * loaded the machine is.
 *
 * `measureGrowth` times the operation at three or more input lengths in a 1:2:4
 * (or wider) ladder. Each length is warmed up, then measured in several
 * interleaved rounds; the **minimum** CPU time at each length feeds a log–log
 * slope and doubling-step ratios, so a single inflated sample on a loaded box
 * cannot trip the cap. Default calibration targets about 100 ms of CPU on the
 * smallest length (a runtime without per-thread CPU time is refused).
 *
 * Linear work has log–log slope near 1 and about 2× cost per doubled length;
 * quadratic work has slope near 2 and about 4× per doubling.
 * LINEAR_GROWTH_LIMIT (8) bounds the overall 4× size jump; step limits sit
 * between linear and quadratic doubling.
 *
 * One bound is absolute, HANG_BACKSTOP_MS (20 s) for a single run: it catches
 * only an operation that has stopped returning, not a slow machine.
 *
 * `assertGrowsLinearly` throws a NonLinearGrowthError naming the growth, so a
 * test only calls it. Reached through the `@hobo/redaction-test-harness/linear-time` subpath; the
 * redaction tests in every provider package share it.
 */

export const LINEAR_GROWTH_LIMIT = 8;

/** Max allowed cost ratio when input length doubles (linear ≈ 2, quadratic ≈ 4). */
export const LINEAR_DOUBLING_LIMIT = 3.25;

/** Max log–log slope (linear ≈ 1, quadratic ≈ 2). */
export const LINEAR_LOG_SLOPE_LIMIT = 1.55;

export const HANG_BACKSTOP_MS = 20_000;

export type GrowthPoint = Readonly<{
	readonly length: number;
	readonly minMs: number;
}>;

export type Growth = {
	/** Smallest measured input length. */
	readonly length: number;
	/** How many times the operation ran within each timed run. */
	readonly repeat: number;
	/**
	 * False when even `MAX_REPEAT` runs on the smallest size took under `minMs`:
	 * the operation costs next to nothing, and its shape is mostly clock noise.
	 */
	readonly calibrated: boolean;
	/** Minimum CPU ms at `length` (smallest size). */
	readonly smallMs: number;
	/** Minimum CPU ms at the largest measured size. */
	readonly largeMs: number;
	/** largeMs / smallMs (largest over smallest in the ladder). */
	readonly ratio: number;
	/** Every length in the ladder with its minimum CPU ms. */
	readonly points: readonly GrowthPoint[];
	/** Least-squares slope of log(ms) vs log(length). */
	readonly logLogSlope: number;
};

export type GrowthOptions = {
	/**
	 * The first length tried (default 4096: below it, a quadratic term is too
	 * small to tell from timer noise, and one slow run at a tiny size could pass).
	 */
	readonly startLength?: number;
	/** Smallest length must reach this much CPU time before measuring (default 100 ms). */
	readonly minMs?: number;
	/**
	 * Length stops doubling here (default 2^18, so the largest ladder step is at
	 * most 1 Mi characters: larger texts add GC costs that grow faster than the work).
	 */
	readonly maxLength?: number;
	/** Interleaved measurement rounds per length once calibrated (default 7). */
	readonly runs?: number;
	/** Discarded warmup rounds across the ladder before measuring (default 1). */
	readonly warmupRuns?: number;
	/** How many doubling steps after the smallest length (default 2 → lengths L, 2L, 4L). */
	readonly ladderSteps?: number;
};

export class OperationHangError extends Error {
	readonly code = "OPERATION_HANG" as const;
	/** How long the run took before the backstop stopped it, in wall time. */
	readonly wallMs: number;

	constructor(length: number, ms: number) {
		super(
			`one run on ${length} characters took ${Math.round(ms)} ms, past the ${HANG_BACKSTOP_MS} ms backstop`,
		);
		this.name = "OperationHangError";
		this.wallMs = ms;
	}
}

/**
 * The CPU time this thread has used, in milliseconds: what one run of the
 * operation costs, whatever else the machine is running. Wall time on a loaded
 * machine includes every slice other processes and threads took meanwhile, and
 * those slices are what made a ratio of two wall times flake. A runtime with
 * no per-thread CPU clock (`process.threadCpuUsage`, Node 22.19 and later; the
 * engines range allows older 22.x) is refused rather than measured by wall
 * time, which would bring the flakes back without saying so.
 */
function cpuMs(): number {
	const used = globalThis.process?.threadCpuUsage?.();
	if (used === undefined) throw new MissingCpuClockError();
	return (used.user + used.system) / 1000;
}

export class MissingCpuClockError extends Error {
	readonly code = "CPU_CLOCK_MISSING" as const;

	constructor() {
		super(
			"this runtime has no per-thread CPU clock (process.threadCpuUsage), so growth cannot be measured without the wall-clock noise it exists to avoid",
		);
		this.name = "MissingCpuClockError";
	}
}

/** The most times one timed run repeats the operation. */
export const MAX_REPEAT = 1024;

/** Middle value; even-length inputs use the mean of the two central samples. */
export function medianCpuMs(samples: readonly number[]): number {
	if (samples.length === 0) return 0;
	const sorted = [...samples].sort((left, right) => left - right);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
	const lower = sorted[mid - 1];
	const upper = sorted[mid];
	if (lower === undefined || upper === undefined) return 0;
	return (lower + upper) / 2;
}

export function minCpuMs(samples: readonly number[]): number {
	if (samples.length === 0) return 0;
	return Math.min(...samples);
}

/** Least-squares slope of log(minMs) vs log(length); linear ≈ 1, quadratic ≈ 2. */
export function logLogSlope(points: readonly GrowthPoint[]): number {
	const valid = points.filter(
		(point) => point.length > 0 && point.minMs > 0,
	);
	if (valid.length < 2) return Number.NaN;
	const logs = valid.map((point) => ({
		x: Math.log(point.length),
		y: Math.log(point.minMs),
	}));
	const meanX = logs.reduce((sum, point) => sum + point.x, 0) / logs.length;
	const meanY = logs.reduce((sum, point) => sum + point.y, 0) / logs.length;
	let numerator = 0;
	let denominator = 0;
	for (const point of logs) {
		const dx = point.x - meanX;
		numerator += dx * (point.y - meanY);
		denominator += dx * dx;
	}
	return denominator === 0 ? Number.NaN : numerator / denominator;
}

/**
 * One timed run, `repeat` calls of the operation: its CPU time. Each call's
 * wall time is held to the hang backstop.
 */
function once(
	run: (input: string) => void,
	input: string,
	repeat: number,
): number {
	const startedCpu = cpuMs();
	for (let call = 0; call < repeat; call++) {
		const startedWall = performance.now();
		run(input);
		const wall = performance.now() - startedWall;
		if (wall > HANG_BACKSTOP_MS)
			throw new OperationHangError(input.length, wall);
	}
	return cpuMs() - startedCpu;
}

/** `once` for an operation that returns a promise. */
async function onceAsync(
	run: (input: string) => Promise<void>,
	input: string,
	repeat: number,
): Promise<number> {
	const startedCpu = cpuMs();
	for (let call = 0; call < repeat; call++) {
		const startedWall = performance.now();
		await run(input);
		const wall = performance.now() - startedWall;
		if (wall > HANG_BACKSTOP_MS)
			throw new OperationHangError(input.length, wall);
	}
	return cpuMs() - startedCpu;
}

/** One timed run the measurement asks for. */
type TimedRun = {
	readonly input: string;
	readonly length: number;
	readonly repeat: number;
	/** When true the caller records no sample from this run. */
	readonly warmup?: boolean;
};

function ladderLengths(
	smallest: number,
	steps: number,
	maxLength: number,
): number[] {
	const lengths: number[] = [];
	let length = smallest;
	for (let step = 0; step <= steps; step++) {
		if (length > maxLength) break;
		lengths.push(length);
		if (step < steps) length *= 2;
	}
	return lengths;
}

/**
 * The measurement, written once for both kinds of operation: it yields each
 * run it needs timed and is handed back that run's CPU time.
 */
function* growthPlan(
	input: (length: number) => string,
	options: GrowthOptions,
): Generator<TimedRun, Growth, number> {
	const minMs = options.minMs ?? 100;
	const maxLength = options.maxLength ?? 262_144;
	const runs = options.runs ?? 7;
	const warmupRuns = options.warmupRuns ?? 1;
	const ladderSteps = Math.max(2, options.ladderSteps ?? 2);
	const maxSmallest = Math.max(
		options.startLength ?? 4096,
		maxLength >> ladderSteps,
	);
	let length = options.startLength ?? 4096;
	let repeat = 1;
	let smallMs = yield {
		input: input(length),
		length,
		repeat,
	};
	while (smallMs < minMs && length * 2 <= maxSmallest) {
		length *= 2;
		smallMs = yield { input: input(length), length, repeat };
	}
	const smallest = length;
	const smallInput = input(smallest);
	while (smallMs < minMs && repeat * 2 <= MAX_REPEAT) {
		repeat *= 2;
		smallMs = yield { input: smallInput, length: smallest, repeat };
	}
	const calibrated = smallMs >= minMs;
	const lengths = ladderLengths(smallest, ladderSteps, maxLength);
	if (lengths.length < 2) {
		throw new Error("growth ladder must include at least two lengths");
	}
	const samples = new Map<number, number[]>(
		lengths.map((ladderLength) => [ladderLength, []]),
	);
	for (let round = 0; round < warmupRuns; round++) {
		for (const ladderLength of lengths) {
			yield {
				input: input(ladderLength),
				length: ladderLength,
				repeat,
				warmup: true,
			};
		}
	}
	for (let round = 0; round < runs; round++) {
		for (const ladderLength of lengths) {
			const ms = yield {
				input: input(ladderLength),
				length: ladderLength,
				repeat,
			};
			samples.get(ladderLength)?.push(ms);
		}
	}
	const points: GrowthPoint[] = lengths.map((ladderLength) => ({
		length: ladderLength,
		minMs: minCpuMs(samples.get(ladderLength) ?? []),
	}));
	const first = points[0];
	const last = points.at(-1);
	if (!first || !last) throw new Error("growth ladder produced no points");
	const largeMs = last.minMs;
	smallMs = first.minMs;
	const slope = logLogSlope(points);
	return {
		length: smallest,
		repeat,
		calibrated,
		smallMs,
		largeMs,
		ratio: largeMs / Math.max(smallMs, 0.001),
		points,
		logLogSlope: slope,
	};
}

/** How `run`'s cost grows across the measurement ladder. */
export function measureGrowth(
	run: (input: string) => void,
	input: (length: number) => string,
	options: GrowthOptions = {},
): Growth {
	const plan = growthPlan(input, options);
	let step = plan.next();
	while (step.done !== true) {
		const ms = once(run, step.value.input, step.value.repeat);
		step = step.value.warmup ? plan.next() : plan.next(ms);
	}
	return step.value;
}

/** `measureGrowth` for an operation that returns a promise. */
export async function measureGrowthAsync(
	run: (input: string) => Promise<void>,
	input: (length: number) => string,
	options: GrowthOptions = {},
): Promise<Growth> {
	const plan = growthPlan(input, options);
	let step = plan.next();
	while (step.done !== true) {
		const ms = await onceAsync(run, step.value.input, step.value.repeat);
		step = step.value.warmup ? plan.next() : plan.next(ms);
	}
	return step.value;
}

/**
 * Options for a negative control, a pattern expected to fail the measure:
 * quadratic work shows its 16x at small n, so it is calibrated from 1 kB,
 * capped at 32 kB, timed once a size, and costs well under a second of CPU
 * where the defaults would spend most of a minute on it.
 */
export const NEGATIVE_CONTROL: GrowthOptions = Object.freeze({
	startLength: 1024,
	maxLength: 32_768,
	minMs: 20,
	runs: 3,
	ladderSteps: 2,
});

function doublingRatios(points: readonly GrowthPoint[]): number[] {
	const ratios: number[] = [];
	for (let index = 1; index < points.length; index++) {
		const prev = points[index - 1];
		const next = points[index];
		if (!prev || !next || prev.minMs <= 0) continue;
		ratios.push(next.minMs / prev.minMs);
	}
	return ratios;
}

/**
 * Linear: log–log slope and doubling steps stay below the linear caps, or the
 * operation costs next to nothing (`calibrated` false) and the largest size
 * stayed under LINEAR_GROWTH_LIMIT × `minMs`.
 */
export function grewLinearly(growth: Growth, minMs = 100): boolean {
	if (!growth.calibrated) {
		return growth.largeMs < LINEAR_GROWTH_LIMIT * minMs;
	}
	if (growth.ratio >= LINEAR_GROWTH_LIMIT) return false;
	if (
		Number.isFinite(growth.logLogSlope) &&
		growth.logLogSlope > LINEAR_LOG_SLOPE_LIMIT
	)
		return false;
	for (const step of doublingRatios(growth.points)) {
		if (step >= LINEAR_DOUBLING_LIMIT) return false;
	}
	return true;
}

/** A text of `length` characters: `unit` repeated, after an optional prefix. */
export function repeatedTo(
	unit: string,
	prefix = "",
): (length: number) => string {
	return (length) =>
		prefix +
		unit.repeat(Math.max(1, Math.ceil((length - prefix.length) / unit.length)));
}

export class NonLinearGrowthError extends Error {
	readonly code = "NONLINEAR_GROWTH" as const;
	readonly growth: Growth;

	constructor(growth: Growth) {
		const largest = growth.points.at(-1)?.length ?? 4 * growth.length;
		super(
			`cost grew ${growth.ratio.toFixed(1)}x from ${growth.length} to ${largest} characters (${growth.smallMs.toFixed(2)} ms to ${growth.largeMs.toFixed(2)} ms of CPU at minimum samples, slope ${growth.logLogSlope.toFixed(2)}, ${growth.repeat} call(s) a run); linear log-slope ≈ 1 and the caps are slope ${LINEAR_LOG_SLOPE_LIMIT}, ${LINEAR_DOUBLING_LIMIT}x per doubling, ${LINEAR_GROWTH_LIMIT}x overall`,
		);
		this.name = "NonLinearGrowthError";
		this.growth = growth;
	}
}

/**
 * Throw unless `run` grows linearly on `input`, then run it once on
 * `input(finalLength)` (1 MB by default) under the hang backstop. Returns the
 * growth that was measured.
 */
export function assertGrowsLinearly(
	run: (input: string) => void,
	input: (length: number) => string,
	options: GrowthOptions & { readonly finalLength?: number } = {},
): Growth {
	const growth = measureGrowth(run, input, options);
	if (!grewLinearly(growth, options.minMs))
		throw new NonLinearGrowthError(growth);
	once(run, input(options.finalLength ?? 1_000_000), 1);
	return growth;
}

/** `assertGrowsLinearly` for an operation that returns a promise. */
export async function assertGrowsLinearlyAsync(
	run: (input: string) => Promise<void>,
	input: (length: number) => string,
	options: GrowthOptions & { readonly finalLength?: number } = {},
): Promise<Growth> {
	const growth = await measureGrowthAsync(run, input, options);
	if (!grewLinearly(growth, options.minMs))
		throw new NonLinearGrowthError(growth);
	await onceAsync(run, input(options.finalLength ?? 1_000_000), 1);
	return growth;
}
