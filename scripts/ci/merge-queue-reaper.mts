#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export const QUEUE_BRANCH_PREFIX = "gh-readonly-queue/";

export const ACTIVE_STATUSES = Object.freeze([
	"queued",
	"in_progress",
	"waiting",
	"pending",
	"requested",
] as const);

export type QueueRun = Readonly<{
	id: number;
	name: string;
	headBranch: string;
	headSha: string;
}>;

export type GroupState = "queued" | "landed" | "abandoned";

export function abandonedRuns(
	runs: readonly QueueRun[],
	stateOf: (run: QueueRun) => GroupState,
	self?: number,
): QueueRun[] {
	return runs.filter(
		(run) =>
			run.id !== self &&
			run.headBranch.startsWith(QUEUE_BRANCH_PREFIX) &&
			stateOf(run) === "abandoned",
	);
}

type Fetch = typeof fetch;

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
			!isText(run.head_sha)
		)
			continue;
		runs.push({
			id: run.id,
			name: isText(run.name) ? run.name : "",
			headBranch: run.head_branch,
			headSha: run.head_sha,
		});
	}
	return runs;
}

export class RateLimited extends Error {}

function requestHeaders(token: string): Headers {
	return new Headers({
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"x-github-api-version": "2022-11-28",
	});
}

async function call(
	fetcher: Fetch,
	token: string,
	method: "GET" | "POST",
	path: string,
): Promise<Response> {
	const response = await fetcher(`https://api.github.com${path}`, {
		method,
		headers: requestHeaders(token),
	});
	if (response.status === 403 || response.status === 429)
		throw new RateLimited(
			`GitHub ${method} ${path} answered ${response.status}`,
		);
	return response;
}

async function json(response: Response, what: string): Promise<JsonValue> {
	if (!response.ok) throw new Error(`${what} answered ${response.status}`);
	const parsed: JsonValue = JSON.parse(await response.text());
	return parsed;
}

export async function listActiveQueueRuns(
	fetcher: Fetch,
	token: string,
	repository: string,
): Promise<QueueRun[]> {
	const seen = new Map<number, QueueRun>();
	for (const status of ACTIVE_STATUSES)
		for (let page = 1; page <= 10; page++) {
			const path = `/repos/${repository}/actions/runs?event=merge_group&status=${status}&per_page=100&page=${page}`;
			const batch = parseRunsPage(
				await json(
					await call(fetcher, token, "GET", path),
					`GitHub GET ${path}`,
				),
			);
			for (const run of batch) seen.set(run.id, run);
			if (batch.length < 100) break;
		}
	return [...seen.values()].sort((a, b) => a.id - b.id);
}

export async function groupState(
	fetcher: Fetch,
	token: string,
	repository: string,
	base: string,
	run: QueueRun,
): Promise<GroupState> {
	const ref = await call(
		fetcher,
		token,
		"GET",
		`/repos/${repository}/git/ref/heads/${run.headBranch.split("/").map(encodeURIComponent).join("/")}`,
	);
	if (ref.ok) return "queued";
	if (ref.status !== 404)
		throw new Error(`GitHub GET ref ${run.headBranch} answered ${ref.status}`);
	const compare = await call(
		fetcher,
		token,
		"GET",
		`/repos/${repository}/compare/${run.headSha}...${encodeURIComponent(base)}`,
	);
	if (compare.status === 404) return "abandoned";
	const value = await json(compare, `GitHub GET compare ${run.headSha}`);
	return isObject(value) &&
		(value.status === "ahead" || value.status === "identical")
		? "landed"
		: "abandoned";
}

export async function cancelRun(
	fetcher: Fetch,
	token: string,
	repository: string,
	id: number,
): Promise<"cancelled" | "finished"> {
	const response = await call(
		fetcher,
		token,
		"POST",
		`/repos/${repository}/actions/runs/${id}/cancel`,
	);
	if (response.status === 409) return "finished";
	if (!response.ok)
		throw new Error(`GitHub POST cancel ${id} answered ${response.status}`);
	return "cancelled";
}

export function shouldDryRun(value: string | undefined): boolean {
	return value === "true";
}

export async function reap(
	fetcher: Fetch,
	options: Readonly<{
		token: string;
		repository: string;
		base: string;
		dryRun: boolean;
		self?: number;
		write?: (line: string) => void;
	}>,
): Promise<QueueRun[]> {
	const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
	const runs = await listActiveQueueRuns(
		fetcher,
		options.token,
		options.repository,
	);
	const states = new Map<string, GroupState>();
	for (const run of runs) {
		if (!run.headBranch.startsWith(QUEUE_BRANCH_PREFIX)) continue;
		if (!states.has(run.headBranch))
			states.set(
				run.headBranch,
				await groupState(
					fetcher,
					options.token,
					options.repository,
					options.base,
					run,
				),
			);
	}
	const found = abandonedRuns(
		runs,
		(run) => states.get(run.headBranch) ?? "queued",
		options.self,
	);
	for (const run of found) {
		if (options.dryRun) {
			write(`would cancel ${run.id} ${run.name} (${run.headBranch})`);
			continue;
		}
		const outcome = await cancelRun(
			fetcher,
			options.token,
			options.repository,
			run.id,
		);
		write(`${outcome} ${run.id} ${run.name} (${run.headBranch})`);
	}
	write(
		`${runs.length} active merge-group runs, ${found.length} from groups the queue dropped${options.dryRun ? " (dry run)" : ""}`,
	);
	return found;
}

async function main(): Promise<void> {
	const token = process.env.GITHUB_TOKEN ?? "";
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	if (!token || !repository)
		throw new Error("missing configuration: GITHUB_TOKEN, GITHUB_REPOSITORY");
	const self = Number(process.env.GITHUB_RUN_ID);
	try {
		await reap(fetch, {
			token,
			repository,
			base: process.env.MERGE_QUEUE_REAPER_BASE ?? "main",
			dryRun: shouldDryRun(process.env.MERGE_QUEUE_REAPER_DRY_RUN),
			...(Number.isSafeInteger(self) ? { self } : undefined),
		});
	} catch (error) {
		if (!(error instanceof RateLimited)) throw error;
		process.stdout.write(
			`rate limited; the next run continues: ${error.message}\n`,
		);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error: Error) => {
		process.stderr.write(`${error.message}\n`);
		process.exit(1);
	});
}
