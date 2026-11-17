import { isGithubHostedLabel } from "@hobo/ci";
import {
	type CiSignal,
	ciSignals,
	diagnoseFailure,
	type FailureDiagnosis,
	type InsightConclusion,
	type InsightJob,
	type InsightRun,
	type InsightStep,
	type RunnerTimes,
	runnerTimes,
	summarizeDiagnosis,
} from "@hobo/ci/insights";
import type { CommandResult } from "@hobo/cli";
import { z } from "zod";
import { CiProcessError, type CiRunExec, runCiProcess } from "./ci-runs.js";

export type CiInsightOptions = Readonly<
	Record<string, string | boolean | readonly string[] | undefined>
>;

// public-contract: runs `hobo ci signals` reads when --runs is not given.
export const DEFAULT_SIGNAL_RUNS = 50;
// public-contract: failed jobs `hobo ci diagnose` reads from one run.
export const MAX_DIAGNOSED_JOBS = 5;

const LOG_TAIL_BYTES = 256 * 1024;

const PRINTED_EXCERPT_LINES = 12;
const JOBS_PER_PAGE = 100;
const MAX_JOBS_PER_ATTEMPT = 1_000;

class InsightUsage extends Error {}
class InsightJobsLimit extends Error {}

const time = z.string().min(1).nullish();

const StepSchema = z.looseObject({
	name: z.string(),
	number: z.number().int(),
	conclusion: z.string().nullish(),
	started_at: time,
	completed_at: time,
});

const JobSchema = z.looseObject({
	id: z.number().int().positive(),
	name: z.string(),
	labels: z.array(z.string()).nullish(),
	runner_name: z.string().nullish(),
	runner_group_name: z.string().nullish(),
	conclusion: z.string().nullish(),
	created_at: z.string().min(1),
	started_at: time,
	completed_at: time,
	steps: z.array(StepSchema).nullish(),
});

const JobsPageSchema = z.looseObject({
	total_count: z.number().int().nonnegative().optional(),
	jobs: z.array(JobSchema),
});

const RunSchema = z.looseObject({
	id: z.number().int().positive(),
	run_attempt: z.number().int().positive().nullish(),
	name: z.string().nullish(),
	path: z.string().nullish(),
	event: z.string(),
	head_branch: z.string().nullish(),
	head_sha: z.string(),
	status: z.string().nullish(),
	conclusion: z.string().nullish(),
	created_at: z.string().min(1),
	updated_at: time,
	display_title: z.string().nullish(),
	html_url: z.string().nullish(),
	actor: z.looseObject({ login: z.string() }).nullish(),
});

const RunsPageSchema = z.looseObject({ workflow_runs: z.array(RunSchema) });

const RepositorySchema = z.looseObject({
	private: z.boolean(),
	default_branch: z.string().min(1),
});

const AnnotationsSchema = z.array(
	z.looseObject({ message: z.string().nullish() }),
);

type GithubRun = z.infer<typeof RunSchema>;
type GithubJob = z.infer<typeof JobSchema>;

function conclusion(value: string | null | undefined): InsightConclusion {
	switch (value) {
		case "success":
		case "failure":
		case "cancelled":
		case "skipped":
		case "timed_out":
			return value;
		case "startup_failure":
			return "failure";
		default:
			return "unknown";
	}
}

function at(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : ms;
}

function isRelayJob(name: string): boolean {
	return /^(?:relay|route)(?:$|[\s\-_/(])/iu.test(name);
}

function insightStep(step: z.infer<typeof StepSchema>): InsightStep {
	const started = at(step.started_at);
	const completed = at(step.completed_at);
	const base = {
		name: step.name,
		number: step.number,
		conclusion: conclusion(step.conclusion),
	};
	if (started === undefined) return base;
	return completed === undefined
		? { ...base, startedAtMs: started }
		: { ...base, startedAtMs: started, completedAtMs: completed };
}

function insightJob(job: GithubJob, privateRepository: boolean): InsightJob {
	const labels = job.labels ?? [];
	const steps = (job.steps ?? []).map(insightStep);
	const queuedAtMs = at(job.created_at) ?? 0;

	const started = job.runner_name ? at(job.started_at) : undefined;
	const completed = at(job.completed_at);
	const base = {
		id: job.id,
		name: job.name,
		labels,
		conclusion: conclusion(job.conclusion),
		queuedAtMs,
		steps,
		billed:
			privateRepository &&
			labels.length > 0 &&
			labels.every((label) => isGithubHostedLabel(label)),
		relay: isRelayJob(job.name),
	};
	const named = job.runner_name
		? { ...base, runnerName: job.runner_name }
		: base;
	if (started === undefined)
		return completed === undefined
			? named
			: { ...named, completedAtMs: completed };
	return completed === undefined
		? { ...named, startedAtMs: started }
		: { ...named, startedAtMs: started, completedAtMs: completed };
}

function insightRun(
	run: GithubRun,
	attempt: number,
	jobs: readonly InsightJob[],
	repository: Readonly<{
		name: string;
		defaultBranch: string;
	}>,
): InsightRun {
	const latest = attempt === (run.run_attempt ?? 1);
	const base = {
		id: run.id,
		attempt,
		repository: repository.name,
		workflow: run.name ?? run.path ?? "workflow",
		workflowPath: run.path ?? run.name ?? "workflow",
		event: run.event,
		branch: run.head_branch ?? "",
		defaultBranch: repository.defaultBranch,
		headSha: run.head_sha,
		actor: run.actor?.login ?? "",

		conclusion: latest
			? conclusion(run.conclusion)
			: jobs.some(
						(job) =>
							job.conclusion === "failure" || job.conclusion === "timed_out",
					)
				? "failure"
				: "unknown",
		createdAtMs: at(run.created_at) ?? 0,
		jobs,
		title: run.display_title ?? "",
	};
	const completed = latest
		? at(run.updated_at)
		: Math.max(0, ...jobs.map((job) => job.completedAtMs ?? 0));
	return completed === undefined ||
		completed === 0 ||
		run.status !== "completed"
		? base
		: { ...base, completedAtMs: completed };
}

function duration(ms: number | undefined): string {
	if (ms === undefined) return "-";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60
		? `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
		: `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

const minutes = (value: number): string =>
	value >= 10 ? `${Math.round(value)} min` : `${value.toFixed(1)} min`;

const SIGNAL_TEXT: ReadonlyMap<string, string> = new Map([
	[
		"no-concurrency",
		"runs that kept going after a newer run started on the same branch",
	],
	["same-commit", "push runs of a commit that also ran from a pull request"],
	["short-jobs", "billed jobs under a minute, paid as a whole one"],
	["queue-waits", "jobs that waited over a minute for a runner"],
	["slowest-job", "runs held up by one job finishing alone"],
	["flaky-jobs", "jobs that failed, then passed on a re-run"],
	["runner-failures", "jobs that failed before any step ran"],
	["docs-changes", "full runs for pull requests that changed only docs"],
	["wide-fanout", "branch runs that started ten or more jobs"],
]);

function signalLines(signal: CiSignal): string[] {
	const rows = signal.rows
		.map(
			(row) =>
				`      ${row.key}: ${minutes(row.minutes)} in ${row.occurrences}`,
		)
		.slice(0, 3);
	return [
		`  ${signal.id}  ${minutes(signal.minutes)} in ${signal.occurrences}  ${SIGNAL_TEXT.get(signal.id) ?? ""}`,
		...rows,
	];
}

function runnerLine(runner: RunnerTimes): string {
	const success =
		runner.successRate === undefined
			? "-"
			: `${Math.round(runner.successRate * 100)}%`;
	return `  ${runner.key}  ${runner.jobs} jobs  started ${Math.round(runner.startedShare * 100)}%  wait ${duration(runner.medianWaitMs)}  run ${duration(runner.medianRunMs)} (p90 ${duration(runner.p90RunMs)})  passed ${success}`;
}

function count(
	options: CiInsightOptions,
	name: string,
	bounds: Readonly<{ fallback: number; max: number }>,
): number {
	const value = options[name];
	if (value === undefined) return bounds.fallback;
	if (value === true || value === false || !/^[1-9]\d*$/u.test(String(value)))
		throw new InsightUsage(
			`--${name} must be an integer from 1 to ${bounds.max}.`,
		);
	const parsed = Number(value);
	if (parsed > bounds.max)
		throw new InsightUsage(
			`--${name} must be an integer from 1 to ${bounds.max}.`,
		);
	return parsed;
}

function failure(error: Error): CommandResult {
	if (error instanceof InsightJobsLimit)
		return {
			ok: false,
			status: "unconfirmed",
			code: "HOBO_CI_JOB_LIMIT",
			message: error.message,
		};
	if (error instanceof InsightUsage)
		return {
			ok: false,
			status: "usage",
			code: "HOBO_CLI_USAGE",
			message: error.message,
			remediation: ["Run hobo ci --help for supported commands and options."],
		};
	if (error instanceof CiProcessError && error.kind === "missing")
		return {
			ok: false,
			status: "unavailable",
			code: "HOBO_CI_TOOL_REQUIRED",
			message:
				"Install the GitHub CLI (gh) and authenticate with gh auth login, then retry this CI command.",
		};
	if (error instanceof CiProcessError && error.kind === "timeout")
		return {
			ok: false,
			status: "unconfirmed",
			code: "HOBO_CI_OPERATION_TIMEOUT",
			message: "The GitHub request timed out. Nothing was changed; retry.",
		};
	const status = error instanceof CiProcessError ? error.httpStatus : undefined;
	return {
		ok: false,
		status: "error",
		code: "HOBO_CI_GITHUB_FAILED",
		message:
			status === 401 || status === 403
				? "GitHub denied this read. Check gh auth status and repository Actions permissions."
				: status === 404
					? "GitHub found no such repository or run. Check the run ID and the repository."
					: status === 429
						? "GitHub rate limited this read. Wait before retrying."
						: "GitHub could not be read, or answered with something that is not a run. Check gh auth status and repository Actions permissions.",
	};
}

export async function runCiInsights(input: {
	command: "signals" | "diagnose";
	repository: string;
	cwd: string;
	args: readonly string[];
	options: CiInsightOptions;
	execFile?: CiRunExec;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}): Promise<CommandResult> {
	const exec = input.execFile ?? runCiProcess;
	const env = { ...(input.env ?? process.env) };
	delete env.HOBO_CI_ACCOUNT_TOKEN;
	delete env.HOBO_CI_ACCOUNT_TOKEN_FILE;
	const repo = `repos/${input.repository}`;
	const api = async (path: string, maxBuffer = 16 * 1024 * 1024) =>
		(
			await exec("gh", ["api", path], {
				cwd: input.cwd,
				timeout: 30_000,
				maxBuffer,
				env,
			})
		).stdout;
	const jobsOf = async (
		run: GithubRun,
		attempt: number,
		privateRepository: boolean,
	): Promise<InsightJob[]> => {
		const jobs: InsightJob[] = [];
		const path = `${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=${JOBS_PER_PAGE}`;
		for (let page = 1; page <= MAX_JOBS_PER_ATTEMPT / JOBS_PER_PAGE; page++) {
			const suffix = page === 1 ? "" : `&page=${page}`;
			const response = JobsPageSchema.parse(
				JSON.parse(await api(`${path}${suffix}`)),
			);
			if (
				response.jobs.length > JOBS_PER_PAGE ||
				(response.total_count !== undefined &&
					response.total_count > MAX_JOBS_PER_ATTEMPT)
			)
				throw new InsightJobsLimit(
					`A run attempt has more than ${MAX_JOBS_PER_ATTEMPT} jobs.`,
				);
			jobs.push(
				...response.jobs.map((job) => insightJob(job, privateRepository)),
			);
			if (
				response.total_count !== undefined &&
				jobs.length > response.total_count
			)
				throw new Error("GitHub returned an inconsistent job count");
			if (
				response.total_count !== undefined &&
				jobs.length === response.total_count
			)
				return jobs;
			if (response.jobs.length < JOBS_PER_PAGE) {
				if (response.total_count !== undefined)
					throw new Error("GitHub returned an incomplete job list");
				return jobs;
			}
		}
		throw new InsightJobsLimit(
			`A run attempt may have more than ${MAX_JOBS_PER_ATTEMPT} jobs.`,
		);
	};

	try {
		const repository = RepositorySchema.parse(JSON.parse(await api(repo)));
		const described = {
			name: input.repository,
			defaultBranch: repository.default_branch,
		};

		if (input.command === "signals") {
			if (input.args.length > 0)
				throw new InsightUsage(
					"hobo ci signals takes no positional arguments.",
				);
			const limit = count(input.options, "runs", {
				fallback: DEFAULT_SIGNAL_RUNS,
				max: 100,
			});
			const listed = RunsPageSchema.parse(
				JSON.parse(await api(`${repo}/actions/runs?per_page=${limit}`)),
			).workflow_runs.filter((run) => run.status === "completed");
			const runs: InsightRun[] = [];
			for (const run of listed) {
				const latest = run.run_attempt ?? 1;

				for (const attempt of latest > 1 ? [latest - 1, latest] : [latest])
					runs.push(
						insightRun(
							run,
							attempt,
							await jobsOf(run, attempt, repository.private),
							described,
						),
					);
			}
			const report = ciSignals(runs);
			const runners = runnerTimes(runs, { nowMs: (input.now ?? Date.now)() });
			const shown = report.signals.filter((signal) => signal.shown);
			const seen = report.signals.filter(
				(signal) => !signal.shown && signal.occurrences > 0,
			);
			const lines = [
				`CI signals for ${input.repository}: ${listed.length} runs, ${minutes(report.totalJobMinutes)} of jobs.`,
			];
			for (const area of ["cost", "speed", "complexity"] as const) {
				const signals = shown.filter((signal) => signal.area === area);
				if (signals.length > 0)
					lines.push(area, ...signals.flatMap(signalLines));
			}
			if (shown.length === 0)
				lines.push(
					"No signal covers 30 minutes and 1% of job time in these runs.",
				);
			if (seen.length > 0)
				lines.push(
					`Below that bar: ${seen.map((signal) => `${signal.id} (${minutes(signal.minutes)})`).join(", ")}.`,
				);
			if (runners.length > 0)
				lines.push("runners", ...runners.slice(0, 10).map(runnerLine));
			return {
				message: lines.join("\n"),
				data: {
					repository: input.repository,
					runs: listed.length,
					totalJobMinutes: report.totalJobMinutes,
					signals: report.signals,
					runners,
				},
			};
		}

		if (input.args.length > 1)
			throw new InsightUsage("hobo ci diagnose takes one run ID at most.");
		const requested = input.args[0];
		if (requested !== undefined && !/^[1-9]\d{0,18}$/u.test(requested))
			throw new InsightUsage("A run ID is a positive integer.");
		const run =
			requested === undefined
				? RunsPageSchema.parse(
						JSON.parse(
							await api(`${repo}/actions/runs?status=failure&per_page=1`),
						),
					).workflow_runs[0]
				: RunSchema.parse(
						JSON.parse(await api(`${repo}/actions/runs/${requested}`)),
					);
		if (!run)
			return {
				message: `No failed run in ${input.repository}'s recent history.`,
				data: { repository: input.repository, jobs: [] },
			};
		const attempt = run.run_attempt ?? 1;
		const failed = (await jobsOf(run, attempt, repository.private)).filter(
			(job) => job.conclusion === "failure" || job.conclusion === "timed_out",
		);
		const diagnosed: {
			job: string;
			id: number;
			runner: string;
			diagnosis: FailureDiagnosis;
			summary: string;
		}[] = [];
		for (const job of failed.slice(0, MAX_DIAGNOSED_JOBS)) {
			const logTail = await api(`${repo}/actions/jobs/${job.id}/logs`)
				.then((log) => log.slice(-LOG_TAIL_BYTES))
				.catch(() => "");
			const annotations = await api(`${repo}/check-runs/${job.id}/annotations`)
				.then((body) =>
					AnnotationsSchema.parse(JSON.parse(body)).flatMap(
						(annotation) => annotation.message ?? [],
					),
				)
				.catch(() => []);
			const diagnosis = diagnoseFailure({ job, logTail, annotations });
			diagnosed.push({
				job: job.name,
				id: job.id,
				runner: job.runnerName ?? job.labels.join(", "),
				diagnosis,
				summary: summarizeDiagnosis(diagnosis),
			});
		}
		const title = `${run.name ?? "run"} #${run.id}${attempt > 1 ? ` (attempt ${attempt})` : ""}: ${run.display_title ?? ""}`;
		const lines =
			diagnosed.length === 0
				? [title, "No job of this run failed or timed out."]
				: [
						title,
						...diagnosed.flatMap((entry) => [
							"",
							`${entry.job}  (${entry.runner || "no runner"})`,
							`  ${entry.summary}`,
							...entry.diagnosis.excerpt
								.slice(-PRINTED_EXCERPT_LINES)
								.map((line) => `    ${line}`),
						]),
						...(failed.length > diagnosed.length
							? [
									"",
									`${failed.length - diagnosed.length} more failed job(s) not read.`,
								]
							: []),
					];
		return {
			message: lines.join("\n"),
			data: {
				repository: input.repository,
				run: { id: run.id, attempt, url: run.html_url ?? "" },
				jobs: diagnosed,
				more: Math.max(0, failed.length - diagnosed.length),
			},
		};
	} catch (error) {
		return failure(
			error instanceof Error ? error : new Error("GitHub read failed"),
		);
	}
}
