/**
 * The nine CI signals broken down by person, repository, workflow, branch and
 * event, and trended per day: which runs the wasted minutes came from, not
 * only how many there were (ADR-0183). Needs stored history: a breakdown of
 * one page of runs read on demand says little.
 *
 * Every number comes from `ciSignals` itself, so the breakdown and the report
 * can never disagree. Each run is tagged with its position before the signals
 * are found: its workflow name gains a prefix that only the tag uses, and each
 * job's labels become the tag. Every signal keys its occurrences by workflow,
 * `workflow / job` or runner labels, so every occurrence then carries the run
 * it came from. No signal reads the workflow name except to key it and to test
 * it for "doc", which the numeric tag cannot match, and none reads labels
 * except to key them. `ciSignals` itself is called untouched for the totals.
 *
 * Pure functions.
 */
import { compareText } from "./order.js";
import {
	CI_SIGNAL_IDS,
	type CiSignalId,
	type CiSignals,
	ciSignals,
	type SignalThresholds,
} from "./signals.js";
import { type InsightRun, runJobMinutes } from "./types.js";
import { utcDay } from "./usage.js";

// public-contract: the ways a signal breakdown slices runs, in report order.
export const SIGNAL_DIMENSIONS = [
	"person",
	"repository",
	"workflow",
	"branch",
	"event",
] as const;
export type SignalDimension = (typeof SIGNAL_DIMENSIONS)[number];

/** One signal's share of a slice. */
export type SignalCount = Readonly<{
	id: CiSignalId;
	minutes: number;
	occurrences: number;
}>;

/** The runs with one value of a dimension, or of one day. */
export type SignalSlice = Readonly<{
	key: string;
	runs: number;
	/** Run time of every job in these runs, in minutes. */
	jobMinutes: number;
	/** Signal minutes over all nine signals. */
	minutes: number;
	/** Every signal, in `CI_SIGNAL_IDS` order, zero when it did not occur. */
	signals: readonly SignalCount[];
}>;

/** One UTC day of runs, by the day each run was created. */
export type SignalDay = SignalSlice & Readonly<{ day: string }>;

export type SignalBreakdown = Readonly<{
	/** Exactly what `ciSignals` returns for the same runs and thresholds. */
	signals: CiSignals;
	/** Most signal minutes first, then by key. */
	by: Readonly<{ [dimension in SignalDimension]: readonly SignalSlice[] }>;
	/** Oldest day first. */
	trend: readonly SignalDay[];
}>;

/** Separates a run's tag from the rest of a finding's key. */
const TAG_END = "\u0001";

function tagged(run: InsightRun, index: number): InsightRun {
	const tag = `${index}${TAG_END}`;
	return {
		...run,
		workflow: `${tag}${run.workflow}`,
		jobs: run.jobs.map((job) => ({ ...job, labels: [tag] })),
	};
}

type Tally = { minutes: number; occurrences: number };

/** Each signal's minutes and occurrences per run index. */
function perRun(
	runs: readonly InsightRun[],
	options: Partial<SignalThresholds> | undefined,
): ReadonlyMap<CiSignalId, ReadonlyMap<number, Tally>> {
	const found = ciSignals(runs.map(tagged), {
		...options,
		maxRows: Number.POSITIVE_INFINITY,
		minRowMinutes: 0,
	});
	const bySignal = new Map<CiSignalId, Map<number, Tally>>();
	for (const signal of found.signals) {
		const byRun = new Map<number, Tally>();
		for (const row of signal.rows) {
			const index = Number(row.key.slice(0, row.key.indexOf(TAG_END)));
			const tally = byRun.get(index) ?? { minutes: 0, occurrences: 0 };
			tally.minutes += row.minutes;
			tally.occurrences += row.occurrences;
			byRun.set(index, tally);
		}
		bySignal.set(signal.id, byRun);
	}
	return bySignal;
}

function dimensionKey(run: InsightRun, dimension: SignalDimension): string {
	switch (dimension) {
		case "person":
			return run.actor;
		case "repository":
			return run.repository;
		case "workflow":
			return run.workflow;
		case "branch":
			return run.branch;
		case "event":
			return run.event;
	}
}

function slices(
	runs: readonly InsightRun[],
	keyOf: (run: InsightRun) => string,
	found: ReadonlyMap<CiSignalId, ReadonlyMap<number, Tally>>,
): readonly SignalSlice[] {
	const indexesByKey = new Map<string, number[]>();
	runs.forEach((run, index) => {
		const key = keyOf(run);
		const indexes = indexesByKey.get(key);
		if (indexes === undefined) indexesByKey.set(key, [index]);
		else indexes.push(index);
	});
	return [...indexesByKey.entries()].map(([key, indexes]): SignalSlice => {
		const signals = CI_SIGNAL_IDS.map((id): SignalCount => {
			const byRun = found.get(id);
			let minutes = 0;
			let occurrences = 0;
			for (const index of indexes) {
				const tally = byRun?.get(index);
				minutes += tally?.minutes ?? 0;
				occurrences += tally?.occurrences ?? 0;
			}
			return { id, minutes, occurrences };
		});
		return {
			key,
			runs: indexes.length,
			jobMinutes: indexes.reduce(
				(total, index) =>
					total + (runs[index] === undefined ? 0 : runJobMinutes(runs[index])),
				0,
			),
			minutes: signals.reduce((total, signal) => total + signal.minutes, 0),
			signals,
		};
	});
}

/**
 * The nine signals over a set of run attempts, as `ciSignals` reports them,
 * with each signal's minutes and occurrences split by person (the run's
 * actor), repository, workflow, branch and event, and per UTC day of the
 * run's creation. The splits of a signal add up to its total.
 */
export function signalBreakdown(
	runs: readonly InsightRun[],
	options?: Partial<SignalThresholds>,
): SignalBreakdown {
	const found = perRun(runs, options);
	const byDimension = (dimension: SignalDimension): readonly SignalSlice[] =>
		[...slices(runs, (run) => dimensionKey(run, dimension), found)].sort(
			(left, right) =>
				right.minutes - left.minutes || compareText(left.key, right.key),
		);
	return {
		signals: ciSignals(runs, options),
		by: {
			person: byDimension("person"),
			repository: byDimension("repository"),
			workflow: byDimension("workflow"),
			branch: byDimension("branch"),
			event: byDimension("event"),
		},
		trend: [...slices(runs, (run) => utcDay(run.createdAtMs), found)]
			.sort((left, right) => compareText(left.key, right.key))
			.map((entry): SignalDay => ({ ...entry, day: entry.key })),
	};
}
