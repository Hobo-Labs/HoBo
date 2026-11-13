#!/usr/bin/env node
/**
 * Decides whether a push to main may reuse the merge queue's result.
 *
 * The merge queue tests the exact tree that lands on main: GitHub fast-forwards
 * main to the commit the `merge_group` run checked. When a successful
 * `merge_group` run of this workflow exists for the pushed tree, the main run
 * skips the full gate and the workspace shards and keeps the checks the merge
 * queue does not run (secret scan, deps layer, finish).
 *
 * Runs in the `route` job on a GitHub-hosted machine: node builtins only, no
 * checkout of the tree under test. It never fails the job: anything short of a
 * verified match is `reuse=false`, and main then runs its full gate as before.
 *
 * Whether reuse is on is committed policy, never a variable (ADR-0181):
 * `runnerRouting.mainGate.reuseMergeQueue` in `.hobo/ci.json`, read with the
 * dependency-free reader from the route job's sparse checkout. A file with no
 * valid `runnerRouting` leaves reuse on, as an unset variable did.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RUNNER_ROUTING_PATH, readRunnerRouting } from "./runner-routing.mts";

/** The committed setting that turns reuse off (`false`). */
// public-contract: set to `false` in .hobo/ci.json to make main re-run its full gate.
export const MERGE_QUEUE_REUSE_SETTING =
	"runnerRouting.mainGate.reuseMergeQueue";
/** Reuse is on unless committed policy turns it off. */
export const DEFAULT_REUSE_MERGE_QUEUE = true;

/** The committed setting from `.hobo/ci.json`'s text; the default when it has none. */
export function reuseMergeQueueSetting(text: string | undefined): boolean {
	return (
		readRunnerRouting(text)?.mainGate.reuseMergeQueue ??
		DEFAULT_REUSE_MERGE_QUEUE
	);
}

/** Merge-group runs read per decision; the matching run is almost always the newest. */
export const MERGE_GROUP_RUN_LOOKUPS = 30;

/** Branch prefix GitHub gives every merge-queue candidate. */
export const MERGE_QUEUE_BRANCH_PREFIX = "gh-readonly-queue/main/";

const SHA = /^[0-9a-f]{40}$/u;
const NO_RUN_REASON = "no merge-queue run for this tree";

export type MergeGroupRun = Readonly<{
	id?: number;
	event?: string;
	status?: string | null;
	conclusion?: string | null;
	path?: string;
	head_sha?: string;
	head_branch?: string | null;
	run_attempt?: number;
	head_commit?: Readonly<{ tree_id?: string }> | null;
	repository?: Readonly<{ full_name?: string }> | null;
	head_repository?: Readonly<{ full_name?: string }> | null;
}>;

export type ReuseInput = Readonly<{
	eventName: string;
	ref: string;
	/** Committed `runnerRouting.mainGate.reuseMergeQueue`; `false` disables reuse. */
	enabled: boolean;
	repository: string;
	workflowBasename: string;
	headSha: string;
	/** Tree of the pushed head commit (`github.event.head_commit.tree_id`). */
	headTree: string;
	runs: readonly MergeGroupRun[];
}>;

export type ReuseDecision = Readonly<{
	reuse: boolean;
	reason: string;
	runId?: number;
}>;

function sameRepository(run: MergeGroupRun, repository: string): boolean {
	const wanted = repository.toLowerCase();
	const own = run.repository?.full_name?.toLowerCase();
	const head = run.head_repository?.full_name?.toLowerCase();
	// A merge-group commit is created by GitHub in this repository; a run whose
	// head lives elsewhere is not one of them.
	return own === wanted && (head === undefined || head === wanted);
}

/**
 * Pure decision. A run counts only when every one of these holds: it is a
 * completed, successful `merge_group` run of this workflow in this repository,
 * on a merge-queue branch for main, and its head is the pushed commit or has
 * the pushed tree.
 */
export function decideMergeQueueReuse(input: ReuseInput): ReuseDecision {
	if (!input.enabled)
		return { reuse: false, reason: `${MERGE_QUEUE_REUSE_SETTING} is false` };
	if (input.eventName !== "push" || input.ref !== "refs/heads/main")
		return { reuse: false, reason: "not a push to main" };
	const headSha = input.headSha.trim().toLowerCase();
	const headTree = input.headTree.trim().toLowerCase();
	if (!SHA.test(headSha))
		return { reuse: false, reason: "pushed commit is not known" };
	// The tree is the claim; the commit is the usual way it is met, since
	// GitHub fast-forwards main to the commit the merge queue checked.
	const treeKnown = SHA.test(headTree);
	let sawTree = false;
	for (const run of input.runs) {
		if (run.event !== "merge_group") continue;
		if (!run.path?.endsWith(`/${input.workflowBasename}`)) continue;
		if (!sameRepository(run, input.repository)) continue;
		if (!run.head_branch?.startsWith(MERGE_QUEUE_BRANCH_PREFIX)) continue;
		const sameCommit = run.head_sha?.trim().toLowerCase() === headSha;
		const sameTree =
			treeKnown && run.head_commit?.tree_id?.trim().toLowerCase() === headTree;
		if (!sameCommit && !sameTree) continue;
		sawTree = true;
		if (run.status !== "completed" || run.conclusion !== "success") continue;
		const decision: ReuseDecision = {
			reuse: true,
			reason: sameCommit
				? "the merge queue passed this commit"
				: "the merge queue passed this tree on another commit",
		};
		return run.id === undefined ? decision : { ...decision, runId: run.id };
	}
	return {
		reuse: false,
		reason: sawTree
			? "the merge-queue run for this tree did not succeed"
			: NO_RUN_REASON,
	};
}

export type FetchRuns = (
	url: string,
	init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

/** Newest merge-group runs of the workflow; `undefined` when the read fails. */
export async function fetchMergeGroupRuns(options: {
	repository: string;
	token: string;
	workflowBasename: string;
	fetch: FetchRuns;
}): Promise<readonly MergeGroupRun[] | undefined> {
	const [owner, repo] = options.repository.split("/");
	if (!owner || !repo || !options.token) return undefined;
	const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(options.workflowBasename)}/runs?event=merge_group&status=success&per_page=${MERGE_GROUP_RUN_LOOKUPS}`;
	try {
		const response = await options.fetch(url, {
			signal: AbortSignal.timeout(15_000),
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${options.token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!response.ok) return undefined;
		// SAFETY: GitHub REST `workflow_runs` rows; every field read is optional and vetted in decideMergeQueueReuse.
		const body = (await response.json()) as {
			workflow_runs?: readonly MergeGroupRun[];
		};
		return Array.isArray(body.workflow_runs) ? body.workflow_runs : undefined;
	} catch {
		return undefined;
	}
}

/** `.hobo/ci.json` from the checkout, or nothing when it is not there. */
function readCommittedConfig(): string | undefined {
	try {
		return readFileSync(
			join(process.env.GITHUB_WORKSPACE ?? process.cwd(), RUNNER_ROUTING_PATH),
			"utf8",
		);
	} catch {
		return undefined;
	}
}

async function main(): Promise<void> {
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const workflowBasename = process.env.WORKFLOW_BASENAME ?? "hobo-ci.yml";
	const base = {
		eventName: process.env.GITHUB_EVENT_NAME ?? "",
		ref: process.env.GITHUB_REF ?? "",
		enabled: reuseMergeQueueSetting(readCommittedConfig()),
		repository,
		workflowBasename,
		headSha: process.env.HEAD_SHA ?? process.env.GITHUB_SHA ?? "",
		headTree: process.env.HEAD_TREE ?? "",
	};
	// Decide the cheap refusals before spending a GitHub read.
	let decision = decideMergeQueueReuse({ ...base, runs: [] });
	if (decision.reason === NO_RUN_REASON) {
		const runs = await fetchMergeGroupRuns({
			repository,
			token: process.env.GITHUB_TOKEN?.trim() ?? "",
			workflowBasename,
			fetch: globalThis.fetch,
		});
		decision =
			runs === undefined
				? { reuse: false, reason: "merge-queue runs could not be read" }
				: decideMergeQueueReuse({ ...base, runs });
	}
	const run = decision.runId === undefined ? "" : ` (run ${decision.runId})`;
	console.log(
		`merge-queue reuse: ${decision.reuse ? "yes" : "no"}: ${decision.reason}${run}`,
	);
	const output = process.env.GITHUB_OUTPUT?.trim();
	const lines = `reuse=${decision.reuse}\nreuse-run=${decision.runId ?? ""}\n`;
	if (output) appendFileSync(output, lines);
	else process.stdout.write(lines);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	void main();
}
