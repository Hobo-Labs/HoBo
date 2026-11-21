/**
 * The usage report: where a set of run attempts spent Actions minutes, and
 * what running elsewhere kept off GitHub's bill (ADR-0183).
 *
 * - Billed minutes per runner type, rounded the way GitHub bills a job: up to
 *   a whole minute, never less than one.
 * - The waste in billed jobs shorter than a threshold: the part of their
 *   billed minutes they did not run.
 * - Minutes kept off GitHub-hosted runners: jobs that ran on any other runner,
 *   counted as GitHub would have billed them and priced at GitHub's rate.
 * - Relay jobs answered without a billed minute (relay mode, runner-less
 *   checks): each saved GitHub's one-minute minimum.
 * - All of it per UTC day, and the billed total against the plan's included
 *   minutes when they could be read.
 *
 * The report holds no price of its own: the caller passes GitHub's rate with
 * the page it came from and the day it was read, and the report carries it.
 * It prices only what GitHub kept from billing: billed minutes stay minutes,
 * because GitHub bills each runner type at its own rate.
 * Pure: no clock, network or store.
 */
import type { MinutesUsage } from "../runner-order/limits.js";
import { isGithubHostedLabel } from "../runner-order/providers.js";
import { compareText } from "./order.js";
import {
	type InsightJob,
	type InsightRun,
	jobRunMs,
	MS_PER_MINUTE,
	runnerKey,
} from "./types.js";

/** A per-minute price and where it was read. */
export type MinuteRate = Readonly<{
	usdPerMinute: number;
	/** The vendor page the price was read from. */
	source: string;
	/** The day it was read, `YYYY-MM-DD`. */
	readOn: string;
}>;

export type UsageOptions = Readonly<{
	/** GitHub's per-minute price for the hosted runner the kept jobs would have used. */
	githubRate: MinuteRate;
	/** The plan's included minutes, from a `MinutesReader`; undefined when not read. */
	included: MinutesUsage | undefined;
	/** A billed job shorter than this is short. Default one minute. */
	shortJobMs?: number;
	/**
	 * Repositories GitHub does not bill (public): their kept minutes save no
	 * money. Required, so a caller cannot price a public repository by
	 * forgetting it; pass an empty set when every repository is private.
	 */
	publicRepositories: ReadonlySet<string>;
}>;

// public-contract: a billed job shorter than this wastes part of its first minute.
export const DEFAULT_SHORT_JOB_MS = MS_PER_MINUTE;

/** Minutes and dollars one slice of the report covers. */
export type UsageTotals = Readonly<{
	/** Jobs that started and finished. */
	jobs: number;
	billedMinutes: number;
	shortJobs: number;
	/** Billed minutes short jobs did not run. */
	wasteMinutes: number;
	/** Minutes GitHub would have billed for jobs that ran on other runners. */
	keptMinutes: number;
	keptUsd: number;
	relayJobsAnswered: number;
	relaySavedMinutes: number;
	relaySavedUsd: number;
}>;

export type UsageRunnerRow = UsageTotals &
	Readonly<{
		/** `runnerKey` of the job's labels. */
		runner: string;
		/** GitHub's own runners ran it: hosted labels, the hosted runner group, or billed. */
		hosted: boolean;
	}>;

export type UsageDay = UsageTotals & Readonly<{ day: string }>;

export type IncludedMinutes = Readonly<{
	usedMinutes: number;
	includedMinutes: number;
	remainingMinutes: number;
	/** Billed minutes per day: measured when the reader gave a burn, else the report's average. */
	burnPerDay: number;
	/** Days until the included minutes run out; undefined with no burn. */
	daysLeft: number | undefined;
}>;

export type UsageReport = UsageTotals &
	Readonly<{
		rate: MinuteRate;
		/** Most minutes first. */
		runners: readonly UsageRunnerRow[];
		/** Oldest first; a day with no finished job is left out. */
		days: readonly UsageDay[];
		included: IncludedMinutes | undefined;
	}>;

const DAY_MS = 86_400_000;
const READ_ON = /^\d{4}-\d{2}-\d{2}$/u;

function checkRate(rate: MinuteRate): void {
	if (!Number.isFinite(rate.usdPerMinute) || rate.usdPerMinute < 0) {
		throw new RangeError("usdPerMinute must be a non-negative number");
	}
	if (rate.source.trim().length === 0) {
		throw new RangeError("a rate needs the source it was read from");
	}
	if (!READ_ON.test(rate.readOn)) {
		throw new RangeError(
			"readOn must be the day the rate was read, YYYY-MM-DD",
		);
	}
}

type Counts = {
	jobs: number;
	billedMinutes: number;
	shortJobs: number;
	wasteMinutes: number;
	keptMinutes: number;
	keptPricedMinutes: number;
	relayJobsAnswered: number;
	relaySavedMinutes: number;
	relayPricedMinutes: number;
};

function zero(): Counts {
	return {
		jobs: 0,
		billedMinutes: 0,
		shortJobs: 0,
		wasteMinutes: 0,
		keptMinutes: 0,
		keptPricedMinutes: 0,
		relayJobsAnswered: 0,
		relaySavedMinutes: 0,
		relayPricedMinutes: 0,
	};
}

// public-contract: the runner group GitHub's own runners, larger runners included, report.
export const GITHUB_HOSTED_RUNNER_GROUP = "GitHub Actions";

// The labels of GitHub's standard hosted runners: free in a public repository.
const STANDARD_HOSTED_LABEL =
	/^(?:ubuntu-(?:latest|\d+\.\d+)(?:-arm)?|ubuntu-slim|windows-(?:latest|\d{4})|windows-11-arm|macos-(?:latest|\d+)(?:-intel)?)$/u;
// GitHub's own larger macOS runners, which take no custom label.
const MACOS_LARGER_LABEL = /^macos-(?:latest|\d+)(?:-intel)?-x?large$/u;

type RunnerOf = Pick<InsightJob, "labels" | "runnerGroup">;

const lower = (label: string): string => label.trim().toLowerCase();

/**
 * Ran on one of GitHub's larger runners: a macOS `-large` or `-xlarge` label,
 * or a label that is not a standard hosted label in GitHub's runner group.
 */
export function isLargerRunnerJob(job: RunnerOf): boolean {
	const labels = job.labels.map(lower);
	return (
		labels.some((label) => MACOS_LARGER_LABEL.test(label)) ||
		(job.runnerGroup === GITHUB_HOSTED_RUNNER_GROUP &&
			labels.some((label) => !STANDARD_HOSTED_LABEL.test(label)))
	);
}

/** Ran on one of GitHub's own runners, a larger runner on custom labels included. */
function onGithubRunner(job: RunnerOf): boolean {
	return (
		job.runnerGroup === GITHUB_HOSTED_RUNNER_GROUP ||
		job.labels.some((label) => MACOS_LARGER_LABEL.test(lower(label))) ||
		(job.labels.length > 0 && job.labels.every(isGithubHostedLabel))
	);
}

/**
 * Whether GitHub bills a job's minutes. Standard hosted runners are free in
 * a public repository; larger runners are billed in every repository
 * (https://docs.github.com/en/billing/concepts/product-billing/github-actions,
 * read 2026-11-17: "Larger runners are billed for public repositories.").
 */
export function githubBillsJob(
	job: RunnerOf,
	repositoryPrivate: boolean,
): boolean {
	return onGithubRunner(job) && (repositoryPrivate || isLargerRunnerJob(job));
}

/** Billed: stored so, or a larger runner, which GitHub bills everywhere. */
function billedJob(job: InsightJob): boolean {
	return job.billed || isLargerRunnerJob(job);
}

function hostedJob(job: InsightJob): boolean {
	return job.billed || onGithubRunner(job) || isLargerRunnerJob(job);
}

/** Adds one finished job to every slice it belongs to. */
function count(
	slices: readonly Counts[],
	job: InsightJob,
	runMs: number,
	priced: boolean,
	shortJobMs: number,
): void {
	const minutes = Math.max(1, Math.ceil(runMs / MS_PER_MINUTE));
	const hosted = hostedJob(job);
	const billed = billedJob(job);
	for (const slice of slices) {
		slice.jobs += 1;
		if (billed) {
			slice.billedMinutes += minutes;
			if (runMs < shortJobMs) {
				slice.shortJobs += 1;
				slice.wasteMinutes += minutes - runMs / MS_PER_MINUTE;
			}
		}
		if (hosted) continue;
		if (job.relay === true) {
			slice.relayJobsAnswered += 1;
			slice.relaySavedMinutes += minutes;
			if (priced) slice.relayPricedMinutes += minutes;
		} else {
			slice.keptMinutes += minutes;
			if (priced) slice.keptPricedMinutes += minutes;
		}
	}
}

function totals(counts: Counts, rate: MinuteRate): UsageTotals {
	return {
		jobs: counts.jobs,
		billedMinutes: counts.billedMinutes,
		shortJobs: counts.shortJobs,
		wasteMinutes: counts.wasteMinutes,
		keptMinutes: counts.keptMinutes,
		keptUsd: counts.keptPricedMinutes * rate.usdPerMinute,
		relayJobsAnswered: counts.relayJobsAnswered,
		relaySavedMinutes: counts.relaySavedMinutes,
		relaySavedUsd: counts.relayPricedMinutes * rate.usdPerMinute,
	};
}

/** The UTC day of an epoch millisecond, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function includedMinutes(
	usage: MinutesUsage,
	billedMinutes: number,
	days: readonly string[],
): IncludedMinutes {
	const remainingMinutes = Math.max(
		0,
		usage.includedMinutes - usage.usedMinutes,
	);
	const first = days[0];
	const last = days[days.length - 1];
	const spanDays =
		first === undefined || last === undefined
			? 0
			: (Date.parse(last) - Date.parse(first)) / DAY_MS + 1;
	const burnPerDay =
		usage.burnPerHour !== undefined
			? usage.burnPerHour * 24
			: spanDays === 0
				? 0
				: billedMinutes / spanDays;
	return {
		usedMinutes: usage.usedMinutes,
		includedMinutes: usage.includedMinutes,
		remainingMinutes,
		burnPerDay,
		daysLeft: burnPerDay > 0 ? remainingMinutes / burnPerDay : undefined,
	};
}

/**
 * The usage report over a set of run attempts. Only jobs that started and
 * finished count; a job's day is the UTC day it finished.
 */
export function usageReport(
	runs: readonly InsightRun[],
	options: UsageOptions,
): UsageReport {
	const rate = options.githubRate;
	checkRate(rate);
	const shortJobMs = options.shortJobMs ?? DEFAULT_SHORT_JOB_MS;
	const publicRepositories = new Set(
		[...options.publicRepositories].map((name) => name.toLowerCase()),
	);
	const all = zero();
	const byRunner = new Map<string, Counts>();
	const hostedRunners = new Map<string, boolean>();
	const byDay = new Map<string, Counts>();
	for (const run of runs) {
		const priced = !publicRepositories.has(run.repository.toLowerCase());
		for (const job of run.jobs) {
			const runMs = jobRunMs(job);
			if (runMs === undefined || job.completedAtMs === undefined) continue;
			const runner = runnerKey(job.labels);
			const day = utcDay(job.completedAtMs);
			const runnerCounts = byRunner.get(runner) ?? zero();
			const dayCounts = byDay.get(day) ?? zero();
			byRunner.set(runner, runnerCounts);
			byDay.set(day, dayCounts);
			hostedRunners.set(
				runner,
				(hostedRunners.get(runner) ?? false) || hostedJob(job),
			);
			count([all, runnerCounts, dayCounts], job, runMs, priced, shortJobMs);
		}
	}
	const runners = [...byRunner.entries()]
		.map(
			([runner, counts]): UsageRunnerRow => ({
				runner,
				hosted: hostedRunners.get(runner) ?? false,
				...totals(counts, rate),
			}),
		)
		.sort(
			(left, right) =>
				right.billedMinutes +
					right.keptMinutes -
					(left.billedMinutes + left.keptMinutes) ||
				compareText(left.runner, right.runner),
		);
	const days = [...byDay.keys()].sort(compareText);
	return {
		rate,
		...totals(all, rate),
		runners,
		days: days.map((day): UsageDay => {
			const counts = byDay.get(day) ?? zero();
			return { day, ...totals(counts, rate) };
		}),
		included:
			options.included === undefined
				? undefined
				: includedMinutes(options.included, all.billedMinutes, days),
	};
}
