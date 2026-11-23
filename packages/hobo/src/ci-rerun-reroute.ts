import { RELAY_LABEL } from "@hobo/ci";
import { isRelayJobOf } from "@hobo/ci-gh-actions";
import type { CommandResult } from "@hobo/cli";
import { z } from "zod";
import type { CiCommand, CiCommandContext } from "./ci-commands.js";

const USAGE =
	"Usage: hobo ci rerun <run-id> --reroute [--job <relay job name>] [--repo owner/name]";

// public-contract: the GitHub API a token is sent to when GITHUB_API_URL is not set.
export const GITHUB_API_ORIGIN = "https://api.github.com";

export function wantsReroute(args: readonly string[]): boolean {
	return args.includes("--reroute");
}

type RerouteArgs =
	| Readonly<{
			ok: true;
			runId: number;
			job: string | undefined;
			repo: string | undefined;
	  }>
	| Readonly<{ ok: false; problem: string }>;

function refused(problem: string): RerouteArgs {
	return { ok: false, problem };
}

function parseArgs(args: readonly string[]): RerouteArgs {
	const words: string[] = [];
	let job: string | undefined;
	let repo: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] ?? "";
		if (word === "--reroute" || word === "--json") continue;
		if (word === "--job" || word === "--repo") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--"))
				return refused(`${word} takes a value.`);
			if (word === "--job") job = value;
			else repo = value;
			index += 1;
		} else if (word.startsWith("--")) return refused(`Unknown option ${word}.`);
		else words.push(word);
	}
	if (!args.includes("--reroute"))
		return refused(
			"This command reroutes; pass --reroute, or use hobo ci rerun for a plain re-run.",
		);
	if (words.length !== 1) return refused("Name one run id.");
	const runId = Number(words[0]);
	if (!Number.isSafeInteger(runId) || runId <= 0)
		return refused(`"${words[0]}" is not a run id.`);
	return { ok: true, runId, job, repo };
}

function usage(message: string): CommandResult {
	return {
		ok: false,
		status: "usage",
		code: "HOBO_CI_RERUN_USAGE",
		message: `${message}\n${USAGE}`,
	};
}

const RunSchema = z.looseObject({
	status: z.string(),
	conclusion: z.string().nullable(),
	run_attempt: z.number().int().positive(),
});

const JobsSchema = z.looseObject({
	jobs: z.array(
		z.looseObject({
			id: z.number().int().positive(),
			name: z.string(),
			labels: z.array(z.string()),
			conclusion: z.string().nullable(),
		}),
	),
});

// public-contract: GitHub's largest page of a run attempt's jobs.
const JOB_PAGE_SIZE = 100;
// public-contract: the most pages of jobs one reroute reads (5000 jobs).
const JOB_PAGES_MAX = 50;

const MessageSchema = z.looseObject({ message: z.string() });

function apiOrigin(env: NodeJS.ProcessEnv): string | undefined {
	const given = env.GITHUB_API_URL?.trim() || GITHUB_API_ORIGIN;
	try {
		const url = new URL(given);
		return url.protocol === "https:" && !url.username && !url.password
			? given.replace(/\/+$/u, "")
			: undefined;
	} catch {
		return undefined;
	}
}

async function githubMessage(response: Response): Promise<string> {
	try {
		const parsed = MessageSchema.safeParse(await response.json());
		return parsed.success ? parsed.data.message : `HTTP ${response.status}`;
	} catch {
		return `HTTP ${response.status}`;
	}
}

function failed(
	code: string,
	message: string,
	remediation: readonly string[],
): CommandResult {
	return { ok: false, status: "error", code, message, remediation };
}

async function run(context: CiCommandContext): Promise<CommandResult> {
	const parsed = parseArgs(context.args);
	if (!parsed.ok) return usage(parsed.problem);
	const token = context.env.GH_TOKEN || context.env.GITHUB_TOKEN;
	if (!token)
		return failed(
			"HOBO_CI_RERUN_NO_TOKEN",
			"Rerouting a run needs a GitHub token that may re-run its jobs.",
			[
				"Set GH_TOKEN (for example `GH_TOKEN=$(gh auth token)`) or GITHUB_TOKEN with actions: write on the repository.",
			],
		);
	const origin = apiOrigin(context.env);
	if (origin === undefined)
		return usage("GITHUB_API_URL must be an https URL without credentials.");
	const local = await context.localRepository(parsed.repo);
	const repository = local.repository;
	if (repository === undefined)
		return usage("Run from a GitHub repository or pass --repo owner/name.");
	const request = (path: string, method: "GET" | "POST" = "GET") =>
		context.fetch(`${origin}/repos/${repository}${path}`, {
			method,
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"x-github-api-version": "2022-11-28",
			},
		});

	const runResponse = await request(`/actions/runs/${parsed.runId}`);
	if (!runResponse.ok)
		return failed(
			"HOBO_CI_RERUN_NOT_FOUND",
			`GitHub could not read run ${parsed.runId} of ${repository}: ${await githubMessage(runResponse)}.`,
			[
				"Check the run id and that the token may read Actions on the repository.",
			],
		);
	const found = RunSchema.parse(await runResponse.json());
	if (found.status !== "completed")
		return failed(
			"HOBO_CI_RERUN_RUNNING",
			`Run ${parsed.runId} is ${found.status}; only a finished run can be rerouted.`,
			["Wait for the run to finish, or cancel it, then reroute it."],
		);
	const jobs: z.infer<typeof JobsSchema>["jobs"] = [];
	for (let page = 1; page <= JOB_PAGES_MAX; page += 1) {
		const jobsResponse = await request(
			`/actions/runs/${parsed.runId}/attempts/${found.run_attempt}/jobs?per_page=${JOB_PAGE_SIZE}&page=${page}`,
		);
		if (!jobsResponse.ok)
			return failed(
				"HOBO_CI_RERUN_NOT_FOUND",
				`GitHub could not list the jobs of run ${parsed.runId}: ${await githubMessage(jobsResponse)}.`,
				["Check that the token may read Actions on the repository."],
			);
		const read = JobsSchema.parse(await jobsResponse.json()).jobs;
		jobs.push(...read);
		if (read.length < JOB_PAGE_SIZE) break;
	}
	const candidates = jobs.filter(
		(job) =>
			isRelayJobOf(job.name, job.labels) &&
			(parsed.job === undefined || job.name === parsed.job),
	);
	const labelled = candidates.filter((job) => job.labels.includes(RELAY_LABEL));
	const relays = labelled.length > 0 ? labelled : candidates;
	const relay = relays[0];
	if (!relay)
		return failed(
			"HOBO_CI_RERUN_NO_RELAY",
			parsed.job === undefined
				? `Run ${parsed.runId} has no relay job, so there is nothing to route again.`
				: `Run ${parsed.runId} has no relay job named ${parsed.job}.`,
			[
				"Use hobo ci rerun for a plain re-run.",
			],
		);
	if (relays.length > 1)
		return failed(
			"HOBO_CI_RERUN_SEVERAL_RELAYS",
			`Run ${parsed.runId} has ${relays.length} relay jobs: ${relays.map((job) => job.name).join(", ")}.`,
			["Pick one with --job <name>."],
		);
	const rerun = await request(`/actions/jobs/${relay.id}/rerun`, "POST");
	if (rerun.status !== 201)
		return failed(
			"HOBO_CI_RERUN_REFUSED",
			`GitHub did not re-run relay job ${relay.name}: ${await githubMessage(rerun)}.`,
			[
				"Check that the token has actions: write, then inspect the run before trying again; GitHub may have started it.",
			],
		);
	const attempt = found.run_attempt + 1;
	return {
		message: `Rerouting run ${parsed.runId}: relay job ${relay.name} runs again as attempt ${attempt}, and the jobs that need it follow its new answer.`,
		data: {
			repository,
			runId: parsed.runId,
			attempt,
			relayJob: { id: relay.id, name: relay.name },
		},
	};
}

export const CI_RERUN_REROUTE_COMMAND: CiCommand = {
	name: "rerun",
	summary:
		"Run a finished run's relay job again so it routes afresh; the jobs that need it follow",
	run,
};
