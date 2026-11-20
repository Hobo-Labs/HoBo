#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	asList,
	asObject,
	asText,
	GATE_JOBS_BY_EVENT,
	type JsonValue,
	parseJson,
	SHADOW_WORKFLOW_BLOB,
} from "./attestation.mts";
import { mergeGroupIdentity } from "./github-merge-group.mts";

export const PR_FABRIC_RUN_LOOKUPS = 30;
export const PR_FABRIC_ENRICHED_RUNS = 5;

export const PR_FABRIC_COVERED_JOBS: readonly string[] =
	GATE_JOBS_BY_EVENT.merge_group;

const NO_RUN_REASON = "no green pull-request run for this head";
const SHA = /^[0-9a-f]{40}$/u;

export type PullRequestRun = Readonly<{
	id?: number;
	event?: string;
	status?: string | null;
	conclusion?: string | null;
	path?: string;
	head_sha?: string;
	head_branch?: string | null;
	repository?: Readonly<{ full_name?: string }> | null;
	head_repository?: Readonly<{ full_name?: string }> | null;
	testedTree?: string | undefined;
	testedHead?: string | undefined;
	testedBase?: string | undefined;
	workflowBlob?: string | undefined;
}>;

export type PullRequestRecord = Readonly<{
	number: number;
	headSha?: string | undefined;
	headRef?: string | undefined;
	headRepository?: string | undefined;
	baseSha?: string | undefined;
	mergeCommitSha?: string | undefined;
}>;

export type PrFabricReuseInput = Readonly<{
	eventName: string;
	repository: string;
	workflowBasename: string;
	headBranch: string | null;
	baseBranch: string;
	baseSha: string;
	headSha: string;
	headTree: string;
	expectedWorkflowBlob: string;
	pull: PullRequestRecord | undefined;
	runs: readonly PullRequestRun[];
}>;

export type PrFabricReuseDecision = Readonly<{
	reuse: boolean;
	reason: string;
	runId?: number;
	covered?: readonly string[];
}>;

function sameRepository(run: PullRequestRun, repository: string): boolean {
	const wanted = repository.toLowerCase();
	const own = run.repository?.full_name?.toLowerCase();
	const head = run.head_repository?.full_name?.toLowerCase();
	return own === wanted && head === wanted;
}

export function decidePrFabricReuse(
	input: PrFabricReuseInput,
): PrFabricReuseDecision {
	if (input.eventName !== "merge_group")
		return { reuse: false, reason: "not a merge-group run" };
	const identity = mergeGroupIdentity({
		branch: input.headBranch ?? "",
		baseBranch: input.baseBranch,
		base: input.baseSha,
		head: input.headSha,
	});
	if (!identity)
		return { reuse: false, reason: "the merge-queue branch could not be read" };
	const headTree = input.headTree.trim().toLowerCase();
	if (!SHA.test(headTree))
		return { reuse: false, reason: "the checked-out tree is unknown" };
	if (input.pull === undefined)
		return {
			reuse: false,
			reason: `pull request ${identity.pr} could not be read`,
		};
	const pullHead = input.pull.headSha?.trim().toLowerCase() ?? "";
	if (!SHA.test(pullHead))
		return { reuse: false, reason: "the pull request's head is unknown" };
	if (
		input.pull.headRepository?.toLowerCase() !== input.repository.toLowerCase()
	)
		return { reuse: false, reason: "the pull request's head is a fork" };
	const base = input.baseSha.trim().toLowerCase();
	let sawHead = false;
	for (const run of input.runs) {
		if (run.event !== "pull_request") continue;
		if (!run.path?.endsWith(`/${input.workflowBasename}`)) continue;
		if (!sameRepository(run, input.repository)) continue;
		if (run.testedHead !== pullHead) continue;
		sawHead = true;
		if (run.status !== "completed" || run.conclusion !== "success") continue;
		if (run.workflowBlob !== input.expectedWorkflowBlob)
			return {
				reuse: false,
				reason: "the pull request ran a different workflow file",
			};
		if (run.testedTree?.trim().toLowerCase() !== headTree)
			return {
				reuse: false,
				reason:
					"the merge-group tree differs from the pull request's tested tree",
			};
		if (run.testedBase?.trim().toLowerCase() !== base)
			return {
				reuse: false,
				reason: "the pull request was tested against another base",
			};
		const decision: PrFabricReuseDecision = {
			reuse: true,
			reason:
				"the pull request's green run tested this exact tree, base and workflow",
			covered: PR_FABRIC_COVERED_JOBS,
		};
		return run.id === undefined ? decision : { ...decision, runId: run.id };
	}
	return {
		reuse: false,
		reason: sawHead
			? "the pull request's run for this head did not succeed"
			: NO_RUN_REASON,
	};
}

export type FetchApi = (
	url: string,
	init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

async function githubGet(
	url: string,
	token: string,
	fetchApi: FetchApi,
): Promise<JsonValue | undefined> {
	try {
		const response = await fetchApi(url, {
			signal: AbortSignal.timeout(15_000),
			headers: token
				? {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${token}`,
						"X-GitHub-Api-Version": "2022-11-28",
					}
				: {
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
		});
		if (!response.ok) return undefined;
		const body: JsonValue = await response.json();
		return body;
	} catch {
		return undefined;
	}
}

export async function fetchPullRequestRecord(options: {
	repository: string;
	token: string;
	pr: number;
	fetch: FetchApi;
}): Promise<PullRequestRecord | undefined> {
	const [owner, repo] = options.repository.split("/");
	if (!owner || !repo || !options.token || !Number.isSafeInteger(options.pr))
		return undefined;
	const answer = await githubGet(
		`https://api.github.com/repos/${owner}/${repo}/pulls/${options.pr}`,
		options.token,
		options.fetch,
	);
	const pull = asObject(answer);
	const headSha = asText(asObject(pull?.head)?.sha);
	if (pull === undefined || headSha === undefined) return undefined;
	return {
		number: options.pr,
		headSha,
		headRef: asText(asObject(pull.head)?.ref),
		headRepository: asText(asObject(asObject(pull.head)?.repo)?.full_name),
		baseSha: asText(asObject(pull.base)?.sha),
		mergeCommitSha: asText(pull.merge_commit_sha),
	};
}

export async function fetchPullRequestFabricRuns(options: {
	repository: string;
	token: string;
	workflowBasename: string;
	branch: string;
	fetch: FetchApi;
}): Promise<readonly PullRequestRun[] | undefined> {
	const [owner, repo] = options.repository.split("/");
	if (!owner || !repo || !options.token || !options.branch) return undefined;
	const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(options.workflowBasename)}/runs?event=pull_request&branch=${encodeURIComponent(options.branch)}&per_page=${PR_FABRIC_RUN_LOOKUPS}`;
	const answer = await githubGet(url, options.token, options.fetch);
	const runs = asObject(answer)?.workflow_runs;
	return Array.isArray(runs) ? runs : undefined;
}

export async function enrichPullRequestRuns(options: {
	repository: string;
	token: string;
	workflowPath: string;
	runs: readonly PullRequestRun[];
	fetch: FetchApi;
}): Promise<readonly PullRequestRun[]> {
	const [owner, repo] = options.repository.split("/");
	if (!owner || !repo) return options.runs;
	const enriched = await Promise.all(
		options.runs.slice(0, PR_FABRIC_ENRICHED_RUNS).map(async (run) => {
			const head = run.head_sha?.trim().toLowerCase() ?? "";
			if (!SHA.test(head)) return run;
			const commit = await githubGet(
				`https://api.github.com/repos/${owner}/${repo}/git/commits/${head}`,
				options.token,
				options.fetch,
			);
			const parents = asList(asObject(commit)?.parents) ?? [];
			const contents = await githubGet(
				`https://api.github.com/repos/${owner}/${repo}/contents/${options.workflowPath}?ref=${head}`,
				options.token,
				options.fetch,
			);
			const parentsReadable = parents.every((parent) =>
				SHA.test(asText(asObject(parent)?.sha) ?? ""),
			);
			return {
				...run,
				testedTree: asText(asObject(asObject(commit)?.tree)?.sha),
				testedBase: parentsReadable
					? asText(asObject(parents[0])?.sha)
					: undefined,
				testedHead:
					parentsReadable && parents.length === 2
						? asText(asObject(parents[1])?.sha)
						: undefined,
				workflowBlob: asText(asObject(contents)?.sha),
			};
		}),
	);
	return [...enriched, ...options.runs.slice(PR_FABRIC_ENRICHED_RUNS)];
}

function checkedOutTree(): string {
	return execFileSync("git", ["show", "-s", "--format=%T", "HEAD"], {
		encoding: "utf8",
	}).trim();
}

function readEventPayload(): JsonValue {
	try {
		return parseJson(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const eventName = process.env.GITHUB_EVENT_NAME ?? "";
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const workflowBasename = process.env.WORKFLOW_BASENAME ?? "hobo-ci.yml";
	const payload = readEventPayload();
	const mergeGroup = asObject(asObject(payload)?.merge_group);
	const baseBranch =
		process.env.BASE_BRANCH ?? asText(mergeGroup?.base_ref) ?? "main";
	const baseSha = asText(mergeGroup?.base_sha) ?? "";
	const headSha = process.env.HEAD_SHA ?? process.env.GITHUB_SHA ?? "";
	const headBranch = process.env.HEAD_BRANCH ?? "";
	const headTree = checkedOutTree();
	const base = {
		eventName,
		repository,
		workflowBasename,
		headBranch,
		baseBranch,
		baseSha,
		headSha,
		headTree,
		expectedWorkflowBlob: SHADOW_WORKFLOW_BLOB,
	};
	const identity =
		eventName === "merge_group"
			? mergeGroupIdentity({
					branch: headBranch,
					baseBranch,
					base: baseSha,
					head: headSha,
				})
			: undefined;
	let decision: PrFabricReuseDecision;
	if (identity === undefined || !SHA.test(headTree)) {
		decision = decidePrFabricReuse({ ...base, pull: undefined, runs: [] });
	} else {
		const token = process.env.GITHUB_TOKEN?.trim() ?? "";
		const fetchApi: FetchApi = globalThis.fetch;
		const pull = await fetchPullRequestRecord({
			repository,
			token,
			pr: identity.pr,
			fetch: fetchApi,
		});
		const fetched =
			pull?.headRef === undefined
				? undefined
				: await fetchPullRequestFabricRuns({
						repository,
						token,
						workflowBasename,
						branch: pull.headRef,
						fetch: fetchApi,
					});
		decision =
			pull === undefined
				? decidePrFabricReuse({ ...base, pull, runs: [] })
				: fetched === undefined
					? { reuse: false, reason: "pull-request runs could not be read" }
					: decidePrFabricReuse({
							...base,
							pull,
							runs: await enrichPullRequestRuns({
								repository,
								token,
								workflowPath: `.github/workflows/${workflowBasename}`,
								runs: fetched,
								fetch: fetchApi,
							}),
						});
	}
	const run = decision.runId === undefined ? "" : ` (run ${decision.runId})`;
	console.log(
		`pr-fabric reuse: ${decision.reuse ? "yes" : "no"}: ${decision.reason}${run}`,
	);
	const output = process.env.GITHUB_OUTPUT?.trim();
	const lines = `pr-fabric-green=${decision.reuse}\npr-fabric-run=${decision.runId ?? ""}\npr-fabric-covered=${JSON.stringify(decision.covered ?? [])}\n`;
	if (output) appendFileSync(output, lines);
	else process.stdout.write(lines);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	void main();
}
