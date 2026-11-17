/**
 * `hobo ci performance`: how fast workflows, jobs and runners are, each runner
 * against `ubuntu-latest`, and the nine signals with their thresholds, a
 * breakdown and a per-day trend (ADR-0183).
 *
 *     hobo ci performance [--repo owner/name] [--since 30d] [--json]
 *     hobo ci performance --source github [--repo owner/name] [--since 30d] [--runs <n>] [--json]
 *
 * By default it reads the connected relay's `job-times` and `signals`
 * reports, computed from the run history the relay keeps. `--source github`
 * reads the repository's recent runs with the GitHub CLI instead and computes
 * the same reports (`workflowTimes`, `jobTimes`, `runnerTimes`,
 * `signalBreakdown` from `@hobo/ci`), so both sources print the same way. A
 * breakdown and trend over one page of runs read on demand says less than one
 * over stored history; the output says which source it came from.
 */
import {
	CI_SIGNAL_IDS,
	type CiSignalId,
	DEFAULT_JOB_TIME_OPTIONS,
	DEFAULT_SIGNAL_THRESHOLDS,
	jobTimes,
	median,
	runnerTimes,
	type SignalThresholds,
	workflowTimes,
} from "@hobo/ci/insights";
import {
	SIGNAL_DIMENSIONS,
	signalBreakdown,
} from "@hobo/ci/insights/breakdown";
import type { CommandResult } from "@hobo/cli";
import { z } from "zod";
import { noRelaySelected, selectRelay, stopping } from "./ci-activity.js";
import type { CiCommand, CiCommandContext } from "./ci-commands.js";
import { type CiRunExec, runCiProcess } from "./ci-runs.js";
import {
	type CiInsightCommandDeps,
	dayOf,
	githubHistoryOrStop,
	githubRepository,
	type InsightArgs,
	minutesText,
	parseInsightArgs,
	readGithubHistory,
	readRelayReport,
} from "./ci-usage.js";

const PERFORMANCE_HELP = [
	"hobo ci performance [--repo owner/name] [--since 30d] [--json]",
	"hobo ci performance --source github [--repo owner/name] [--since 30d] [--runs <n>] [--json]",
	"Workflow, job and runner times, each runner against ubuntu-latest, and the nine signals with a breakdown and trend.",
	"  --source relay   the connected relay's run history (default; --relay, .hobo/ci.json, HOBO_CI_RELAY_URL or the hobo ci setup link)",
	"  --source github  the repository's recent runs, read with the GitHub CLI",
].join("\n");

const count = z.number().int().min(0);
const signalId = z.enum(CI_SIGNAL_IDS);

/** The read API's `job-times` report. */
export const JobTimesReportJson = z.object({
	sinceMs: z.number(),
	runs: count,
	workflows: z.array(
		z.object({
			workflow: z.string(),
			runs: count,
			successRate: z.number().optional(),
			medianMs: z.number().optional(),
			p90Ms: z.number().optional(),
			medianWaitMs: z.number().optional(),
			slowestJob: z.string().optional(),
		}),
	),
	jobs: z.array(
		z.object({
			job: z.string(),
			workflow: z.string(),
			runners: z.array(
				z.object({
					key: z.string(),
					runs: count,
					medianRunMs: z.number(),
					p90RunMs: z.number(),
					confidence: z.enum(["enough", "few", "sparse"]),
				}),
			),
			fastest: z.string().optional(),
			speedup: z.array(z.object({ key: z.string(), ratio: z.number() })),
		}),
	),
	runners: z.array(
		z.object({
			key: z.string(),
			jobs: count,
			started: count,
			startedShare: z.number(),
			medianWaitMs: z.number().optional(),
			medianRunMs: z.number().optional(),
			p90RunMs: z.number().optional(),
			successRate: z.number().optional(),
		}),
	),
});
export type JobTimesView = z.infer<typeof JobTimesReportJson>;

const SignalCountJson = z.object({
	id: signalId,
	minutes: z.number(),
	occurrences: count,
});
const SignalSliceJson = z.object({
	key: z.string(),
	runs: count,
	jobMinutes: z.number(),
	minutes: z.number(),
	signals: z.array(SignalCountJson),
});

/** The read API's `signals` report. */
export const SignalReportJson = z.object({
	sinceMs: z.number(),
	runs: count,
	signals: z.object({
		totalJobMinutes: z.number(),
		signals: z.array(
			z.object({
				id: signalId,
				area: z.enum(["cost", "speed", "complexity"]),
				minutes: z.number(),
				occurrences: count,
				shown: z.boolean(),
				rows: z.array(
					z.object({
						key: z.string(),
						minutes: z.number(),
						occurrences: count,
					}),
				),
			}),
		),
	}),
	by: z.object({
		person: z.array(SignalSliceJson),
		repository: z.array(SignalSliceJson),
		workflow: z.array(SignalSliceJson),
		branch: z.array(SignalSliceJson),
		event: z.array(SignalSliceJson),
	}),
	trend: z.array(SignalSliceJson.extend({ day: z.string() })),
});
export type SignalReportView = z.infer<typeof SignalReportJson>;

/** One runner against the baseline, over every job both ran. */
export type RunnerAgainstBaseline = Readonly<{
	key: string;
	/** Jobs measured on both this runner and the baseline. */
	jobs: number;
	/** Median over those jobs of baseline time over this runner's: 2 is twice as fast. */
	medianRatio: number;
}>;

/**
 * Each runner against the baseline (`ubuntu-latest`), from the per-job
 * speedups `jobTimes` measured: the median ratio over every job both ran
 * often enough to compare. Fastest first.
 */
export function runnersAgainstBaseline(
	jobs: JobTimesView["jobs"],
): readonly RunnerAgainstBaseline[] {
	const ratios = new Map<string, number[]>();
	for (const job of jobs)
		for (const entry of job.speedup) {
			const list = ratios.get(entry.key) ?? [];
			list.push(entry.ratio);
			ratios.set(entry.key, list);
		}
	return [...ratios.entries()]
		.map(([key, list]) => ({
			key,
			jobs: list.length,
			medianRatio: median(list) ?? 1,
		}))
		.sort(
			(left, right) =>
				right.medianRatio - left.medianRatio || (left.key < right.key ? -1 : 1),
		);
}

function minutes(ms: number): string {
	return ms >= 60_000 ? `${Math.round(ms / 6_000) / 10} min` : "";
}

/** What each signal counts, with the threshold it is measured against. */
export function signalThreshold(
	id: CiSignalId,
	thresholds: SignalThresholds = DEFAULT_SIGNAL_THRESHOLDS,
): string {
	switch (id) {
		case "no-concurrency":
			return "runs that kept going after a newer run started on the same branch";
		case "same-commit":
			return "push runs of a commit that also ran from a pull request";
		case "short-jobs":
			return `billed jobs under ${minutes(thresholds.shortJobMs)}, paid as a whole minute`;
		case "queue-waits":
			return `jobs that waited over ${minutes(thresholds.queueWaitMs)} for a runner`;
		case "slowest-job":
			return `runs held up by one job running alone for ${minutes(thresholds.slowestJobMs)} or more`;
		case "flaky-jobs":
			return "jobs that failed, then passed on a re-run";
		case "runner-failures":
			return "jobs that failed before any step ran";
		case "docs-changes":
			return "full runs for pull requests that changed only docs";
		case "wide-fanout":
			return `branch runs that started ${thresholds.fanoutJobs} or more jobs`;
	}
}

function duration(ms: number | undefined): string {
	if (ms === undefined) return "-";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const whole = Math.floor(seconds / 60);
	return whole < 60
		? `${whole}m${String(seconds % 60).padStart(2, "0")}s`
		: `${Math.floor(whole / 60)}h${String(whole % 60).padStart(2, "0")}m`;
}

const percent = (share: number | undefined): string =>
	share === undefined ? "-" : `${Math.round(share * 100)}%`;

/** The performance report as people read it. */
export function performanceLines(
	times: JobTimesView,
	signals: SignalReportView,
	heading: string,
): readonly string[] {
	const baseline = DEFAULT_JOB_TIME_OPTIONS.baselineKey;
	const against = runnersAgainstBaseline(times.jobs);
	const lines = [heading];
	lines.push(
		"workflows",
		...(times.workflows.length === 0
			? ["  no finished run"]
			: times.workflows
					.slice(0, 10)
					.map(
						(row) =>
							`  ${row.workflow}  ${row.runs} runs  passed ${percent(row.successRate)}  median ${duration(row.medianMs)} (p90 ${duration(row.p90Ms)})  waiting ${duration(row.medianWaitMs)}${row.slowestJob ? `  slowest job ${row.slowestJob}` : ""}`,
					)),
	);
	const compared = times.jobs.filter((job) => job.runners.length > 1);
	if (compared.length > 0)
		lines.push(
			"jobs on more than one runner",
			...compared
				.slice(0, 10)
				.map(
					(job) =>
						`  ${job.workflow} / ${job.job}  ${job.runners.map((runner) => `${runner.key} ${duration(runner.medianRunMs)} (${runner.runs}, ${runner.confidence})`).join("  ")}${job.fastest ? `  fastest ${job.fastest}` : ""}`,
				),
		);
	lines.push(
		"runners",
		...(times.runners.length === 0
			? ["  no job took a runner"]
			: times.runners
					.slice(0, 10)
					.map(
						(row) =>
							`  ${row.key}  ${row.jobs} jobs  started ${percent(row.startedShare)}  wait ${duration(row.medianWaitMs)}  run ${duration(row.medianRunMs)} (p90 ${duration(row.p90RunMs)})  passed ${percent(row.successRate)}`,
					)),
	);
	lines.push(
		`against ${baseline}`,
		...(against.length === 0
			? [
					`  no job ran often enough on both ${baseline} and another runner to compare (${DEFAULT_JOB_TIME_OPTIONS.minSharedJobs} successful runs each)`,
				]
			: against.map(
					(row) =>
						`  ${row.key}  ${row.medianRatio >= 1 ? `${row.medianRatio.toFixed(2)}x as fast` : `${(1 / row.medianRatio).toFixed(2)}x slower`} over ${row.jobs} ${row.jobs === 1 ? "job" : "jobs"}`,
				)),
	);
	const thresholds = DEFAULT_SIGNAL_THRESHOLDS;
	lines.push(
		`signals (shown at ${thresholds.minMinutes} min and ${Math.round(thresholds.minShare * 100)}% of ${minutesText(signals.signals.totalJobMinutes)} of job time)`,
		...signals.signals.signals.map(
			(signal) =>
				`  ${signal.shown ? "*" : " "} ${signal.id}  ${minutesText(signal.minutes)} in ${signal.occurrences}  ${signalThreshold(signal.id)}`,
		),
	);
	for (const dimension of SIGNAL_DIMENSIONS) {
		const top = signals.by[dimension].filter((slice) => slice.minutes > 0);
		if (top.length > 0)
			lines.push(
				`  by ${dimension}: ${top
					.slice(0, 3)
					.map(
						(slice) => `${slice.key || "(none)"} ${minutesText(slice.minutes)}`,
					)
					.join(", ")}`,
			);
	}
	if (signals.trend.length > 0)
		lines.push(
			"  per day: " +
				signals.trend
					.slice(-14)
					.map((day) => `${day.day} ${minutesText(day.minutes)}`)
					.join(", "),
		);
	return lines;
}

/** `data` for both sources: the two reports and the comparisons drawn from them. */
function performanceData(times: JobTimesView, signals: SignalReportView) {
	return {
		times,
		againstBaseline: {
			baseline: DEFAULT_JOB_TIME_OPTIONS.baselineKey,
			runners: runnersAgainstBaseline(times.jobs),
		},
		signals,
		thresholds: {
			...DEFAULT_SIGNAL_THRESHOLDS,
			signals: CI_SIGNAL_IDS.map((id) => ({
				id,
				counts: signalThreshold(id),
			})),
		},
	};
}

async function performanceFromGithub(
	context: CiCommandContext,
	options: InsightArgs,
	exec: CiRunExec,
): Promise<CommandResult> {
	const { root, repository } = await githubRepository(
		context,
		options.repo,
		PERFORMANCE_HELP,
	);
	const history = await githubHistoryOrStop(() =>
		readGithubHistory({
			repository,
			cwd: root,
			runs: options.runs,
			sinceMs: options.sinceMs,
			exec,
			env: context.env,
		}),
	);
	const head = { sinceMs: options.sinceMs, runs: history.runs.length };
	const breakdown = signalBreakdown(history.runs);
	// Through the wire shape, so both sources print and answer alike.
	const times = JobTimesReportJson.parse(
		JSON.parse(
			JSON.stringify({
				...head,
				workflows: workflowTimes(history.runs),
				jobs: jobTimes(history.runs),
				runners: runnerTimes(history.runs, { nowMs: context.now() }),
			}),
		),
	);
	const signals = SignalReportJson.parse(
		JSON.parse(JSON.stringify({ ...head, ...breakdown })),
	);
	return {
		message: performanceLines(
			times,
			signals,
			`CI performance for ${history.repository} since ${dayOf(options.sinceMs)}, from GitHub (${history.runs.length} run attempts of the newest ${history.listed} runs):`,
		).join("\n"),
		data: {
			source: "github",
			repository: history.repository,
			...performanceData(times, signals),
		},
	};
}

async function performance(
	context: CiCommandContext,
	exec: CiRunExec,
): Promise<CommandResult> {
	const options = parseInsightArgs(
		context.args,
		context.now(),
		PERFORMANCE_HELP,
	);
	if (options.source === "github")
		return performanceFromGithub(context, options, exec);
	const target = await selectRelay(context, options);
	if (!target) return noRelaySelected(", or pass --source github");
	const query = { repository: options.repo, sinceMs: options.sinceMs };
	const times = await readRelayReport(
		context,
		target,
		"/job-times",
		query,
		JobTimesReportJson,
		"hobo ci performance",
	);
	const signals = await readRelayReport(
		context,
		target,
		"/signals",
		query,
		SignalReportJson,
		"hobo ci performance",
	);
	return {
		message: performanceLines(
			times,
			signals,
			`CI performance for ${options.repo ?? "every connected repository"} since ${dayOf(times.sinceMs)}, from the relay (${times.runs} run attempts):`,
		).join("\n"),
		data: {
			source: "relay",
			relay: target.origin,
			repository: options.repo ?? null,
			...performanceData(times, signals),
		},
	};
}

/** `hobo ci performance`, running `gh` through `deps.execFile` for `--source github`. */
export function createCiPerformanceCommand(
	deps: CiInsightCommandDeps = {},
): CiCommand {
	const exec = deps.execFile ?? runCiProcess;
	return {
		name: "performance",
		summary:
			"Workflow, job and runner times, each runner against ubuntu-latest, and the nine signals with a breakdown and trend.",
		run: (context) => stopping(() => performance(context, exec)),
	};
}

export const CI_PERFORMANCE_COMMAND = createCiPerformanceCommand();
