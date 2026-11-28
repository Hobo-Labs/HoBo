#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	RUNNER_ROUTING_PATH,
	type JsonObject,
	type JsonValue,
	asNumber,
	asObject,
	asText,
	parseJson,
	readRunnerRouting,
} from "./runner-routing.mts";

export const PR_FABRIC_REUSE_SETTING = "runnerRouting.mergeGroup.reusePrFabric";
export const DEFAULT_REUSE_PR_FABRIC = false;

export function reusePrFabricSetting(text: string | undefined): boolean {
	return (
		readRunnerRouting(text)?.mergeGroup.reusePrFabric ?? DEFAULT_REUSE_PR_FABRIC
	);
}

export const PR_FABRIC_RUN_LOOKUPS = 30;

const SHA = /^[0-9a-f]{40}$/u;
export const MERGE_QUEUE_ENTRY_REF =
	/^refs\/heads\/gh-readonly-queue\/main\/pr-(\d+)-([0-9a-f]{40})$/u;

export type MergeQueueEntry = Readonly<{ number: number; base: string }>;

export function mergeQueueEntry(ref: string): MergeQueueEntry | undefined {
	const parsed = MERGE_QUEUE_ENTRY_REF.exec(ref.trim().toLowerCase());
	const number = Number(parsed?.[1]);
	return parsed?.[2] !== undefined && Number.isSafeInteger(number) && number > 0
		? { number, base: parsed[2] }
		: undefined;
}

type ShaAnswer = Readonly<{ sha?: string | undefined }>;
type RepositoryAnswer = Readonly<{ full_name?: string | undefined }>;

export type CommitAnswer = Readonly<{
	sha?: string | undefined;
	commit?: Readonly<{ tree?: ShaAnswer | null | undefined }> | null | undefined;
	parents?: readonly ShaAnswer[] | undefined;
}>;

export type PullAnswer = Readonly<{
	number?: number | undefined;
	head?:
		| Readonly<{
				sha?: string | undefined;
				repo?: RepositoryAnswer | null | undefined;
		  }>
		| null
		| undefined;
	base?:
		| Readonly<{ ref?: string | undefined; sha?: string | undefined }>
		| null
		| undefined;
}>;

export type PullRequestRun = Readonly<{
	id?: number | undefined;
	event?: string | undefined;
	status?: string | null | undefined;
	conclusion?: string | null | undefined;
	path?: string | undefined;
	head_sha?: string | undefined;
	repository?: RepositoryAnswer | null | undefined;
	head_repository?: RepositoryAnswer | null | undefined;
	pull_requests?:
		| readonly Readonly<{ number?: number | undefined }>[]
		| undefined;
}>;

export type PrFabricDecision = Readonly<{
	reuse: boolean;
	reason: string;
	runId?: number;
}>;

export const AWAITING_EVIDENCE_REASON =
	"the merge-group head commit could not be read";

export const ROUTE_JOB_NAME = "Route runners";

export type RunJob = Readonly<{
	name?: string | undefined;
	status?: string | null | undefined;
	conclusion?: string | null | undefined;
}>;

export type PrFabricReads = Readonly<{
	commit: (sha: string) => Promise<CommitAnswer | undefined>;
	pull: (number: number) => Promise<PullAnswer | undefined>;
	mergeBase: (prHead: string) => Promise<string | undefined>;
	jobs: (runId: number) => Promise<readonly RunJob[] | undefined>;
	artifacts: (runId: number) => Promise<readonly RunArtifact[] | undefined>;
}>;

export const UNREAD_RUNS_REASON =
	"the workflow's pull-request runs could not be read";

const lower = (text: string | undefined | null): string | undefined =>
	text?.trim().toLowerCase();

function sameRepository(fullName: string | null | undefined, want: string) {
	const own = lower(fullName);
	return own !== undefined && own === want.toLowerCase();
}

function commitTree(answer: CommitAnswer | undefined): string | undefined {
	const tree = lower(answer?.commit?.tree?.sha);
	return tree !== undefined && SHA.test(tree) ? tree : undefined;
}

function isGreenRunFor(
	run: PullRequestRun,
	input: Readonly<{ repository: string; workflowBasename: string }>,
	number: number,
	prHead: string,
): run is PullRequestRun & { id: number } {
	return (
		run.event === "pull_request" &&
		run.path === `.github/workflows/${input.workflowBasename}` &&
		run.status === "completed" &&
		run.conclusion === "success" &&
		sameRepository(run.repository?.full_name, input.repository) &&
		sameRepository(run.head_repository?.full_name, input.repository) &&
		run.pull_requests?.some((pr) => pr.number === number) === true &&
		lower(run.head_sha) === prHead &&
		run.id !== undefined &&
		Number.isSafeInteger(run.id) &&
		run.id > 0
	);
}

export const PR_FABRIC_TESTED_ARTIFACT = "pr-fabric-tested";
const TESTED_ARTIFACT_NAME = new RegExp(
	`^${PR_FABRIC_TESTED_ARTIFACT}-([0-9a-f]{40})-([0-9a-f]{40})$`,
	"u",
);

function routeJobSucceeded(jobs: readonly RunJob[] | undefined): boolean {
	return (
		jobs?.some(
			(job) =>
				job.name?.trim() === ROUTE_JOB_NAME &&
				job.status === "completed" &&
				job.conclusion === "success",
		) === true
	);
}

async function executedRouteEvidence(
	runId: number,
	reads: Pick<PrFabricReads, "jobs" | "artifacts">,
): Promise<boolean | undefined> {
	const jobs = await reads.jobs(runId);
	if (routeJobSucceeded(jobs)) return true;
	const artifacts = await reads.artifacts(runId);
	if (
		artifacts?.some(
			(artifact) =>
				artifact.expired !== true &&
				TESTED_ARTIFACT_NAME.test(artifact.name ?? ""),
		) === true
	)
		return true;
	if (jobs === undefined || artifacts === undefined) return undefined;
	return false;
}

export async function decidePrFabricReuse(
	input: Readonly<{
		eventName: string;
		ref: string;
		enabled: boolean;
		repository: string;
		workflowBasename: string;
		headSha: string;
		baseSha: string;
		runs: readonly PullRequestRun[];
		reads: PrFabricReads;
	}>,
): Promise<PrFabricDecision> {
	const refuse = (reason: string): PrFabricDecision => ({
		reuse: false,
		reason,
	});
	if (!input.enabled) return refuse(`${PR_FABRIC_REUSE_SETTING} is false`);
	if (input.eventName !== "merge_group") return refuse("not a merge group");
	const entry = mergeQueueEntry(input.ref);
	if (!entry) return refuse("the merge-queue branch is not readable");
	if ((lower(input.baseSha) ?? "") !== entry.base)
		return refuse("the branch's base does not match the event");
	const headSha = lower(input.headSha) ?? "";
	if (!SHA.test(headSha))
		return refuse("the merge-group head commit is not known");
	const mergeHead = await input.reads.commit(headSha);
	if (mergeHead === undefined) return refuse(AWAITING_EVIDENCE_REASON);
	const mergeTree = commitTree(mergeHead);
	if (mergeTree === undefined)
		return refuse("the merge-group head commit has no tree");
	if (lower(mergeHead.parents?.[0]?.sha) !== entry.base)
		return refuse("the merge group's first parent is not the entry's base");
	const pull = await input.reads.pull(entry.number);
	if (pull === undefined || pull.number !== entry.number)
		return refuse(`pull request ${entry.number} could not be read`);
	if (pull.base?.ref !== "main" || lower(pull.base.sha) !== entry.base)
		return refuse("the pull request is not based on this entry's base");
	const prHead = lower(pull.head?.sha) ?? "";
	if (!SHA.test(prHead))
		return refuse("the pull request's head commit is not known");
	if (!sameRepository(pull.head?.repo?.full_name, input.repository))
		return refuse("the pull request's head is in another repository");
	let sawRunForThisHead = false;
	let unreadExecution: string | undefined;
	for (const run of input.runs) {
		if (!isGreenRunFor(run, input, entry.number, prHead)) continue;
		const executed = await executedRouteEvidence(run.id, input.reads);
		if (executed !== true) {
			if (executed === undefined)
				unreadExecution ??= `the execution of run ${run.id} could not be read`;
			continue;
		}
		sawRunForThisHead = true;
		const head = await input.reads.commit(prHead);
		if (head === undefined) return refuse(AWAITING_EVIDENCE_REASON);
		const tree = commitTree(head);
		if (tree === undefined)
			return refuse("the pull request's head commit has no tree");
		if (tree !== mergeTree) continue;
		const mergeBase = await input.reads.mergeBase(prHead);
		if (mergeBase === undefined)
			return refuse("the ancestry of the pull request could not be read");
		if (mergeBase !== entry.base) continue;
		return {
			reuse: true,
			reason: `a green PR Fabric run tested this tree at this base (pr ${entry.number}, run ${run.id})`,
			runId: run.id,
		};
	}
	if (unreadExecution !== undefined) return refuse(unreadExecution);
	return refuse(
		sawRunForThisHead
			? "no green PR Fabric run tested this tree with the base contained in its head"
			: "no green PR Fabric run tested this pull request's current head",
	);
}

export function prFabricTestedArtifactName(
	mergeSha: string,
	tree: string,
): string {
	return `${PR_FABRIC_TESTED_ARTIFACT}-${mergeSha}-${tree}`;
}

export type RunArtifact = Readonly<{
	name?: string | undefined;
	expired?: boolean | undefined;
}>;

export type ProvenTreeReads = Readonly<{
	pull: (number: number) => Promise<PullAnswer | undefined>;
	runs: (prHead: string) => Promise<readonly PullRequestRun[] | undefined>;
	artifacts: (runId: number) => Promise<readonly RunArtifact[] | undefined>;
	commit: (sha: string) => Promise<CommitAnswer | undefined>;
	contains: (
		ancestor: string,
		descendant: string,
	) => Promise<boolean | undefined>;
}>;

export type ProvenTreeDecision = Readonly<{
	proven: boolean;
	reason: string;
	base?: string;
	tree?: string;
	runId?: number;
	pr?: number;
}>;

export async function decideProvenTreeDelta(
	input: Readonly<{
		eventName: string;
		ref: string;
		enabled: boolean;
		repository: string;
		workflowBasename: string;
		baseSha: string;
		reads: ProvenTreeReads;
	}>,
): Promise<ProvenTreeDecision> {
	const refuse = (reason: string): ProvenTreeDecision => ({
		proven: false,
		reason,
	});
	if (!input.enabled) return refuse(`${PR_FABRIC_REUSE_SETTING} is false`);
	if (input.eventName !== "merge_group") return refuse("not a merge group");
	const entry = mergeQueueEntry(input.ref);
	if (!entry) return refuse("the merge-queue branch is not readable");
	if ((lower(input.baseSha) ?? "") !== entry.base)
		return refuse("the branch's base does not match the event");
	const pull = await input.reads.pull(entry.number);
	if (pull === undefined || pull.number !== entry.number)
		return refuse(`pull request ${entry.number} could not be read`);
	if (pull.base?.ref !== "main")
		return refuse("the pull request is not based on main");
	const prHead = lower(pull.head?.sha) ?? "";
	if (!SHA.test(prHead))
		return refuse("the pull request's head commit is not known");
	if (!sameRepository(pull.head?.repo?.full_name, input.repository))
		return refuse("the pull request's head is in another repository");
	const runs = await input.reads.runs(prHead);
	if (runs === undefined) return refuse(UNREAD_RUNS_REASON);
	const green = runs
		.filter((run) => isGreenRunFor(run, input, entry.number, prHead))
		.sort((left, right) => (right.id ?? 0) - (left.id ?? 0));
	if (green.length === 0)
		return refuse(
			"no green PR Fabric run tested this pull request's current head",
		);
	for (const run of green) {
		const artifacts = await input.reads.artifacts(run.id);
		if (artifacts === undefined)
			return refuse(`the artifacts of run ${run.id} could not be read`);
		const recorded = artifacts
			.filter((artifact) => artifact.expired !== true)
			.map((artifact) => TESTED_ARTIFACT_NAME.exec(artifact.name ?? ""))
			.find((match) => match !== null);
		if (!recorded?.[1] || !recorded[2]) continue;
		const [, proven, tree] = recorded;
		const commit = await input.reads.commit(proven);
		if (commit === undefined)
			return refuse(`the tested commit ${proven} could not be read`);
		if (commitTree(commit) !== tree)
			return refuse("the tested commit's tree is not the recorded tree");
		const parents = (commit.parents ?? []).map((parent) => lower(parent.sha));
		if (parents.length !== 2 || parents[1] !== prHead)
			return refuse(
				"the tested commit is not a merge of the pull request's head",
			);
		const tested = parents[0] ?? "";
		if (!SHA.test(tested))
			return refuse("the tested commit's base is not known");
		const contained = await input.reads.contains(tested, entry.base);
		if (contained === undefined)
			return refuse("the ancestry of the tested base could not be read");
		if (!contained)
			return refuse(
				"the tested base is not an ancestor of the merge group's base",
			);
		return {
			proven: true,
			reason: `proven-tree delta from ${proven} (pr ${entry.number}, run ${run.id})`,
			base: proven,
			tree,
			runId: run.id,
			pr: entry.number,
		};
	}
	return refuse("no green PR Fabric run recorded the tree it tested");
}

export type FetchJson = (
	url: string,
	init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

async function readGithubJson(
	fetchJson: FetchJson,
	url: string,
	token: string,
): Promise<JsonObject | undefined> {
	const response = await fetchJson(url, {
		signal: AbortSignal.timeout(15_000),
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
	const encoded = JSON.stringify(await response.json());
	return encoded === undefined ? undefined : asObject(parseJson(encoded));
}

function repositoryAnswer(
	value: JsonValue | undefined,
): RepositoryAnswer | undefined {
	const answer = asObject(value);
	return answer ? { full_name: asText(answer.full_name) } : undefined;
}

function commitAnswer(
	answer: JsonObject | undefined,
): CommitAnswer | undefined {
	if (!answer) return undefined;
	const commit = asObject(answer.commit);
	const tree = asObject(commit?.tree);
	const parents = Array.isArray(answer.parents)
		? answer.parents.map((parent: JsonValue) => ({
				sha: asText(asObject(parent)?.sha),
			}))
		: undefined;
	return {
		commit: commit
			? { tree: tree ? { sha: asText(tree.sha) } : undefined }
			: undefined,
		parents,
	};
}

function pullAnswer(answer: JsonObject | undefined): PullAnswer | undefined {
	if (!answer) return undefined;
	const head = asObject(answer.head);
	const base = asObject(answer.base);
	if (!head || !base) return undefined;
	return {
		number: asNumber(answer.number),
		head: {
			sha: asText(head.sha),
			repo: repositoryAnswer(head.repo),
		},
		base: { ref: asText(base.ref), sha: asText(base.sha) },
	};
}

function pullRequestRun(value: JsonValue): PullRequestRun | undefined {
	const answer = asObject(value);
	if (!answer) return undefined;
	const pullRequests = Array.isArray(answer.pull_requests)
		? answer.pull_requests.map((pull: JsonValue) => ({
				number: asNumber(asObject(pull)?.number),
			}))
		: undefined;
	return {
		id: asNumber(answer.id),
		event: asText(answer.event),
		status: asText(answer.status),
		conclusion: asText(answer.conclusion),
		path: asText(answer.path),
		head_sha: asText(answer.head_sha),
		repository: repositoryAnswer(answer.repository),
		head_repository: repositoryAnswer(answer.head_repository),
		pull_requests: pullRequests,
	};
}

export async function fetchPullRequestRuns(options: {
	apiUrl: string;
	repository: string;
	token: string;
	workflowBasename: string;
	fetch: FetchJson;
}): Promise<readonly PullRequestRun[] | undefined> {
	const [owner, repo] = options.repository.split("/");
	if (!owner || !repo || !options.token) return undefined;
	const url = `${options.apiUrl}/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(options.workflowBasename)}/runs?event=pull_request&status=success&per_page=${PR_FABRIC_RUN_LOOKUPS}`;
	try {
		const body = await readGithubJson(options.fetch, url, options.token);
		const rows = body?.workflow_runs;
		if (!Array.isArray(rows)) return undefined;
		const runs: PullRequestRun[] = [];
		for (const row of rows) {
			const run = pullRequestRun(row);
			if (run) runs.push(run);
		}
		return runs;
	} catch {
		return undefined;
	}
}

export function prFabricReads(options: {
	apiUrl: string;
	repository: string;
	token: string;
	entryBase: string;
	fetch: FetchJson;
}): PrFabricReads {
	const [owner, repo] = options.repository.split("/");
	const usable = Boolean(owner && repo && options.token);
	const base = `${options.apiUrl.replace(/\/$/u, "")}/repos/${owner}/${repo}`;
	const read = (path: string) =>
		readGithubJson(options.fetch, `${base}${path}`, options.token);
	const commit = async (sha: string): Promise<CommitAnswer | undefined> => {
		if (!usable || !SHA.test(sha)) return undefined;
		try {
			return commitAnswer(await read(`/commits/${sha}`));
		} catch {
			return undefined;
		}
	};
	const pull = async (number: number): Promise<PullAnswer | undefined> => {
		if (!usable) return undefined;
		try {
			return pullAnswer(await read(`/pulls/${number}`));
		} catch {
			return undefined;
		}
	};
	const mergeBase = async (prHead: string): Promise<string | undefined> => {
		if (!usable || !SHA.test(prHead)) return undefined;
		try {
			const answer = await read(`/compare/${options.entryBase}...${prHead}`);
			const sha = lower(asText(asObject(answer?.merge_base_commit)?.sha));
			return sha !== undefined && SHA.test(sha) ? sha : undefined;
		} catch {
			return undefined;
		}
	};
	const jobs = async (
		runId: number,
	): Promise<readonly RunJob[] | undefined> => {
		if (!usable || !Number.isSafeInteger(runId) || runId <= 0) return undefined;
		try {
			const rows = (
				await read(`/actions/runs/${runId}/jobs?filter=latest&per_page=100`)
			)?.jobs;
			if (!Array.isArray(rows)) return undefined;
			return rows.flatMap((row) => runJob(row) ?? []);
		} catch {
			return undefined;
		}
	};
	const artifacts = async (
		runId: number,
	): Promise<readonly RunArtifact[] | undefined> => {
		if (!usable || !Number.isSafeInteger(runId) || runId <= 0) return undefined;
		try {
			const rows = (await read(`/actions/runs/${runId}/artifacts?per_page=100`))
				?.artifacts;
			if (!Array.isArray(rows)) return undefined;
			return rows.flatMap((row) => runArtifact(row) ?? []);
		} catch {
			return undefined;
		}
	};
	return { commit, pull, mergeBase, jobs, artifacts };
}

function runJob(value: JsonValue): RunJob | undefined {
	const answer = asObject(value);
	if (!answer) return undefined;
	return {
		name: asText(answer.name),
		status: asText(answer.status),
		conclusion: asText(answer.conclusion),
	};
}

function runArtifact(value: JsonValue): RunArtifact | undefined {
	const answer = asObject(value);
	if (!answer) return undefined;
	return {
		name: asText(answer.name),
		expired: answer.expired === true,
	};
}

export function provenTreeReads(options: {
	apiUrl: string;
	repository: string;
	token: string;
	workflowBasename: string;
	fetch: FetchJson;
}): ProvenTreeReads {
	const [owner, repo] = options.repository.split("/");
	const usable = Boolean(owner && repo && options.token);
	const base = `${options.apiUrl.replace(/\/$/u, "")}/repos/${owner}/${repo}`;
	const read = async (path: string) => {
		if (!usable) return undefined;
		try {
			return await readGithubJson(
				options.fetch,
				`${base}${path}`,
				options.token,
			);
		} catch {
			return undefined;
		}
	};
	const pull = async (number: number) =>
		pullAnswer(await read(`/pulls/${number}`));
	const runs = async (
		prHead: string,
	): Promise<readonly PullRequestRun[] | undefined> => {
		if (!SHA.test(prHead)) return undefined;
		const rows = (
			await read(
				`/actions/workflows/${encodeURIComponent(options.workflowBasename)}/runs?event=pull_request&status=success&head_sha=${prHead}&per_page=${PR_FABRIC_RUN_LOOKUPS}`,
			)
		)?.workflow_runs;
		if (!Array.isArray(rows)) return undefined;
		return rows.flatMap((row) => pullRequestRun(row) ?? []);
	};
	const artifacts = async (
		runId: number,
	): Promise<readonly RunArtifact[] | undefined> => {
		const rows = (await read(`/actions/runs/${runId}/artifacts?per_page=100`))
			?.artifacts;
		if (!Array.isArray(rows)) return undefined;
		return rows.flatMap((row) => runArtifact(row) ?? []);
	};
	const commit = async (sha: string) =>
		SHA.test(sha) ? commitAnswer(await read(`/commits/${sha}`)) : undefined;
	const contains = async (
		ancestor: string,
		descendant: string,
	): Promise<boolean | undefined> => {
		if (!SHA.test(ancestor) || !SHA.test(descendant)) return undefined;
		const answer = await read(`/compare/${ancestor}...${descendant}`);
		const sha = lower(asText(asObject(answer?.merge_base_commit)?.sha));
		return sha !== undefined && SHA.test(sha) ? sha === ancestor : undefined;
	};
	return { pull, runs, artifacts, commit, contains };
}

function readCommittedPolicy(): string | undefined {
	try {
		return readFileSync(
			join(import.meta.dirname, "..", "..", RUNNER_ROUTING_PATH),
			"utf8",
		);
	} catch {
		return undefined;
	}
}

export function logDecision(decision: PrFabricDecision): void {
	console.log(
		`pr-fabric reuse: ${decision.reuse ? "yes" : "no"}: ${decision.reason}`,
	);
}

export function writeDecisionOutputs(
	env: NodeJS.ProcessEnv,
	decision: PrFabricDecision,
): void {
	const output = env.GITHUB_OUTPUT?.trim();
	const lines = `reuse=${decision.reuse}\nreuse-run=${decision.runId ?? ""}\n`;
	if (output) appendFileSync(output, lines);
	else process.stdout.write(lines);
}

export function logProvenTree(decision: ProvenTreeDecision): void {
	console.log(
		`proven-tree delta: ${decision.proven ? "yes" : "no"}: ${decision.reason}`,
	);
}

export function writeProvenTreeOutputs(
	env: NodeJS.ProcessEnv,
	decision: ProvenTreeDecision,
): void {
	const output = env.GITHUB_OUTPUT?.trim();
	const lines = [
		`proven-base=${decision.base ?? ""}`,
		`proven-tree=${decision.tree ?? ""}`,
		`proven-run=${decision.runId ?? ""}`,
		`proven-pr=${decision.pr ?? ""}`,
		"",
	].join("\n");
	if (output) appendFileSync(output, lines);
	else process.stdout.write(lines);
}

async function decideReuse(
	withoutEvidence: Parameters<typeof decidePrFabricReuse>[0],
	evidence: Readonly<{ apiUrl: string; token: string; fetch: FetchJson }>,
): Promise<PrFabricDecision> {
	const cheap = await decidePrFabricReuse(withoutEvidence);
	if (cheap.reason !== AWAITING_EVIDENCE_REASON) return cheap;
	const runs = await fetchPullRequestRuns({
		...evidence,
		repository: withoutEvidence.repository,
		workflowBasename: withoutEvidence.workflowBasename,
	});
	return runs === undefined
		? { reuse: false, reason: UNREAD_RUNS_REASON }
		: decidePrFabricReuse({
				...withoutEvidence,
				runs,
				reads: prFabricReads({
					...evidence,
					repository: withoutEvidence.repository,
					entryBase: mergeQueueEntry(withoutEvidence.ref)?.base ?? "",
				}),
			});
}

export async function main(env: NodeJS.ProcessEnv): Promise<PrFabricDecision> {
	const repository = env.GITHUB_REPOSITORY ?? "";
	const workflowBasename = env.WORKFLOW_BASENAME ?? "hobo-ci.yml";
	const eventName = env.GITHUB_EVENT_NAME ?? "";
	const ref = env.GITHUB_REF ?? "";
	const headSha = env.HEAD_SHA ?? env.GITHUB_SHA ?? "";
	const baseSha = env.BASE_SHA ?? env.GITHUB_EVENT_BASE_SHA ?? "";
	const enabled = reusePrFabricSetting(readCommittedPolicy());
	const evidence = {
		apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
		token: env.GITHUB_TOKEN?.trim() ?? "",
		fetch: ((url, init) => globalThis.fetch(url, init)) satisfies FetchJson,
	};
	const decision = await decideReuse(
		{
			eventName,
			ref,
			enabled,
			repository,
			workflowBasename,
			headSha,
			baseSha,
			runs: [],
			reads: {
				commit: async () => undefined,
				pull: async () => undefined,
				mergeBase: async () => undefined,
				jobs: async () => undefined,
				artifacts: async () => undefined,
			},
		},
		evidence,
	);
	logDecision(decision);
	writeDecisionOutputs(env, decision);
	const proven = decision.reuse
		? { proven: false, reason: "the whole tree is reused" }
		: await decideProvenTreeDelta({
				eventName,
				ref,
				enabled,
				repository,
				workflowBasename,
				baseSha,
				reads: provenTreeReads({ ...evidence, repository, workflowBasename }),
			});
	logProvenTree(proven);
	writeProvenTreeOutputs(env, proven);
	return decision;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await main(process.env);
}
