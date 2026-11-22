import { execFile } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import type { CommandResult } from "@hobo/cli";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonValue,
} from "./json.js";

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
		readonly httpStatus?: number,
	) {
		super("CI subprocess failed");
	}
}

const execute: CiRunExec = (file, args, options) =>
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
							Number(/HTTP\s+(\d{3})/.exec(stderr)?.[1]) || undefined,
						),
					);
				else resolve({ stdout, stderr });
			},
		);
	});

const runFields =
	"databaseId,name,displayTitle,headBranch,headSha,status,conclusion,url";
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

function runRecord(value: JsonValue) {
	if (
		!isJsonObject(value) ||
		!isJsonNumber(value.databaseId) ||
		!Number.isSafeInteger(value.databaseId) ||
		value.databaseId < 1 ||
		!isJsonString(value.status) ||
		!isJsonString(value.headSha) ||
		!isJsonString(value.headBranch) ||
		!isJsonString(value.name) ||
		!isJsonString(value.displayTitle) ||
		!isJsonString(value.url) ||
		!(value.conclusion === null || isJsonString(value.conclusion)) ||
		(isJsonString(value.conclusion) &&
			value.conclusion !== "" &&
			![
				"success",
				"failure",
				"neutral",
				"skipped",
				"stale",
				"timed_out",
				"cancelled",
				"action_required",
				"startup_failure",
			].includes(value.conclusion)) ||
		![
			"queued",
			"in_progress",
			"completed",
			"waiting",
			"pending",
			"requested",
		].includes(value.status) ||
		(value.status === "completed" && !value.conclusion)
	)
		throw new Error("Invalid GitHub run response");
	return {
		id: value.databaseId,
		name: value.name,
		title: value.displayTitle,
		branch: value.headBranch,
		commit: value.headSha,
		status: value.status,
		conclusion: value.conclusion,
		url: value.url,
	};
}

function runList(text: string) {
	const value = parseJsonValue(text);
	if (!isJsonArray(value)) throw new Error("Invalid GitHub run list");
	return value.map(runRecord);
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
	emitProgress?: (message: string) => void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<CommandResult> {
	const { command, repository, cwd, args, options } = input;
	const exec = input.execFile ?? execute;
	const env = { ...(input.env ?? process.env) };
	delete env.HOBO_CI_ACCOUNT_TOKEN;
	delete env.HOBO_CI_ACCOUNT_TOKEN_FILE;
	const now = input.now ?? Date.now;
	const sleep =
		input.sleep ??
		(async (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let outputTruncated = false;
	let remainingLogBytes = 2 * 1024 * 1024;
	const call = async (
		file: string,
		argv: readonly string[],
		timeout = 30000,
		log = false,
	) => {
		const result = await exec(file, argv, {
			cwd,
			timeout,
			maxBuffer: 2 * 1024 * 1024,
			env,
		});
		if (result.truncated && !log) throw new CiProcessError("failed", file);
		if (!log) return result.stdout;
		const bytes = Buffer.from(result.stdout);
		outputTruncated ||=
			Boolean(result.truncated) || bytes.length > remainingLogBytes;
		const text = bytes.subarray(0, remainingLogBytes).toString("utf8");
		remainingLogBytes -= Math.min(bytes.length, remainingLogBytes);
		return text;
	};
	const gh = (argv: readonly string[], timeout?: number, log = false) =>
		call(
			"gh",
			["run", ...argv, "--repo", `github.com/${repository}`],
			timeout,
			log,
		);
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

		const listArgs = async (limit: number): Promise<string[]> => {
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
			const flags = ["list", "--json", runFields, "--limit", String(limit)];
			if (!all && (!commit || branch)) {
				const selected =
					branch ?? (await call("git", ["branch", "--show-current"])).trim();
				if (!selected)
					throw new CiRunUsage(
						"Detached HEAD: pass --branch NAME or --all-branches.",
					);
				flags.push("--branch", selected);
			}
			if (commit) flags.push("--commit", commit);
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
				flags.push("--status", selectedStatus);
			}
			return flags;
		};

		if (command === "list" || command === "ls") {
			const limit = countOption(options, "limit", 20, 100);
			const runs = runList(await gh(await listArgs(limit)));
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
				await gh(await listArgs(countOption(options, "runs", 20, 50))),
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
				let logs: string;
				try {
					logs = await gh(["view", String(run.id), "--log"], undefined, true);
				} catch (error) {
					if (error instanceof CiProcessError && error.httpStatus !== 404)
						throw error;
					unavailableRuns.push(run.id);
					continue;
				}
				searched++;
				for (const line of logs.split("\n")) {
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
			const commit = (await call("git", ["rev-parse", "HEAD"])).trim();
			if (!/^[a-fA-F0-9]{40,64}$/.test(commit))
				throw new Error("Invalid Git commit");
			const flags = [
				"list",
				"--commit",
				commit,
				"--limit",
				"1",
				"--json",
				runFields,
			];
			if (command === "rerun") flags.push("--status", "failure");
			const latest = runList(await gh(flags))[0];
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
		const viewFlags = ["view", runId];
		if (options.attempt !== undefined)
			viewFlags.push(
				"--attempt",
				String(countOption(options, "attempt", 1, 100000)),
			);
		const read = async () => {
			const value = parseJsonValue(
				await gh([...viewFlags, "--json", `${runFields},jobs`]),
			);
			const run = runRecord(value);
			if (String(run.id) !== runId)
				throw new Error("GitHub returned a different run identity");
			if (
				!isJsonObject(value) ||
				!(value.jobs === null || isJsonArray(value.jobs))
			)
				throw new Error("Invalid GitHub jobs response");
			return { ...run, jobs: value.jobs ?? [] };
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
						!(error instanceof CiProcessError) ||
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
		let run = await retryRead(read);
		const readAttempt = async () => {
			const value = (
				await call("gh", [
					"api",
					`repos/${repository}/actions/runs/${runId}`,
					"--jq",
					".run_attempt",
					"--hostname",
					"github.com",
				])
			).trim();
			if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
				throw new Error("Invalid GitHub attempt response");
			return Number(value);
		};
		let targetAttempt =
			options.attempt === undefined
				? undefined
				: countOption(options, "attempt", 1, 100000);
		if (command === "rerun") {
			if (run.status !== "completed")
				throw new CiRunUsage("Only finished runs can be rerun.");
			if (!args[0] && !failed(run.conclusion))
				throw new CiRunUsage(
					"The selected run is no longer failed. Pass an explicit run ID to rerun a successful or skipped run.",
				);
			const previousAttempt = wait ? await retryRead(readAttempt) : 0;
			await gh(["rerun", runId]);
			if (wait) {
				targetAttempt = previousAttempt + 1;
				// Pin the newly requested attempt. Another operator may retry the
				// same run later; that must not replace the result we are waiting for.
				viewFlags.push("--attempt", String(targetAttempt));
				let observedAttempt = await retryRead(readAttempt);
				while (observedAttempt < targetAttempt) {
					if (now() >= deadline) throw new CiWaitTimeout();
					await sleep(1000);
					observedAttempt = await retryRead(readAttempt);
				}
				run = await retryRead(read, true);
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
				viewFlags.push("--attempt", String(targetAttempt));
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
				run = await retryRead(read);
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
					isJsonObject(job) &&
					isJsonString(job.name) &&
					(!names.length || names.includes(job.name)) &&
					(!onlyFailed ||
						(isJsonString(job.conclusion) && failed(job.conclusion))),
			);
			if (
				names.some(
					(name) =>
						!run.jobs.some((job) => isJsonObject(job) && job.name === name),
				)
			)
				throw new CiRunUsage(
					"Requested task was not found. HoBo Actions task selectors use exact GitHub job names shown by hobo ci inspect.",
				);
			const query = textOption(options, "grep")?.toLowerCase();
			const logs: { task: string; text: string }[] = [];
			const unavailableTasks: string[] = [];
			for (const job of jobs.slice(0, limit)) {
				if (remainingLogBytes === 0) break;
				if (
					!isJsonObject(job) ||
					!isJsonNumber(job.databaseId) ||
					!Number.isSafeInteger(job.databaseId) ||
					job.databaseId < 1 ||
					!isJsonString(job.name)
				)
					throw new Error("Invalid GitHub job response");
				let text: string;
				try {
					text = await gh(
						[...viewFlags, "--job", String(job.databaseId), "--log"],
						undefined,
						true,
					);
				} catch (error) {
					if (error instanceof CiProcessError && error.httpStatus !== 404)
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
				? run.jobs.map((job) => {
						if (!isJsonObject(job) || !isJsonString(job.name))
							throw new Error("Invalid GitHub job response");
						const status =
							isJsonString(job.conclusion) && job.conclusion
								? job.conclusion
								: isJsonString(job.status)
									? job.status
									: "unknown";
						return `${humanText(job.name)}  ${humanText(status)}`;
					})
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
		if (error instanceof CiProcessError && error.httpStatus) {
			const status = error.httpStatus;
			const message =
				status === 401 || status === 403
					? "GitHub denied this operation. Check gh auth status and repository Actions permissions."
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
		if (error instanceof CiProcessError && error.kind === "timeout")
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
				message: `Install ${error.executable === "gh" ? "the GitHub CLI (gh) and authenticate with gh auth login" : "Git"}, then retry this CI command.`,
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
				"GitHub CLI could not complete the CI run operation. Check gh auth status and repository Actions permissions; inspect the run before repeating a rerun because its outcome may be unconfirmed.",
			remediation: [
				"Check gh auth status and repository Actions permissions, then inspect the run before repeating a mutation.",
			],
		};
	}
}
