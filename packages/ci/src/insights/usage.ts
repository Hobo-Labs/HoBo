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

export type MinuteRate = Readonly<{
	usdPerMinute: number;
	source: string;
	readOn: string;
}>;

export type UsageOptions = Readonly<{
	githubRate: MinuteRate;
	included: MinutesUsage | undefined;
	shortJobMs?: number;
	publicRepositories: ReadonlySet<string>;
}>;

export const DEFAULT_SHORT_JOB_MS = MS_PER_MINUTE;

export type UsageTotals = Readonly<{
	jobs: number;
	billedMinutes: number;
	shortJobs: number;
	wasteMinutes: number;
	keptMinutes: number;
	keptUsd: number;
	relayJobsAnswered: number;
	relaySavedMinutes: number;
	relaySavedUsd: number;
}>;

export type UsageRunnerRow = UsageTotals &
	Readonly<{
		runner: string;
		hosted: boolean;
	}>;

export type UsageDay = UsageTotals & Readonly<{ day: string }>;

export type IncludedMinutes = Readonly<{
	usedMinutes: number;
	includedMinutes: number;
	remainingMinutes: number;
	burnPerDay: number;
	daysLeft: number | undefined;
}>;

export type UsageReport = UsageTotals &
	Readonly<{
		rate: MinuteRate;
		runners: readonly UsageRunnerRow[];
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

export const GITHUB_HOSTED_RUNNER_GROUP = "GitHub Actions";

const STANDARD_HOSTED_LABEL =
	/^(?:ubuntu-(?:latest|\d+\.\d+)(?:-arm)?|ubuntu-slim|windows-(?:latest|\d{4})|windows-11-arm|macos-(?:latest|\d+)(?:-intel)?)$/u;
const MACOS_LARGER_LABEL = /^macos-(?:latest|\d+)(?:-intel)?-x?large$/u;

type RunnerOf = Pick<InsightJob, "labels" | "runnerGroup">;

const lower = (label: string): string => label.trim().toLowerCase();

export function isLargerRunnerJob(job: RunnerOf): boolean {
	const labels = job.labels.map(lower);
	return (
		labels.some((label) => MACOS_LARGER_LABEL.test(label)) ||
		(job.runnerGroup === GITHUB_HOSTED_RUNNER_GROUP &&
			labels.some((label) => !STANDARD_HOSTED_LABEL.test(label)))
	);
}

function onGithubRunner(job: RunnerOf): boolean {
	return (
		job.runnerGroup === GITHUB_HOSTED_RUNNER_GROUP ||
		job.labels.some((label) => MACOS_LARGER_LABEL.test(lower(label))) ||
		(job.labels.length > 0 && job.labels.every(isGithubHostedLabel))
	);
}

export function githubBillsJob(
	job: RunnerOf,
	repositoryPrivate: boolean,
): boolean {
	return onGithubRunner(job) && (repositoryPrivate || isLargerRunnerJob(job));
}

function billedJob(job: InsightJob): boolean {
	return job.billed || isLargerRunnerJob(job);
}

function hostedJob(job: InsightJob): boolean {
	return job.billed || onGithubRunner(job) || isLargerRunnerJob(job);
}

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
