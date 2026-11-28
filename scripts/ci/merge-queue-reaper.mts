#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export type QueueRun = Readonly<{
	id: number;
	branch: string;
	createdAt: string;
	workflow: string;
}>;

export const QUEUE_BRANCH_PREFIX = "gh-readonly-queue/";
export const MIN_AGE_MS = 120_000;
const PENDING_STATUSES = ["queued", "in_progress", "waiting", "pending"];

type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| JsonObject;
interface JsonObject {
	readonly [key: string]: JsonValue;
}

const tagOf = Object.prototype.toString;
function isObject(value: JsonValue | undefined): value is JsonObject {
	return tagOf.call(value) === "[object Object]";
}
function isText(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}
function isNumber(value: JsonValue | undefined): value is number {
	return tagOf.call(value) === "[object Number]";
}

export function parseRunsPage(page: JsonValue | undefined): QueueRun[] {
	if (!isObject(page) || !Array.isArray(page.workflow_runs)) return [];
	const runs: QueueRun[] = [];
	for (const run of page.workflow_runs) {
		if (
			!isObject(run) ||
			!isNumber(run.id) ||
			run.event !== "merge_group" ||
			!isText(run.head_branch) ||
			!isText(run.created_at)
		)
			continue;
		runs.push({
			id: run.id,
			branch: run.head_branch,
			createdAt: run.created_at,
			workflow: isText(run.name) ? run.name : "",
		});
	}
	return runs;
}

export function parseQueueRefs(page: JsonValue | undefined): Set<string> {
	const refs = new Set<string>();
	if (!Array.isArray(page)) return refs;
	for (const entry of page) {
		if (!isObject(entry) || !isText(entry.ref)) continue;
		const branch = entry.ref.replace(/^refs\/heads\//u, "");
		if (branch.startsWith(QUEUE_BRANCH_PREFIX)) refs.add(branch);
	}
	return refs;
}

export function orphanedRuns(
	runs: readonly QueueRun[],
	liveBranches: ReadonlySet<string>,
	nowMs: number,
): QueueRun[] {
	return runs.filter((run) => {
		const created = Date.parse(run.createdAt);
		return (
			run.branch.startsWith(QUEUE_BRANCH_PREFIX) &&
			!liveBranches.has(run.branch) &&
			Number.isFinite(created) &&
			nowMs - created >= MIN_AGE_MS
		);
	});
}

export function shouldDryRun(value: string | undefined): boolean {
	return value !== "false";
}

type Fetch = typeof fetch;

async function getJson(
	fetcher: Fetch,
	url: string,
	token: string,
): Promise<JsonValue | undefined> {
	const response = await fetcher(url, {
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	const parsed: JsonValue = JSON.parse(await response.text());
	return parsed;
}

export async function main(
	env: NodeJS.ProcessEnv = process.env,
	fetcher: Fetch = fetch,
	nowMs: number = Date.now(),
	log: (line: string) => void = (line) => console.log(line),
): Promise<number> {
	const token = env.GITHUB_TOKEN ?? "";
	const repository = env.GITHUB_REPOSITORY ?? "";
	const api = (env.GITHUB_API_URL ?? "https://api.github.com").replace(
		/\/$/u,
		"",
	);
	if (!token || !/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
		log("merge-queue-reaper: GITHUB_TOKEN and GITHUB_REPOSITORY are required");
		return 2;
	}
	const dryRun = shouldDryRun(env.MERGE_QUEUE_REAPER_DRY_RUN);
	const runs: QueueRun[] = [];
	for (const status of PENDING_STATUSES) {
		for (let page = 1; page <= 10; page += 1) {
			const found = parseRunsPage(
				await getJson(
					fetcher,
					`${api}/repos/${repository}/actions/runs?event=merge_group&status=${status}&per_page=100&page=${page}`,
					token,
				),
			);
			runs.push(...found);
			if (found.length < 100) break;
		}
	}
	const live = parseQueueRefs(
		await getJson(
			fetcher,
			`${api}/repos/${repository}/git/matching-refs/heads/gh-readonly-queue`,
			token,
		),
	);
	const unique = [...new Map(runs.map((run) => [run.id, run])).values()];
	const orphans = orphanedRuns(unique, live, nowMs);
	log(
		`merge-queue-reaper: ${unique.length} pending merge-group run(s), ${live.size} live queue branch(es), ${orphans.length} orphaned${dryRun ? " (dry run)" : ""}`,
	);
	let failed = 0;
	for (const run of orphans) {
		log(`orphaned run ${run.id} (${run.workflow}) on ${run.branch}`);
		if (dryRun) continue;
		const response = await fetcher(
			`${api}/repos/${repository}/actions/runs/${run.id}/cancel`,
			{
				method: "POST",
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${token}`,
					"x-github-api-version": "2022-11-28",
				},
			},
		);
		if (!response.ok && response.status !== 409) {
			failed += 1;
			log(`cancel ${run.id} answered ${response.status}`);
		}
	}
	return failed > 0 ? 1 : 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	process.exitCode = await main();
}
