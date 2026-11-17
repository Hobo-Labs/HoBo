/**
 * `hobo ci usage`: where Actions minutes went and what running elsewhere kept
 * off GitHub's bill (ADR-0183).
 *
 *     hobo ci usage [--repo owner/name] [--since 30d] [--json]
 *     hobo ci usage --source github [--repo owner/name] [--since 30d] [--runs <n>] [--json]
 *
 * By default it reads the `usage` report of the connected relay's read API
 * (the relay is found as `hobo ci activity` finds it): billed minutes per
 * runner type and per day, short jobs and the minutes they waste, minutes kept
 * off GitHub-hosted runners priced at GitHub's rate, relay jobs answered
 * without a billed minute (relay mode and runner-less checks), and the
 * included minutes left with the burn rate when the relay can read billing.
 *
 * `--source github` asks no relay. It reads the repository's recent runs with
 * the authenticated GitHub CLI, as `hobo ci signals` does, folds each run and
 * job through the same webhook parser a relay uses, and computes the same
 * `usageReport`. The included minutes come from GitHub's billing usage API
 * with the CLI's token, and are "not measured" when it may not read them.
 *
 * This file also holds the GitHub history reader `hobo ci performance` uses.
 */
import { parseArgs } from "node:util";
import type { InsightRun } from "@hobo/ci/insights";
import { type MinuteRate, usageReport } from "@hobo/ci/insights/usage";
import {
	foldInsightWebhook,
	GITHUB_INCLUDED_COMPUTE_OBSERVED_AT,
	GITHUB_INCLUDED_COMPUTE_SOURCE,
	GITHUB_LINUX_USD_PER_MINUTE,
	GithubMinutesReader,
	parseInsightWebhook,
} from "@hobo/ci-gh-actions";
import type { CommandResult } from "@hobo/cli";
import { z } from "zod";
import {
	CiCommandStop,
	ciUsage,
	noRelaySelected,
	parseSince,
	type RelayReadTarget,
	readRelayApi,
	relayReplyInvalid,
	selectRelay,
	stopping,
} from "./ci-activity.js";
import type { CiCommand, CiCommandContext } from "./ci-commands.js";
import { CiProcessError, type CiRunExec, runCiProcess } from "./ci-runs.js";

const DAY_MS = 86_400_000;

// public-contract: how far back `hobo ci usage` and `performance` read when --since is not given.
export const INSIGHT_DEFAULT_WINDOW_MS = 30 * DAY_MS;
// public-contract: runs `--source github` reads when --runs is not given.
export const GITHUB_HISTORY_DEFAULT_RUNS = 50;
// public-contract: the most runs `--source github` reads.
export const GITHUB_HISTORY_MAX_RUNS = 100;

/**
 * GitHub's price for the standard Linux runner, the rate minutes kept off
 * GitHub-hosted runners are priced at when the report is computed here. A
 * relay passes its own rate and the report carries it.
 */
export const GITHUB_STANDARD_RATE: MinuteRate = {
	usdPerMinute: GITHUB_LINUX_USD_PER_MINUTE,
	source: GITHUB_INCLUDED_COMPUTE_SOURCE,
	readOn: GITHUB_INCLUDED_COMPUTE_OBSERVED_AT,
};

export type CiInsightCommandDeps = Readonly<{
	/** Runs `gh` for `--source github`; the real subprocess when absent. */
	execFile?: CiRunExec;
}>;

const USAGE_HELP = [
	"hobo ci usage [--repo owner/name] [--since 30d] [--json]",
	"hobo ci usage --source github [--repo owner/name] [--since 30d] [--runs <n>] [--json]",
	"Billed minutes per runner and day, short jobs, minutes kept off GitHub-hosted runners and the included minutes left.",
	"  --source relay   the connected relay's run history (default; --relay, HOBO_CI_RELAY_URL or .hobo/ci.json)",
	"  --source github  the repository's recent runs, read with the GitHub CLI",
].join("\n");

// --- GitHub history ------------------------------------------------------

const time = z.string().min(1).nullish();

const GithubRepository = z.looseObject({
	full_name: z.string().min(1),
	private: z.boolean(),
	default_branch: z.string().nullish(),
});

const GithubRun = z.looseObject({
	id: z.number().int().positive(),
	run_attempt: z.number().int().positive().nullish(),
	status: z.string().nullish(),
	created_at: z.string().min(1),
	run_started_at: time,
});

const GithubJob = z.looseObject({
	conclusion: z.string().nullish(),
	completed_at: time,
});

const RunsPage = z.looseObject({ workflow_runs: z.array(GithubRun) });
const JobsPage = z.looseObject({ jobs: z.array(GithubJob) });

/** Stored-run history read from GitHub on demand. */
export type GithubHistory = Readonly<{
	repository: string;
	/** GitHub bills the repository's standard hosted minutes. */
	private: boolean;
	/** Run attempts created at or after the start time, newest first. */
	runs: readonly InsightRun[];
	/** Runs GitHub listed before the start time was applied. */
	listed: number;
}>;

/**
 * An earlier attempt as GitHub would have described it: the run object
 * describes the latest attempt only, so the earlier one's result and end come
 * from its jobs.
 */
function earlierAttempt(
	run: z.infer<typeof GithubRun>,
	attempt: number,
	jobs: readonly z.infer<typeof GithubJob>[],
) {
	const failed = jobs.some(
		(job) => job.conclusion === "failure" || job.conclusion === "timed_out",
	);
	const ends = jobs.flatMap((job) =>
		job.completed_at ? [Date.parse(job.completed_at)] : [],
	);
	const end = ends.length > 0 ? Math.max(...ends) : undefined;
	return {
		...run,
		run_attempt: attempt,
		run_started_at: null,
		conclusion: failed ? "failure" : null,
		status: end === undefined ? "in_progress" : "completed",
		updated_at: end === undefined ? null : new Date(end).toISOString(),
	};
}

/**
 * A repository's recent completed runs, read with `gh api` and folded through
 * the webhook parser a relay uses, so a report computed from them equals one
 * computed from a relay's history of the same runs. The attempt before the
 * latest is read too: it is what shows a job failed and then passed.
 */
export async function readGithubHistory(
	input: Readonly<{
		repository: string;
		cwd: string;
		runs: number;
		sinceMs: number;
		exec: CiRunExec;
		env: NodeJS.ProcessEnv;
	}>,
): Promise<GithubHistory> {
	const env = { ...input.env };
	delete env.HOBO_CI_ACCOUNT_TOKEN;
	delete env.HOBO_CI_ACCOUNT_TOKEN_FILE;
	const api = async (path: string): Promise<string> =>
		(
			await input.exec("gh", ["api", path], {
				cwd: input.cwd,
				timeout: 30_000,
				maxBuffer: 16 * 1024 * 1024,
				env,
			})
		).stdout;
	const repo = `repos/${input.repository}`;
	const repository = GithubRepository.parse(JSON.parse(await api(repo)));
	const listed = RunsPage.parse(
		JSON.parse(await api(`${repo}/actions/runs?per_page=${input.runs}`)),
	).workflow_runs.filter((run) => run.status === "completed");
	const runs: InsightRun[] = [];
	for (const run of listed) {
		const created = Date.parse(run.run_started_at ?? run.created_at);
		if (Number.isNaN(created) || created < input.sinceMs) continue;
		const latest = run.run_attempt ?? 1;
		for (const attempt of latest > 1 ? [latest, latest - 1] : [latest]) {
			const jobs = JobsPage.parse(
				JSON.parse(
					await api(
						`${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`,
					),
				),
			).jobs;
			const described =
				attempt === latest ? run : earlierAttempt(run, attempt, jobs);
			const runFact = parseInsightWebhook(
				"workflow_run",
				JSON.stringify({
					action: "completed",
					workflow_run: described,
					repository,
				}),
			);
			if (runFact === undefined) continue;
			let folded = foldInsightWebhook(undefined, runFact);
			for (const job of jobs) {
				const jobFact = parseInsightWebhook(
					"workflow_job",
					JSON.stringify({
						action: "completed",
						workflow_job: job,
						repository,
					}),
				);
				if (jobFact !== undefined) folded = foldInsightWebhook(folded, jobFact);
			}
			runs.push(folded);
		}
	}
	return {
		repository: repository.full_name,
		private: repository.private,
		runs,
		listed: listed.length,
	};
}

/** A failed GitHub read in words. */
export function githubFailure(error: Error): CommandResult {
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
					? "GitHub found no such repository. Check --repo."
					: "GitHub could not be read, or answered with something that is not a run. Check gh auth status and repository Actions permissions.",
	};
}

/** The repository `--source github` reads: `--repo`, else the checkout's. */
export async function githubRepository(
	context: CiCommandContext,
	repo: string | undefined,
	help: string,
): Promise<Readonly<{ root: string; repository: string }>> {
	let local: Awaited<ReturnType<CiCommandContext["localRepository"]>>;
	try {
		local = await context.localRepository(repo);
	} catch {
		throw ciUsage(
			"Run this in a GitHub checkout or pass --repo owner/name.",
			help,
		);
	}
	if (!local.repository)
		throw ciUsage(
			"Run this in a GitHub checkout or pass --repo owner/name.",
			help,
		);
	return { root: local.root, repository: local.repository };
}

/** Reads GitHub history, turning a failed read into its result. */
export async function githubHistoryOrStop(
	read: () => Promise<GithubHistory>,
): Promise<GithubHistory> {
	try {
		return await read();
	} catch (error) {
		throw new CiCommandStop(
			githubFailure(
				error instanceof Error ? error : new Error("GitHub read failed"),
			),
		);
	}
}

// --- The usage report ----------------------------------------------------

const count = z.number().int().min(0);
const totals = {
	jobs: count,
	billedMinutes: z.number(),
	shortJobs: count,
	wasteMinutes: z.number(),
	keptMinutes: z.number(),
	keptUsd: z.number(),
	relayJobsAnswered: count,
	relaySavedMinutes: z.number(),
	relaySavedUsd: z.number(),
};

/** The read API's `usage` report: the same shape whichever side computed it. */
export const UsageReportJson = z.object({
	sinceMs: z.number(),
	runs: count,
	...totals,
	rate: z.object({
		usdPerMinute: z.number(),
		source: z.string(),
		readOn: z.string(),
	}),
	runners: z.array(
		z.object({ runner: z.string(), hosted: z.boolean(), ...totals }),
	),
	days: z.array(z.object({ day: z.string(), ...totals })),
	included: z
		.object({
			usedMinutes: z.number(),
			includedMinutes: z.number(),
			remainingMinutes: z.number(),
			burnPerDay: z.number(),
			daysLeft: z.number().optional(),
		})
		.optional(),
});
export type UsageReportView = z.infer<typeof UsageReportJson>;

export const minutesText = (value: number): string =>
	value >= 10 ? `${Math.round(value)} min` : `${value.toFixed(1)} min`;

const usd = (value: number): string => `$${value.toFixed(2)}`;

export function dayOf(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** The usage report as people read it. */
export function usageLines(
	report: UsageReportView,
	heading: string,
): readonly string[] {
	const lines = [
		heading,
		`  billed     ${minutesText(report.billedMinutes)} on GitHub-hosted runners in ${report.jobs} finished jobs`,
		`  short      ${report.shortJobs} billed jobs under a minute, ${minutesText(report.wasteMinutes)} billed but not run`,
		`  kept off   ${minutesText(report.keptMinutes)} ran on other runners, ${usd(report.keptUsd)} at ${usd(report.rate.usdPerMinute)}/min (${report.rate.source}, read ${report.rate.readOn})`,
		`  checks     ${report.relayJobsAnswered} relay jobs answered without a billed minute, saving ${minutesText(report.relaySavedMinutes)} (${usd(report.relaySavedUsd)})`,
		report.included === undefined
			? "  included   not measured: the plan's included minutes could not be read"
			: `  included   ${minutesText(report.included.usedMinutes)} of ${minutesText(report.included.includedMinutes)} used, ${minutesText(report.included.remainingMinutes)} left, burning ${minutesText(report.included.burnPerDay)} a day${report.included.daysLeft === undefined ? "" : `, ${Math.floor(report.included.daysLeft)} days left`}`,
	];
	if (report.runners.length > 0)
		lines.push(
			"runners",
			...report.runners
				.slice(0, 12)
				.map(
					(row) =>
						`  ${row.runner}  ${row.hosted ? "GitHub-hosted" : "elsewhere"}  billed ${minutesText(row.billedMinutes)}  kept ${minutesText(row.keptMinutes)}  short ${row.shortJobs}  jobs ${row.jobs}`,
				),
		);
	if (report.days.length > 0)
		lines.push(
			"days",
			...report.days
				.slice(-14)
				.map(
					(day) =>
						`  ${day.day}  billed ${minutesText(day.billedMinutes)}  kept ${minutesText(day.keptMinutes)}  short ${day.shortJobs}`,
				),
		);
	return lines;
}

/** One of the frozen relay reports, parsed. */
export async function readRelayReport<T>(
	context: CiCommandContext,
	target: RelayReadTarget,
	path: string,
	query: Readonly<{ repository: string | undefined; sinceMs: number }>,
	schema: z.ZodType<T>,
	command: string,
): Promise<T> {
	const params = new URLSearchParams();
	if (query.repository) params.set("repository", query.repository);
	params.set("since", String(Math.max(0, Math.floor(query.sinceMs))));
	const body = await readRelayApi(context, target, path, params, () => ({
		ok: false,
		status: "unavailable",
		code: "HOBO_CI_NOT_STORED_HERE",
		message:
			"This relay keeps no run history (the hosted relay stores none). Read GitHub instead with --source github.",
		remediation: [`Run ${command} --source github.`],
	}));
	try {
		return schema.parse(JSON.parse(body));
	} catch {
		throw relayReplyInvalid(target.origin);
	}
}

export type InsightArgs = Readonly<{
	source: "relay" | "github";
	relay: string | undefined;
	tokenFile: string | undefined;
	repo: string | undefined;
	sinceMs: number;
	runs: number;
}>;

/** The options `usage` and `performance` share. */
export function parseInsightArgs(
	args: readonly string[],
	nowMs: number,
	help: string,
): InsightArgs {
	let values: Readonly<{
		source?: string | undefined;
		relay?: string | undefined;
		"token-file"?: string | undefined;
		repo?: string | undefined;
		since?: string | undefined;
		runs?: string | undefined;
	}>;
	try {
		values = parseArgs({
			args: [...args],
			allowPositionals: false,
			strict: true,
			options: {
				source: { type: "string" },
				relay: { type: "string" },
				"token-file": { type: "string" },
				repo: { type: "string" },
				since: { type: "string" },
				runs: { type: "string" },
				json: { type: "boolean" },
			},
		}).values;
	} catch (error) {
		throw ciUsage(
			error instanceof Error ? error.message : "Invalid arguments.",
			help,
		);
	}
	const source = values.source ?? "relay";
	if (source !== "relay" && source !== "github")
		throw ciUsage("--source is relay or github.", help);
	const sinceMs =
		values.since === undefined
			? nowMs - INSIGHT_DEFAULT_WINDOW_MS
			: parseSince(values.since, nowMs);
	if (sinceMs === undefined)
		throw ciUsage("--since takes 30d, 12h, 30m or a date.", help);
	const runs =
		values.runs === undefined
			? GITHUB_HISTORY_DEFAULT_RUNS
			: Number(values.runs);
	if (!Number.isSafeInteger(runs) || runs < 1 || runs > GITHUB_HISTORY_MAX_RUNS)
		throw ciUsage(
			`--runs is a whole number from 1 to ${GITHUB_HISTORY_MAX_RUNS}.`,
			help,
		);
	if (values.runs !== undefined && source !== "github")
		throw ciUsage("--runs goes with --source github.", help);
	return {
		source,
		relay: values.relay,
		tokenFile: values["token-file"],
		repo: values.repo,
		sinceMs,
		runs,
	};
}

/** The GitHub CLI's token, for the billing read; undefined when it has none. */
async function githubToken(
	exec: CiRunExec,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
	try {
		const token = (
			await exec("gh", ["auth", "token"], {
				cwd,
				timeout: 10_000,
				maxBuffer: 4096,
				env,
			})
		).stdout.trim();
		return token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

async function usageFromGithub(
	context: CiCommandContext,
	options: InsightArgs,
	exec: CiRunExec,
): Promise<CommandResult> {
	const { root, repository } = await githubRepository(
		context,
		options.repo,
		USAGE_HELP,
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
	const owner = history.repository.split("/")[0] ?? "";
	const reader = new GithubMinutesReader({
		fetch: context.fetch,
		baseUrl: "https://api.github.com",
		token: () => githubToken(exec, root, context.env),
		plan: undefined,
		recentMinutes: undefined,
		now: context.now,
		cacheMs: 0,
	});
	const computed = usageReport(history.runs, {
		githubRate: GITHUB_STANDARD_RATE,
		included: await reader.usage(owner),
		publicRepositories: new Set(history.private ? [] : [history.repository]),
	});
	const report = UsageReportJson.parse(
		JSON.parse(
			JSON.stringify({
				sinceMs: options.sinceMs,
				runs: history.runs.length,
				...computed,
			}),
		),
	);
	return {
		message: usageLines(
			report,
			`Actions usage for ${history.repository} since ${dayOf(options.sinceMs)}, from GitHub (${history.runs.length} run attempts of the newest ${history.listed} runs):`,
		).join("\n"),
		data: { source: "github", repository: history.repository, report },
	};
}

async function usage(
	context: CiCommandContext,
	exec: CiRunExec,
): Promise<CommandResult> {
	const options = parseInsightArgs(context.args, context.now(), USAGE_HELP);
	if (options.source === "github")
		return usageFromGithub(context, options, exec);
	const target = await selectRelay(context, options);
	if (!target) return noRelaySelected(", or pass --source github");
	const report = await readRelayReport(
		context,
		target,
		"/usage",
		{ repository: options.repo, sinceMs: options.sinceMs },
		UsageReportJson,
		"hobo ci usage",
	);
	return {
		message: usageLines(
			report,
			`Actions usage for ${options.repo ?? "every connected repository"} since ${dayOf(report.sinceMs)}, from the relay (${report.runs} run attempts):`,
		).join("\n"),
		data: {
			source: "relay",
			relay: target.origin,
			repository: options.repo ?? null,
			report,
		},
	};
}

/** `hobo ci usage`, running `gh` through `deps.execFile` for `--source github`. */
export function createCiUsageCommand(
	deps: CiInsightCommandDeps = {},
): CiCommand {
	const exec = deps.execFile ?? runCiProcess;
	return {
		name: "usage",
		summary:
			"Billed minutes per runner and day, short jobs, minutes kept off GitHub-hosted runners and the included minutes left.",
		run: (context) => stopping(() => usage(context, exec)),
	};
}

export const CI_USAGE_COMMAND = createCiUsageCommand();
