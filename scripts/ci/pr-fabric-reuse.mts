#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	asNumber,
	asObject,
	asText,
	type JsonValue,
	RUNNER_ROUTING_PATH,
	readRunnerRouting,
} from "./runner-routing.mts";

// public-contract: set to `false` in .hobo/ci.json to make merge groups re-run their gate jobs.
export const PR_FABRIC_REUSE_SETTING = "runnerRouting.mergeGroup.reusePrFabric";
export const DEFAULT_REUSE_PR_FABRIC = true;

export function reusePrFabricSetting(text: string | undefined): boolean {
	return (
		readRunnerRouting(text)?.mergeGroup.reusePrFabric ?? DEFAULT_REUSE_PR_FABRIC
	);
}

export const PR_FABRIC_RUN_LOOKUPS = 10;
export const MERGE_QUEUE_ENTRY_PATTERN =
	/^gh-readonly-queue\/main\/pr-(\d+)-([0-9a-f]{40})$/u;

const SHA = /^[0-9a-f]{40}$/u;
const NO_EVIDENCE_REASON = "no green PR Fabric run verified for this tree";

export function parseMergeQueueEntry(
	headBranch: string | undefined | null,
): Readonly<{ pr: number; base: string }> | undefined {
	const match = MERGE_QUEUE_ENTRY_PATTERN.exec(headBranch ?? "");
	if (!match) return undefined;
	const pr = Number(match[1]);
	return Number.isSafeInteger(pr) && pr > 0
		? { pr, base: match[2] ?? "" }
		: undefined;
}

export type PrFabricDecision = Readonly<{
	reuse: boolean;
	reason: string;
	pr?: number;
	runId?: number;
}>;

export type PrFabricReuseInput = Readonly<{
	eventName: string;
	headBranch: string | undefined;
	enabled: boolean;
	eventBase?: string | undefined;
	mergeTree?: string | undefined;
	prHeadTree?: string | undefined;
	baseAncestor?: boolean | undefined;
	runId?: number | undefined;
}>;

export function decidePrFabricReuse(
	input: PrFabricReuseInput,
): PrFabricDecision {
	if (!input.enabled)
		return { reuse: false, reason: `${PR_FABRIC_REUSE_SETTING} is false` };
	if (input.eventName !== "merge_group")
		return { reuse: false, reason: "not a merge group" };
	const entry = parseMergeQueueEntry(input.headBranch);
	if (!entry)
		return {
			reuse: false,
			reason: "the merge-queue branch does not name a PR and a base tip",
		};
	const base = { pr: entry.pr, base: entry.base };
	const eventBase = input.eventBase?.trim().toLowerCase();
	if (eventBase !== undefined && eventBase !== base.base)
		return {
			reuse: false,
			pr: base.pr,
			reason: "the branch's base tip is not the event's merge_group.base_sha",
		};
	const mergeTree = input.mergeTree?.trim().toLowerCase();
	const prHeadTree = input.prHeadTree?.trim().toLowerCase();
	if (!mergeTree || !SHA.test(mergeTree))
		return { reuse: false, pr: base.pr, reason: NO_EVIDENCE_REASON };
	if (!prHeadTree || !SHA.test(prHeadTree))
		return { reuse: false, pr: base.pr, reason: NO_EVIDENCE_REASON };
	if (prHeadTree !== mergeTree)
		return {
			reuse: false,
			pr: base.pr,
			reason: "the green PR run tested another tree",
		};
	if (input.baseAncestor !== true)
		return {
			reuse: false,
			pr: base.pr,
			reason: "the merge-group base tip is not contained in the PR head",
		};
	const decision: PrFabricDecision = {
		reuse: true,
		pr: base.pr,
		reason: "a green PR Fabric run tested this tree at this base",
	};
	return input.runId === undefined
		? decision
		: { ...decision, runId: input.runId };
}

export type FetchJson = (
	url: string,
	init: RequestInit,
) => Promise<
	Pick<Response, "ok" | "status"> & Readonly<{ json: () => Promise<JsonValue> }>
>;

export type PrFabricEvidence = Readonly<{
	mergeTree: string;
	prHeadTree: string;
	baseAncestor: boolean;
	runId?: number;
}>;

function parsedSha(value: JsonValue | undefined): string | undefined {
	const sha = asText(value)?.trim().toLowerCase();
	return sha !== undefined && SHA.test(sha) ? sha : undefined;
}

function commitTree(value: JsonValue | undefined): string | undefined {
	return parsedSha(asObject(asObject(value)?.tree)?.sha);
}

function firstParent(value: JsonValue | undefined): string | undefined {
	const parents = asObject(value)?.parents;
	return Array.isArray(parents)
		? parsedSha(asObject(parents[0])?.sha)
		: undefined;
}

export async function fetchPrFabricEvidence(
	options: Readonly<{
		fetch: FetchJson;
		repository: string;
		workflowBasename: string;
		token: string;
		pr: number;
		base: string;
		mergeHeadSha: string;
	}>,
): Promise<PrFabricEvidence | undefined> {
	const [owner, repo] = options.repository.split("/");
	if (!owner || !repo || !options.token) return undefined;
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${options.token}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const read = async (path: string): Promise<JsonValue | undefined> => {
		try {
			const response = await options.fetch(`${base}${path}`, {
				signal: AbortSignal.timeout(15_000),
				headers,
			});
			return response.ok ? await response.json() : undefined;
		} catch {
			return undefined;
		}
	};
	const mergeHead = await read(`/git/commits/${options.mergeHeadSha}`);
	const mergeTree = commitTree(mergeHead);
	if (!mergeTree || firstParent(mergeHead) !== options.base) return undefined;
	const pull = asObject(await read(`/pulls/${options.pr}`));
	const headRef = asText(asObject(pull?.head)?.ref);
	if (!headRef) return undefined;
	const runsAnswer = asObject(
		await read(
			`/actions/workflows/${encodeURIComponent(options.workflowBasename)}/runs?event=pull_request&status=success&branch=${encodeURIComponent(headRef)}&per_page=${PR_FABRIC_RUN_LOOKUPS}`,
		),
	);
	const runs = runsAnswer?.workflow_runs;
	if (!Array.isArray(runs)) return undefined;
	const wanted = options.repository.toLowerCase();
	const workflowPath = `.github/workflows/${options.workflowBasename}`;
	for (const value of runs) {
		const run = asObject(value);
		if (!run || asText(run.event) !== "pull_request") continue;
		if (asText(run.path) !== workflowPath) continue;
		if (asText(asObject(run.repository)?.full_name)?.toLowerCase() !== wanted)
			continue;
		const headRepository = asText(
			asObject(run.head_repository)?.full_name,
		)?.toLowerCase();
		if (headRepository !== wanted) continue;
		if (
			asText(run.status) !== "completed" ||
			asText(run.conclusion) !== "success"
		)
			continue;
		const prHeadSha = parsedSha(run.head_sha);
		if (!prHeadSha) continue;
		const prHeadTree = commitTree(await read(`/git/commits/${prHeadSha}`));
		if (!prHeadTree) continue;
		const compare = asObject(
			await read(`/compare/${options.base}...${prHeadSha}`),
		);
		const mergeBase = parsedSha(asObject(compare?.merge_base_commit)?.sha);
		const baseAncestor = mergeBase === options.base;
		const runId = asNumber(run.id);
		const evidence = { mergeTree, prHeadTree, baseAncestor };
		return runId === undefined ? evidence : { ...evidence, runId };
	}
	return undefined;
}

function readCommittedConfig(): string | undefined {
	try {
		return readFileSync(
			join(import.meta.dirname, "..", "..", RUNNER_ROUTING_PATH),
			"utf8",
		);
	} catch {
		return undefined;
	}
}

async function main(): Promise<void> {
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const workflowBasename = process.env.WORKFLOW_BASENAME ?? "hobo-ci.yml";
	const ref = process.env.GITHUB_REF ?? "";
	const headBranch =
		process.env.HEAD_BRANCH?.trim() ||
		(ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "");
	const headSha = process.env.HEAD_SHA ?? process.env.GITHUB_SHA ?? "";
	const base = {
		eventName: process.env.GITHUB_EVENT_NAME ?? "",
		headBranch,
		enabled: reusePrFabricSetting(readCommittedConfig()),
		eventBase: process.env.MERGE_GROUP_BASE_SHA,
	};
	let decision = decidePrFabricReuse(base);
	const entry = parseMergeQueueEntry(headBranch);
	if (decision.reason === NO_EVIDENCE_REASON && entry) {
		const evidence = await fetchPrFabricEvidence({
			fetch: globalThis.fetch,
			repository,
			workflowBasename,
			token: process.env.GITHUB_TOKEN?.trim() ?? "",
			pr: entry.pr,
			base: entry.base,
			mergeHeadSha: headSha,
		});
		decision = evidence
			? decidePrFabricReuse({
					...base,
					mergeTree: evidence.mergeTree,
					prHeadTree: evidence.prHeadTree,
					baseAncestor: evidence.baseAncestor,
					runId: evidence.runId,
				})
			: {
					reuse: false,
					pr: entry.pr,
					reason: "the green PR Fabric evidence could not be read",
				};
	}
	const where: string[] = [];
	if (decision.pr !== undefined) where.push(`pr ${decision.pr}`);
	if (decision.runId !== undefined) where.push(`run ${decision.runId}`);
	const at = where.length === 0 ? "" : ` (${where.join(", ")})`;
	console.log(
		`pr-fabric reuse: ${decision.reuse ? "yes" : "no"}: ${decision.reason}${at}`,
	);
	const output = process.env.GITHUB_OUTPUT?.trim();
	const lines = [
		`reuse=${decision.reuse}`,
		`pr=${decision.pr ?? ""}`,
		`run=${decision.runId ?? ""}`,
	].join("\n");
	if (output) appendFileSync(output, `${lines}\n`);
	else process.stdout.write(`${lines}\n`);
}

void (async () => {
	if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
		await main();
})();
