/**
 * GitHub's REST API over the simulator's state: the routes HoBo's relay,
 * route job and commands call, answered with the status codes GitHub's REST
 * reference gives (docs.github.com/en/rest, read 2026-11-17).
 *
 * Runs: list, get, get an attempt, jobs (latest or all), an attempt's jobs,
 * re-run, re-run failed jobs, cancel. Jobs: get, logs (a 302 to a download
 * URL, as GitHub answers), check-run annotations. Runners for a repository or
 * an organization: list (by name), get, delete, `generate-jitconfig`, and
 * their labels (list, add, set, remove all custom, remove one). Repository,
 * installation, contents, the git ref and commit reads and the git data
 * writes the routing slip uses, and enhanced-billing usage for a user or an
 * organization.
 */
import { z } from "zod";
import { encodeSimulatedJitConfig } from "./jit-config.js";
import { jobJson, repositoryJson, runJson, runnerJson } from "./payloads.js";
import type { RecordedRequest, RunnerRecord, RunRecord } from "./records.js";
import type { SimulatorState } from "./state.js";

/** Where the simulator serves job logs once `/logs` redirects. */
export const LOG_DOWNLOAD_PATH = "/_downloads/job-logs";

export type RestContext = Readonly<{
	state: SimulatorState;
	baseUrl: string;
	/** The runner service's URL, ending in `/`. */
	runnerServiceUrl: string;
}>;

type Routed = Readonly<{ response: Response; area: RecordedRequest["area"] }>;

const notFound = () =>
	Response.json(
		{
			message: "Not Found",
			documentation_url: "https://docs.github.com/rest",
		},
		{ status: 404 },
	);
const failed = (status: number, message: string) =>
	Response.json({ message }, { status });
const empty = (status: number) => new Response(null, { status });

const JitBody = z.object({
	name: z.string().min(1),
	runner_group_id: z.number().int().positive(),
	labels: z.array(z.string().min(1)).min(1).max(100),
	work_folder: z.string().optional(),
});
const LabelsBody = z.object({ labels: z.array(z.string().min(1)).max(100) });
const TreeBody = z.object({
	tree: z
		.array(
			z.object({
				path: z.string(),
				mode: z.string(),
				type: z.string(),
				content: z.string().optional(),
			}),
		)
		.min(1),
});
const CommitBody = z.object({
	message: z.string(),
	tree: z.string(),
	parents: z.array(z.string()).default([]),
});
const RefBody = z.object({
	ref: z.string().startsWith("refs/"),
	sha: z.string(),
});
const MoveRefBody = z.object({
	sha: z.string(),
	force: z.boolean().optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: string): T | undefined {
	try {
		const parsed = schema.safeParse(JSON.parse(body));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

function labelsJson(runner: RunnerRecord) {
	return {
		total_count: runner.labels.length,
		labels: runner.labels.map((label) => ({ ...label })),
	};
}

/** Answer one REST request; undefined when no route matches. */
export function routeRest(
	context: RestContext,
	method: string,
	url: URL,
	body: string,
): Routed {
	const path = url.pathname;
	const query = url.searchParams;
	const { state } = context;
	const rest = (response: Response): Routed => ({ response, area: "rest" });

	const logs = new RegExp(`^${LOG_DOWNLOAD_PATH}/(\\d+)$`, "u").exec(path);
	if (logs && method === "GET") {
		const job = state.jobs.get(Number(logs[1]));
		return {
			response: job
				? new Response(job.log, { headers: { "content-type": "text/plain" } })
				: notFound(),
			area: "logs",
		};
	}

	const billing =
		/^\/(users|organizations)\/([^/]+)\/settings\/billing\/usage$/u.exec(path);
	if (billing && method === "GET") {
		const [, kind, account = ""] = billing;
		const year = query.get("year");
		const month = query.get("month");
		const day = query.get("day");
		const items = (state.billing.get(`${kind}:${account}`) ?? []).filter(
			(item) => {
				const date = new Date(item.date);
				return (
					(year === null || date.getUTCFullYear() === Number(year)) &&
					(month === null || date.getUTCMonth() + 1 === Number(month)) &&
					(day === null || date.getUTCDate() === Number(day))
				);
			},
		);
		return {
			response: Response.json({
				usageItems: items.map((item) =>
					kind === "organizations"
						? { ...item, organizationName: account }
						: { ...item },
				),
			}),
			area: "billing",
		};
	}

	const runners =
		/^\/(?:repos\/([^/]+\/[^/]+)|orgs\/([^/]+))\/actions\/runners(?:\/(.*))?$/u.exec(
			path,
		);
	if (runners)
		return rest(
			routeRunners(
				context,
				method,
				runners[1],
				runners[2],
				runners[3],
				query,
				body,
			),
		);

	const repo = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/u.exec(path);
	if (!repo) return { response: notFound(), area: "unknown" };
	const fullName = repo[1] ?? "";
	const rest_ = repo[2] ?? "";
	const repository = state.repositories.get(fullName);
	if (!repository) return rest(notFound());

	if (rest_ === "" && method === "GET")
		return rest(Response.json(repositoryJson(repository)));
	if (rest_ === "/installation" && method === "GET")
		return rest(
			Response.json({
				id: state.installationId,
				account: { login: repository.ownerLogin },
			}),
		);

	const contents = /^\/contents\/(.+)$/u.exec(rest_);
	if (contents && method === "GET") {
		const filePath = decodeURIComponent(contents[1] ?? "");
		const text = state.readFile(
			fullName,
			filePath,
			query.get("ref") ?? undefined,
		);
		if (text === undefined) return rest(notFound());
		return rest(
			Response.json({
				type: "file",
				encoding: "base64",
				name: filePath.replace(/^.*\//u, ""),
				path: filePath,
				size: Buffer.byteLength(text),
				content: Buffer.from(text, "utf8").toString("base64"),
			}),
		);
	}

	const git = /^\/git\/(.+)$/u.exec(rest_);
	if (git) return rest(routeGit(state, fullName, method, git[1] ?? "", body));

	if (rest_ === "/actions/runs" && method === "GET") {
		const status = query.get("status");
		const event = query.get("event");
		const perPage = Math.min(Number(query.get("per_page") ?? 30), 100);
		const page = Math.max(Number(query.get("page") ?? 1), 1);
		const all = [...state.runs.values()]
			.filter((run) => run.repository === fullName)
			.filter((run) => event === null || run.event === event)
			.map((run) => ({
				run,
				state: state.attemptState(run, run.latestAttempt),
			}))
			.filter(
				({ state: shown }) =>
					status === null ||
					shown.status === status ||
					shown.conclusion === status,
			)
			.sort((left, right) => right.run.id - left.run.id);
		return rest(
			Response.json({
				total_count: all.length,
				workflow_runs: all
					.slice((page - 1) * perPage, page * perPage)
					.map(({ run, state: shown }) =>
						runJson(run, run.latestAttempt, shown, repository),
					),
			}),
		);
	}

	const runPath =
		/^\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?(\/jobs|\/rerun|\/rerun-failed-jobs|\/cancel)?$/u.exec(
			rest_,
		);
	if (runPath) {
		const run = state.run(Number(runPath[1]));
		if (!run || run.repository !== fullName) return rest(notFound());
		const attempt = runPath[2] === undefined ? undefined : Number(runPath[2]);
		if (attempt !== undefined && !run.attempts.has(attempt))
			return rest(notFound());
		return rest(routeRun(state, run, attempt, runPath[3] ?? "", method, query));
	}

	const jobPath = /^\/actions\/jobs\/(\d+)(\/logs)?$/u.exec(rest_);
	if (jobPath && method === "GET") {
		const job = state.jobs.get(Number(jobPath[1]));
		const run = job ? state.run(job.runId) : undefined;
		if (!job || !run || job.repository !== fullName || job.blocked)
			return rest(notFound());
		if (jobPath[2])
			return rest(
				new Response(null, {
					status: 302,
					headers: {
						location: `${context.baseUrl}${LOG_DOWNLOAD_PATH}/${job.id}`,
					},
				}),
			);
		return rest(Response.json(jobJson(job, run)));
	}

	const annotations = /^\/check-runs\/(\d+)\/annotations$/u.exec(rest_);
	if (annotations && method === "GET") {
		const job = state.jobs.get(Number(annotations[1]));
		if (!job || job.repository !== fullName) return rest(notFound());
		return rest(
			Response.json(
				job.annotations.map((annotation) => ({
					path: ".github",
					start_line: 1,
					end_line: 1,
					annotation_level: annotation.level,
					title: "",
					message: annotation.message,
					raw_details: "",
				})),
			),
		);
	}

	return rest(notFound());
}

function routeRun(
	state: SimulatorState,
	run: RunRecord,
	attempt: number | undefined,
	action: string,
	method: string,
	query: URLSearchParams,
): Response {
	const repository = state.repo(run);
	if (action === "" && method === "GET") {
		const shown = attempt ?? run.latestAttempt;
		return Response.json(
			runJson(run, shown, state.attemptState(run, shown), repository),
		);
	}
	if (action === "/jobs" && method === "GET") {
		const jobs =
			attempt === undefined && query.get("filter") === "all"
				? [...run.attempts.keys()].flatMap((number) =>
						state
							.attemptJobs(run, number)
							.filter((job) => job.runAttempt === number),
					)
				: state.attemptJobs(run, attempt ?? run.latestAttempt);
		return Response.json({
			total_count: jobs.length,
			jobs: jobs.map((job) => jobJson(job, run)),
		});
	}
	if (attempt !== undefined || method !== "POST") return notFound();
	if (action === "/cancel") {
		if (state.attemptState(run, run.latestAttempt).status === "completed")
			return failed(409, "Cannot cancel a workflow run that is completed.");
		state.cancelRun(run);
		return Response.json({}, { status: 202 });
	}
	if (action === "/rerun" || action === "/rerun-failed-jobs") {
		const outcome = state.rerun(run, action === "/rerun-failed-jobs");
		if (outcome === "running")
			return failed(403, "This workflow is already running");
		if (outcome === "nothing-failed")
			return failed(403, "This workflow run has no failed jobs to re-run");
		return Response.json({}, { status: 201 });
	}
	return notFound();
}

function routeRunners(
	context: RestContext,
	method: string,
	repository: string | undefined,
	org: string | undefined,
	rest: string | undefined,
	query: URLSearchParams,
	body: string,
): Response {
	const { state } = context;
	if (repository !== undefined && !state.repositories.has(repository))
		return notFound();
	const scoped = [...state.runners.values()].filter((runner) =>
		repository !== undefined
			? runner.repository === repository
			: runner.org === org,
	);
	if (rest === undefined || rest === "") {
		if (method !== "GET") return notFound();
		const name = query.get("name");
		const listed = scoped.filter(
			(runner) => name === null || runner.name === name,
		);
		return Response.json({
			total_count: listed.length,
			runners: listed.map(runnerJson),
		});
	}
	if (rest === "generate-jitconfig") {
		if (method !== "POST") return notFound();
		const parsed = parseBody(JitBody, body);
		if (!parsed) return failed(422, "Validation Failed");
		if (state.runnerByName(parsed.name))
			return failed(
				409,
				"Already exists - A runner with the same name already exists.",
			);
		const runner = state.registerRunner({
			name: parsed.name,
			labels: parsed.labels,
			ephemeral: true,
			online: false,
			repository,
			org,
		});
		return Response.json(
			{
				runner: runnerJson(runner),
				encoded_jit_config: encodeSimulatedJitConfig({
					agentId: runner.id,
					agentName: runner.name,
					gitHubUrl: `https://github.invalid/${repository ?? org ?? ""}`,
					serverUrl: context.runnerServiceUrl,
					workFolder: parsed.work_folder ?? "_work",
				}),
			},
			{ status: 201 },
		);
	}
	const one = /^(\d+)(?:\/labels(?:\/(.+))?)?$/u.exec(rest);
	const runner = one
		? scoped.find((found) => found.id === Number(one[1]))
		: undefined;
	if (!one || !runner) return notFound();
	const labelsPath = rest.includes("/labels");
	if (!labelsPath) {
		if (method === "GET") return Response.json(runnerJson(runner));
		if (method === "DELETE") {
			if (runner.busy)
				return failed(422, "Bad request - Runner is still running a job");
			state.removeRunner(runner);
			return empty(204);
		}
		return notFound();
	}
	const named = one[2] === undefined ? undefined : decodeURIComponent(one[2]);
	if (named !== undefined) {
		if (method !== "DELETE") return notFound();
		const index = runner.labels.findIndex(
			(label) => label.type === "custom" && label.name === named,
		);
		if (index < 0) return notFound();
		runner.labels.splice(index, 1);
		return Response.json(labelsJson(runner));
	}
	if (method === "GET") return Response.json(labelsJson(runner));
	if (method === "DELETE") {
		runner.labels = runner.labels.filter((label) => label.type === "read-only");
		return Response.json(labelsJson(runner));
	}
	if (method === "POST" || method === "PUT") {
		const parsed = parseBody(LabelsBody, body);
		if (!parsed || (method === "POST" && parsed.labels.length === 0))
			return failed(422, "Validation Failed");
		if (method === "PUT")
			runner.labels = runner.labels.filter(
				(label) => label.type === "read-only",
			);
		state.addLabels(runner, parsed.labels);
		return Response.json(labelsJson(runner));
	}
	return notFound();
}

function routeGit(
	state: SimulatorState,
	repository: string,
	method: string,
	rest: string,
	body: string,
): Response {
	const refs = state.refsOf(repository);
	const refJson = (ref: string, sha: string) => ({
		ref,
		object: { sha, type: "commit" },
	});
	const commitJson = (sha: string) => {
		const commit = state.commits.get(sha);
		return commit
			? {
					sha,
					message: commit.message,
					tree: { sha: commit.tree },
					parents: commit.parents.map((parent) => ({ sha: parent })),
				}
			: undefined;
	};
	if (method === "GET" && rest.startsWith("ref/")) {
		const ref = `refs/${rest.slice("ref/".length)}`;
		const sha = refs.get(ref);
		return sha ? Response.json(refJson(ref, sha)) : notFound();
	}
	if (method === "GET" && rest.startsWith("commits/")) {
		const found = commitJson(rest.slice("commits/".length));
		return found ? Response.json(found) : notFound();
	}
	if (method === "POST" && rest === "trees") {
		const parsed = parseBody(TreeBody, body);
		if (!parsed) return failed(422, "Invalid tree info");
		const sha = state.createTree(JSON.stringify(parsed.tree));
		return Response.json({ sha, tree: parsed.tree }, { status: 201 });
	}
	if (method === "POST" && rest === "commits") {
		const parsed = parseBody(CommitBody, body);
		if (!parsed || !state.trees.has(parsed.tree))
			return failed(422, "Tree SHA does not exist");
		const sha = state.createCommit(parsed.message, parsed.tree, parsed.parents);
		return Response.json(commitJson(sha), { status: 201 });
	}
	if (method === "POST" && rest === "refs") {
		const parsed = parseBody(RefBody, body);
		if (!parsed || !state.commits.has(parsed.sha))
			return failed(422, "Object does not exist");
		if (refs.has(parsed.ref)) return failed(422, "Reference already exists");
		refs.set(parsed.ref, parsed.sha);
		return Response.json(refJson(parsed.ref, parsed.sha), { status: 201 });
	}
	if (method === "PATCH" && rest.startsWith("refs/")) {
		const ref = `refs/${rest.slice("refs/".length)}`;
		const parsed = parseBody(MoveRefBody, body);
		if (!parsed || !state.commits.has(parsed.sha))
			return failed(422, "Object does not exist");
		if (!refs.has(ref)) return failed(422, "Reference does not exist");
		refs.set(ref, parsed.sha);
		return Response.json(refJson(ref, parsed.sha));
	}
	return notFound();
}
