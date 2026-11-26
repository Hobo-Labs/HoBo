import { execFile } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import type { CredentialResolver } from "@hobo/cd";
import type { CommandResult } from "@hobo/cli";
import { z } from "zod";
import {
	GITHUB_APP_NEEDED_REFUSAL,
	GithubApiError,
	GithubAppNeeded,
	githubAppReader,
} from "./ci-github-app.js";
import { isJsonString } from "./json.js";

export type CiRunOptions = Readonly<
	Record<string, string | boolean | readonly string[] | undefined>
>;

export type CiRunExec = (
	file: string,
	args: readonly string[],
	options: {
		cwd: string;
		timeout: number;
		maxBuffer: number;
		env?: NodeJS.ProcessEnv;
	},
) => Promise<{ stdout: string; stderr: string; truncated?: boolean }>;

export class CiProcessError extends Error {
	constructor(
		readonly kind: "missing" | "timeout" | "failed",
		readonly executable: string,
	) {
		super("CI subprocess failed");
	}
}

export const runCiProcess: CiRunExec = (file, args, options) =>
	new Promise((resolve, reject) => {
		execFile(
			file,
			[...args],
			{ ...options, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (
					error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
					error.message.startsWith("stdout")
				)
					resolve({ stdout, stderr: "", truncated: true });
				else if (error)
					reject(
						new CiProcessError(
							error.code === "ENOENT"
								? "missing"
								: error.killed
									? "timeout"
									: "failed",
							file,
						),
					);
				else resolve({ stdout, stderr });
			},
		);
	});

const LOG_BYTES = 2 * 1024 * 1024;
const JOBS_PER_PAGE = 100;
const MAX_JOB_PAGES = 10;

const supported = {
	list: ["branch", "git-branch", "all-branches", "commit", "status", "limit"],
	ls: ["branch", "git-branch", "all-branches", "commit", "status", "limit"],
	inspect: ["attempt", "wait"],
	logs: ["failed", "task", "grep", "attempt", "limit"],
	grep: ["branch", "git-branch", "all-branches", "status", "runs"],
	rerun: ["wait"],
};

class CiRunUsage extends Error {}
class CiWaitTimeout extends Error {}

function humanText(text: string, multiline = false): string {
	const clean = stripVTControlCharacters(text).replace(
		/[\u202a-\u202e\u2066-\u2069]/gu,
		"",
	);
	return clean.replace(/\p{Cc}/gu, (character) =>
		multiline && (character === "\n" || character === "\t") ? character : " ",
	);
}

function textOption(options: CiRunOptions, name: string): string | undefined {
	const value = options[name];
	if (value === undefined) return undefined;
	if (!isJsonString(value) || !value || /\p{Cc}/u.test(value))
		throw new CiRunUsage(`--${name} requires a nonempty text value.`);
	return value;
}

function switchOption(options: CiRunOptions, name: string): boolean {
	const value = options[name];
	if (value === undefined || value === false) return false;
	if (value !== true) throw new CiRunUsage(`--${name} does not take a value.`);
	return true;
}

function countOption(
	options: CiRunOptions,
	name: string,
	fallback: number,
	max: number,
): number {
	const value = textOption(options, name);
	if (value === undefined) return fallback;
	if (!/^[1-9]\d*$/.test(value) || Number(value) > max)
		throw new CiRunUsage(`--${name} must be an integer from 1 to ${max}.`);
	return Number(value);
}

const RUN_STATUSES = [
	"queued",
	"in_progress",
	"completed",
	"waiting",
	"pending",
	"requested",
] as const;

const RUN_CONCLUSIONS = [
	"success",
	"failure",
	"neutral",
	"skipped",
	"stale",
	"timed_out",
	"cancelled",
	"action_required",
	"startup_failure",
] as const;

const RestRun = z
	.looseObject({
		id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		name: z.string().nullish(),
		display_title: z.string(),
		head_branch: z.string().nullish(),
		head_sha: z.string(),
		status: z.enum(RUN_STATUSES),
		conclusion: z.enum(RUN_CONCLUSIONS).nullish(),
		html_url: z.string(),
		run_attempt: z
			.number()
			.int()
			.positive()
			.max(Number.MAX_SAFE_INTEGER)
			.nullish(),
	})
	.refine((run) => run.status !== "completed" || Boolean(run.conclusion));

const RestRunsPage = z.looseObject({ workflow_runs: z.array(RestRun) });

const RestStep = z.looseObject({
	name: z.string(),
	number: z.number().int(),
	status: z.string(),
	conclusion: z.string().nullish(),
});

const RestJob = z.looseObject({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	name: z.string(),
	status: z.string(),
	conclusion: z.string().nullish(),
	started_at: z.string().nullish(),
	completed_at: z.string().nullish(),
	html_url: z.string().nullish(),
	steps: z.array(RestStep).nullish(),
});

const RestJobsPage = z.looseObject({
	total_count: z.number().int().nonnegative(),
	jobs: z.array(RestJob),
});

type CiRunJob = Readonly<{
	databaseId: number;
	name: string;
	status: string;
	conclusion: string;
	startedAt: string;
	completedAt: string;
	url: string;
	steps: readonly Readonly<{
		name: string;
		number: number;
		status: string;
		conclusion: string;
	}>[];
}>;

function runRecord(value: z.infer<typeof RestRun>) {
	return {
		id: value.id,
		name: value.name ?? "",
		title: value.display_title,
		branch: value.head_branch ?? "",
		commit: value.head_sha,
		status: value.status,
		conclusion: value.conclusion ?? "",
		url: value.html_url,
	};
}

function runJob(job: z.infer<typeof RestJob>): CiRunJob {
	return {
		databaseId: job.id,
		name: job.name,
		status: job.status,
		conclusion: job.conclusion ?? "",
		startedAt: job.started_at ?? "",
		completedAt: job.completed_at ?? "",
		url: job.html_url ?? "",
		steps: (job.steps ?? []).map((step) => ({
			name: step.name,
			number: step.number,
			status: step.status,
			conclusion: step.conclusion ?? "",
		})),
	};
}

function runList(text: string) {
	return RestRunsPage.parse(JSON.parse(text)).workflow_runs.map(runRecord);
}

function failed(conclusion: string | null): boolean {
	return [
		"failure",
		"timed_out",
		"cancelled",
		"action_required",
		"startup_failure",
		"stale",
	].includes(conclusion ?? "");
}

/** GitHub owns Actions run history, logs and retry state; the relay owns runner leases. */
export async function runCiRuns(input: {
	command: string;
	repository: string;
	cwd: string;
	args: readonly string[];
	options: CiRunOptions;
	execFile?: CiRunExec;
	env?: NodeJS.ProcessEnv;
	credentials: CredentialResolver | undefined;
	fetch: typeof fetch;
	emitProgress?: (message: string) => void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<CommandResult> {
	const { command, repository, cwd, args, options } = input;
	const exec = input.execFile ?? runCiProcess;
	const env = input.env ?? process.env;
	const now = input.now ?? Date.now;
	const sleep =
		input.sleep ??
		(async (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let outputTruncated = false;
	let remainingLogBytes = LOG_BYTES;
	const git = async (argv: readonly string[]) => {
		const result = await exec("git", argv, {
			cwd,
			timeout: 30000,
			maxBuffer: LOG_BYTES,
			env,
		});
		if (result.truncated) throw new CiProcessError("failed", "git");
		return result.stdout;
	};
	const github = githubAppReader({
		credentials: input.credentials,
		repository,
		fetch: input.fetch,
		scope: `hobo ci ${command}`,
	});
	const repo = `repos/${repository}`;
	const read = (path: string) => github.read(path);
	const jobLog = async (jobId: number) => {
		const body = await github.log(
			`${repo}/actions/jobs/${jobId}/logs`,
			LOG_BYTES,
		);
		const bytes = Buffer.from(body.text);
		outputTruncated ||= body.truncated || bytes.length > remainingLogBytes;
		const text = bytes.subarray(0, remainingLogBytes).toString("utf8");
		remainingLogBytes -= Math.min(bytes.length, remainingLogBytes);
		return text;
	};
	const jobsAt = async (path: string): Promise<CiRunJob[]> => {
		const jobs: CiRunJob[] = [];
		for (let page = 1; page <= MAX_JOB_PAGES; page++) {
			const listed = RestJobsPage.parse(
				JSON.parse(
					await read(`${path}?per_page=${JOBS_PER_PAGE}&page=${page}`),
				),
			);
			jobs.push(...listed.jobs.map(runJob));
			if (
				jobs.length >= listed.total_count ||
				listed.jobs.length < JOBS_PER_PAGE
			)
				break;
		}
		return jobs;
	};
	try {
		if (
			!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(
				repository,
			)
		)
			throw new CiRunUsage("Select a GitHub repository as owner/name.");
		if (!Object.hasOwn(supported, command))
			throw new CiRunUsage("Use hobo ci list, inspect, logs, grep, or rerun.");
		// SAFETY: own-key check above narrows the external subcommand to this fixed table.
		const allowed = supported[command as keyof typeof supported];
		for (const key of Object.keys(options)) {
			if (!allowed.includes(key))
				throw new CiRunUsage(
					`hobo ci ${command} does not support --${key}. GitHub Actions logs are unstructured; use --grep for text filtering.`,
				);
		}
		if (args.length > (command === "list" || command === "ls" ? 0 : 1))
			throw new CiRunUsage(`Too many arguments for hobo ci ${command}.`);

		const listPath = async (limit: number): Promise<string> => {
			const branch =
				textOption(options, "git-branch") ?? textOption(options, "branch");
			if (options["git-branch"] !== undefined && options.branch !== undefined)
				throw new CiRunUsage("Choose --git-branch or --branch.");
			const all = switchOption(options, "all-branches");
			const commit = textOption(options, "commit");
			if (all && (branch || commit))
				throw new CiRunUsage(
					"--all-branches cannot be combined with --branch or --commit.",
				);
			if (commit && !/^[a-fA-F0-9]{7,64}$/.test(commit))
				throw new CiRunUsage("--commit requires a Git commit SHA.");
			const query = new URLSearchParams({ per_page: String(limit) });
			if (!all && (!commit || branch)) {
				const selected =
					branch ?? (await git(["branch", "--show-current"])).trim();
				if (!selected)
					throw new CiRunUsage(
						"Detached HEAD: pass --branch NAME or --all-branches.",
					);
				query.set("branch", selected);
			}
			if (commit) query.set("head_sha", commit);
			const status = textOption(options, "status");
			if (status) {
				const statuses = new Map([
					["queued", "queued"],
					["running", "in_progress"],
					["succeeded", "success"],
					["failed", "failure"],
					["skipped", "skipped"],
				]);
				const selectedStatus = statuses.get(status);
				if (!selectedStatus)
					throw new CiRunUsage(
						"--status must be queued, running, succeeded, failed, or skipped.",
					);
				query.set("status", selectedStatus);
			}
			return `${repo}/actions/runs?${query}`;
		};

		if (command === "list" || command === "ls") {
			const limit = countOption(options, "limit", 20, 100);
			const runs = runList(await read(await listPath(limit)));
			return {
				ok: true,
				message: runs.length
					? runs
							.map(
								(run) =>
									`${run.id}  ${run.conclusion || run.status}  ${humanText(run.title)}`,
							)
							.join("\n")
					: "No GitHub Actions runs found.",
				data: { repository, runs, limit },
			};
		}

		if (command === "grep") {
			const query = args[0];
			if (!query || query.length > 1024 || /\p{Cc}/u.test(query))
				throw new CiRunUsage(
					"hobo ci grep <text> requires a search string of up to 1024 characters.",
				);
			const runs = runList(
				await read(await listPath(countOption(options, "runs", 20, 50))),
			);
			const matches: { runId: number; line: string }[] = [];
			let searched = 0;
			const deadline = now() + 120000;
			const unavailableRuns: number[] = [];
			for (const run of runs) {
				if (
					now() >= deadline ||
					matches.length >= 200 ||
					remainingLogBytes === 0
				)
					break;
				if (run.status !== "completed") continue;
				const logs: string[] = [];
				try {
					for (const job of await jobsAt(
						`${repo}/actions/runs/${run.id}/jobs`,
					)) {
						if (remainingLogBytes === 0) break;
						try {
							logs.push(await jobLog(job.databaseId));
						} catch (error) {
							if (
								!(error instanceof GithubApiError) ||
								error.httpStatus !== 404
							)
								throw error;
						}
					}
				} catch (error) {
					if (!(error instanceof GithubApiError) || error.httpStatus !== 404)
						throw error;
				}
				if (logs.length === 0) {
					unavailableRuns.push(run.id);
					continue;
				}
				searched++;
				for (const line of logs.join("\n").split("\n")) {
					if (line.toLowerCase().includes(query.toLowerCase()))
						matches.push({ runId: run.id, line });
					if (matches.length >= 200) break;
				}
			}
			const partial =
				searched < runs.length || matches.length >= 200 || outputTruncated;
			return {
				ok: searched > 0 || runs.length === 0,
				code:
					searched === 0 && runs.length > 0
						? "HOBO_CI_LOGS_UNAVAILABLE"
						: "HOBO_OK",
				message: `${matches.map((match) => `${match.runId}  ${humanText(match.line)}`).join("\n") || "No matching log lines in the available logs."}${partial ? "\nSearch incomplete: some logs were unavailable or the scan/output limit was reached." : ""}`,
				data: {
					repository,
					matches,
					searched,
					partial,
					unavailableRuns,
					truncated: outputTruncated,
				},
			};
		}

		let runId = args[0];
		if (
			runId &&
			(!/^[1-9]\d*$/.test(runId) || !Number.isSafeInteger(Number(runId)))
		)
			throw new CiRunUsage(
				"Run ID must be a positive GitHub Actions run ID from hobo ci list.",
			);
		if (!runId) {
			const commit = (await git(["rev-parse", "HEAD"])).trim();
			if (!/^[a-fA-F0-9]{40,64}$/.test(commit))
				throw new Error("Invalid Git commit");
			const query = new URLSearchParams({ head_sha: commit, per_page: "1" });
			if (command === "rerun") query.set("status", "failure");
			const latest = runList(await read(`${repo}/actions/runs?${query}`))[0];
			if (!latest)
				return {
					ok: false,
					code: "HOBO_CI_RUN_NOT_FOUND",
					status: "not-found",
					message:
						command === "rerun"
							? "No failed run found for the current commit."
							: "No run found for the current commit.",
					remediation: ["Run hobo ci list --all-branches and pass a run ID."],
				};
			runId = String(latest.id);
		}
		const runPath = `${repo}/actions/runs/${runId}`;
		let viewAttempt =
			options.attempt === undefined
				? undefined
				: countOption(options, "attempt", 1, 100000);
		const readRun = async () => {
			const viewed =
				viewAttempt === undefined
					? runPath
					: `${runPath}/attempts/${viewAttempt}`;
			const run = runRecord(RestRun.parse(JSON.parse(await read(viewed))));
			if (String(run.id) !== runId)
				throw new Error("GitHub returned a different run identity");
			return { ...run, jobs: await jobsAt(`${viewed}/jobs`) };
		};
		const wait = switchOption(options, "wait");
		const deadline = now() + 600000;
		// Retry only read requests. A failed rerun response may already have
		// committed at GitHub and must never be submitted a second time here.
		const retryRead = async <T>(
			readValue: () => Promise<T>,
			newAttempt = false,
		) => {
			const recoverBy = Math.min(deadline, now() + 30000);
			for (;;) {
				try {
					return await readValue();
				} catch (error) {
					if (now() >= deadline) throw new CiWaitTimeout();
					if (
						!wait ||
						!(error instanceof GithubApiError) ||
						!(
							error.kind === "timeout" ||
							(error.httpStatus !== undefined && error.httpStatus >= 500) ||
							(newAttempt && error.httpStatus === 404)
						) ||
						now() >= recoverBy
					)
						throw error;
					await sleep(1000);
				}
			}
		};
		let run = await retryRead(readRun);
		const readAttempt = async () => {
			const attempt = RestRun.parse(
				JSON.parse(await read(runPath)),
			).run_attempt;
			if (attempt === undefined || attempt === null)
				throw new Error("Invalid GitHub attempt response");
			return attempt;
		};
		let targetAttempt = viewAttempt;
		if (command === "rerun") {
			if (run.status !== "completed")
				throw new CiRunUsage("Only finished runs can be rerun.");
			if (!args[0] && !failed(run.conclusion))
				throw new CiRunUsage(
					"The selected run is no longer failed. Pass an explicit run ID to rerun a successful or skipped run.",
				);
			const previousAttempt = wait ? await retryRead(readAttempt) : 0;
			await github.post(`${runPath}/rerun`);
			if (wait) {
				targetAttempt = previousAttempt + 1;
				// Pin the newly requested attempt. Another operator may retry the
				// same run later; that must not replace the result we are waiting for.
				viewAttempt = targetAttempt;
				let observedAttempt = await retryRead(readAttempt);
				while (observedAttempt < targetAttempt) {
					if (now() >= deadline) throw new CiWaitTimeout();
					await sleep(1000);
					observedAttempt = await retryRead(readAttempt);
				}
				run = await retryRead(readRun, true);
				if (observedAttempt !== targetAttempt || run.status === "completed")
					return {
						ok: false,
						code: "HOBO_CI_RERUN_AMBIGUOUS",
						status: "unconfirmed",
						message:
							"GitHub accepted the rerun, but its attempt cannot be identified safely: another rerun may have intervened or the next attempt already finished. Inspect the run history; the CLI did not repeat the rerun.",
						data: {
							repository,
							runId: run.id,
							expectedAttempt: targetAttempt,
							observedAttempt,
						},
					};
			}
		}
		if (wait && run.status !== "completed") {
			if (targetAttempt === undefined) {
				targetAttempt = await retryRead(readAttempt);
				viewAttempt = targetAttempt;
			}
			let lastStatus = "";
			while (run.status !== "completed") {
				if (now() >= deadline) throw new CiWaitTimeout();
				if (lastStatus !== run.status)
					input.emitProgress?.(
						`CI run ${runId}, attempt ${targetAttempt}: ${humanText(run.status)}`,
					);
				lastStatus = run.status;
				await sleep(3000);
				run = await retryRead(readRun);
			}
		}
		if (command === "logs") {
			const limit = countOption(options, "limit", 10, 25);
			const selected = options.task;
			const names =
				selected === undefined
					? []
					: isJsonString(selected)
						? [selected]
						: Array.isArray(selected)
							? selected
							: [];
			if (selected !== undefined && !names.length)
				throw new CiRunUsage("--task requires a job name.");
			const onlyFailed = switchOption(options, "failed");
			const jobs = run.jobs.filter(
				(job) =>
					(!names.length || names.includes(job.name)) &&
					(!onlyFailed || failed(job.conclusion)),
			);
			if (names.some((name) => !run.jobs.some((job) => job.name === name)))
				throw new CiRunUsage(
					"Requested task was not found. HoBo Actions task selectors use exact GitHub job names shown by hobo ci inspect.",
				);
			const query = textOption(options, "grep")?.toLowerCase();
			const logs: { task: string; text: string }[] = [];
			const unavailableTasks: string[] = [];
			for (const job of jobs.slice(0, limit)) {
				if (remainingLogBytes === 0) break;
				let text: string;
				try {
					text = await jobLog(job.databaseId);
				} catch (error) {
					if (!(error instanceof GithubApiError) || error.httpStatus !== 404)
						throw error;
					unavailableTasks.push(job.name);
					continue;
				}
				logs.push({
					task: job.name,
					text: query
						? text
								.split("\n")
								.filter((line) => line.toLowerCase().includes(query))
								.join("\n")
						: text,
				});
			}
			const partial =
				jobs.length > limit ||
				unavailableTasks.length > 0 ||
				outputTruncated ||
				logs.length < Math.min(jobs.length, limit);
			return {
				ok: logs.length > 0 || jobs.length === 0,
				code:
					logs.length === 0 && jobs.length > 0
						? "HOBO_CI_LOGS_UNAVAILABLE"
						: "HOBO_OK",
				message: `${logs.map((log) => `${humanText(log.task)}\n${humanText(log.text, true)}`).join("\n") || "No matching task logs are currently available."}${partial ? "\nPartial logs: a task log was unavailable or the task/output limit was reached. Select --task or inspect the run status." : ""}`,
				data: {
					repository,
					runId: run.id,
					logs,
					partial,
					unavailableTasks,
					truncated: outputTruncated,
				},
			};
		}
		const complete = run.status === "completed";
		const waitFailed =
			switchOption(options, "wait") && complete && failed(run.conclusion);
		const jobs =
			command === "inspect"
				? run.jobs.map(
						(job) =>
							`${humanText(job.name)}  ${humanText(job.conclusion || job.status || "unknown")}`,
					)
				: [];
		const summary = `${run.id}  ${humanText(run.conclusion || run.status)}  ${humanText(run.title)}\n${humanText(run.url)}${jobs.length ? `\n\nJobs\n${jobs.join("\n")}` : ""}`;
		return {
			ok: !waitFailed,
			code: waitFailed ? "HOBO_CI_RUN_FAILED" : "HOBO_OK",
			status: waitFailed
				? "failed"
				: command === "rerun" && !wait
					? "requested"
					: run.status,
			message:
				command === "rerun" && !switchOption(options, "wait")
					? `Rerun requested for ${runId}. Run hobo ci inspect ${runId} --wait to follow it.`
					: summary,
			data: { repository, run, attempt: targetAttempt },
		};
	} catch (error) {
		if (error instanceof GithubAppNeeded) return GITHUB_APP_NEEDED_REFUSAL;
		if (error instanceof GithubApiError && error.httpStatus) {
			const status = error.httpStatus;
			const message =
				status === 401 || status === 403
					? "GitHub denied this operation. Check that HoBo's GitHub App is installed on the repository with Actions read permission, and Actions write permission for hobo ci rerun."
					: status === 404
						? "The GitHub run or requested attempt was not found. Check the run ID, attempt and repository."
						: status === 429
							? "GitHub rate limited this operation. Wait before retrying."
							: "GitHub could not complete the operation. Inspect the run before repeating a rerun.";
			return {
				ok: false,
				code: "HOBO_CI_GITHUB_FAILED",
				status: "error",
				message,
				data: { httpStatus: status },
			};
		}
		if (
			(error instanceof GithubApiError || error instanceof CiProcessError) &&
			error.kind === "timeout"
		)
			return {
				ok: false,
				status: "unconfirmed",
				code: "HOBO_CI_OPERATION_TIMEOUT",
				message:
					"The GitHub request timed out. A rerun may already have been accepted; inspect the run before repeating it.",
			};
		if (error instanceof CiWaitTimeout)
			return {
				ok: false,
				status: "pending",
				code: "HOBO_CI_WAIT_TIMEOUT",
				message:
					"The ten-minute wait expired. Remote work continues; inspect the run before retrying. The CLI did not cancel or repeat it.",
			};
		if (error instanceof CiProcessError && error.kind === "missing")
			return {
				ok: false,
				status: "unavailable",
				code: "HOBO_CI_TOOL_REQUIRED",
				message: "Install Git, then retry this CI command.",
			};
		if (error instanceof CiRunUsage)
			return {
				ok: false,
				status: "usage",
				code: "HOBO_CLI_USAGE",
				message: error.message,
				remediation: ["Run hobo ci --help for supported commands and options."],
			};
		return {
			ok: false,
			status: "error",
			code: "HOBO_CI_GITHUB_FAILED",
			message:
				"GitHub could not complete the CI run operation. Check that HoBo's GitHub App is installed on the repository with Actions permissions; inspect the run before repeating a rerun because its outcome may be unconfirmed.",
			remediation: [
				"Check that HoBo's GitHub App is installed on the repository with Actions read permission, and Actions write permission for hobo ci rerun, then inspect the run before repeating a mutation.",
			],
		};
	}
}
