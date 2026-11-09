/**
 * Whether a text operation is linear, judged by how its cost grows rather than
 * by how long it takes, so the verdict does not depend on how fast or how
 * loaded the machine is.
 *
 * `measureGrowth` times the operation on an input of length n and on one of
 * length 4n, the better of two runs each, the two sizes taking turns, in the
 * CPU time of the thread that runs it (a runtime without that clock is
 * refused). Linear work grows about 4×, and quadratic work about 16×;
 * LINEAR_GROWTH_LIMIT (8) sits between them with a factor of two either side.
 *
 * Each timed run must be long against the clock's tick (Linux counts a
 * thread's CPU time in scheduler ticks of a few milliseconds), so n doubles
 * from 4096 until a run takes 30 ms. A quadratic operation reaches that at a
 * size it still finishes at, rather than being left to stall on a megabyte.
 * An operation so quick that n reaches its cap first is repeated within each
 * timed run instead, the same number of times at both sizes, so its ratio is
 * still a ratio of long runs.
 *
 * One bound is absolute, HANG_BACKSTOP_MS (20 s) for a single run: it catches
 * only an operation that has stopped returning, not a slow machine.
 *
 * `assertGrowsLinearly` throws a NonLinearGrowthError naming the growth, so a
 * test only calls it. Reached through the `@hobo/redaction-test-harness/linear-time` subpath; the
 * redaction tests in every provider package share it.
 */

export const LINEAR_GROWTH_LIMIT = 8;

export const HANG_BACKSTOP_MS = 20_000;

export type Growth = {
	/** n: the smaller input's length. The larger one is 4n. */
	readonly length: number;
	/** How many times the operation ran within each timed run. */
	readonly repeat: number;
	/**
	 * False when even `MAX_REPEAT` runs on n took under `minMs`: the operation
	 * costs next to nothing, and its ratio is a ratio of clock ticks.
	 */
	readonly calibrated: boolean;
	readonly smallMs: number;
	readonly largeMs: number;
	/** largeMs / smallMs. */
	readonly ratio: number;
};

export type GrowthOptions = {
	/**
	 * The first n tried (default 4096: below it, a quadratic term is too small
	 * to tell from timer noise, and one slow run at a tiny size could pass).
	 */
	readonly startLength?: number;
	/** n doubles until a timed run takes this much CPU time (default 30 ms). */
	readonly minMs?: number;
	/**
	 * n stops doubling here (default 2^18, so 4n is at most 1 Mi characters:
	 * larger texts add garbage-collection costs that grow faster than the work).
	 */
	readonly maxLength?: number;
	/** Runs per size once calibrated; the fastest counts (default 2). */
	readonly runs?: number;
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
type TimedRun = { readonly input: string; readonly repeat: number };

/**
 * The measurement, written once for both kinds of operation: it yields each
 * run it needs timed and is handed back that run's CPU time.
 */
function* growthPlan(
	input: (length: number) => string,
	options: GrowthOptions,
): Generator<TimedRun, Growth, number> {
	const minMs = options.minMs ?? 30;
	const maxLength = options.maxLength ?? 262_144;
	const runs = options.runs ?? 2;
	let length = options.startLength ?? 4096;
	let repeat = 1;
	// Calibrating takes one run a step: only the final sizes need the best of
	// several.
	let smallMs = yield { input: input(length), repeat };
	while (smallMs < minMs && length * 2 <= maxLength) {
		length *= 2;
		smallMs = yield { input: input(length), repeat };
	}
	const small = input(length);
	while (smallMs < minMs && repeat * 2 <= MAX_REPEAT) {
		repeat *= 2;
		smallMs = yield { input: small, repeat };
	}
	// Whether calibration reached minMs, read before the timed runs below: their
	// best can come in under it, which says the calibrating run was slowed, not
	// that the operation costs next to nothing.
	const calibrated = smallMs >= minMs;
	// The two sizes take turns, so anything that slows the machine for a while
	// slows both rather than one.
	const large = input(4 * length);
	let largeMs = Number.POSITIVE_INFINITY;
	for (let attempt = 0; attempt < runs; attempt++) {
		largeMs = Math.min(largeMs, yield { input: large, repeat });
		smallMs = Math.min(smallMs, yield { input: small, repeat });
	}
	return {
		length,
		repeat,
		calibrated,
		smallMs,
		largeMs,
		// A run too quick for the clock to see counts as one microsecond.
		ratio: largeMs / Math.max(smallMs, 0.001),
	};
}

/** How `run`'s cost grows from `input(n)` to `input(4n)`. */
export function measureGrowth(
	run: (input: string) => void,
	input: (length: number) => string,
	options: GrowthOptions = {},
): Growth {
	const plan = growthPlan(input, options);
	let step = plan.next();
	while (step.done !== true)
		step = plan.next(once(run, step.value.input, step.value.repeat));
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
	while (step.done !== true)
		step = plan.next(await onceAsync(run, step.value.input, step.value.repeat));
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
	runs: 1,
});

/**
 * Linear: the cost grew by less than LINEAR_GROWTH_LIMIT, or the operation
 * costs next to nothing (`calibrated` false) and 4n took under
 * LINEAR_GROWTH_LIMIT × `minMs`. No quadratic operation is uncalibrated: one
 * that costs under 30 µs on a quarter megabyte, repeated MAX_REPEAT times, is not
 * reading the megabyte.
 */
export function grewLinearly(growth: Growth, minMs = 30): boolean {
	return (
		growth.ratio < LINEAR_GROWTH_LIMIT ||
		(!growth.calibrated && growth.largeMs < LINEAR_GROWTH_LIMIT * minMs)
	);
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
		super(
			`cost grew ${growth.ratio.toFixed(1)}x from ${growth.length} to ${4 * growth.length} characters (${growth.smallMs.toFixed(2)} ms to ${growth.largeMs.toFixed(2)} ms of CPU, ${growth.repeat} call(s) a run); linear grows about 4x, and the limit is ${LINEAR_GROWTH_LIMIT}x`,
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
