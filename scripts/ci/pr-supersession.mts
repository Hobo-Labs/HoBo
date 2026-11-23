#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export type OpenPull = Readonly<{ number: number; headSha: string }>;

export type Supersession = Readonly<{
	number: number;
	headSha: string;
	carriedBy: number | "main";
}>;

export function findSupersessions(
	pulls: readonly OpenPull[],
	contains: (ancestor: string, descendant: string) => boolean,
	inMain: (sha: string) => boolean,
): Supersession[] {
	const ordered = [...pulls].sort((a, b) => a.number - b.number);
	const carriers = (pull: OpenPull) =>
		ordered.filter(
			(other) =>
				other.number !== pull.number &&
				contains(pull.headSha, other.headSha) &&
				(other.headSha !== pull.headSha || other.number < pull.number),
		);
	const carried = new Set<number>();
	const result: Supersession[] = [];
	for (const pull of ordered) {
		if (inMain(pull.headSha)) {
			carried.add(pull.number);
			result.push({ ...pull, carriedBy: "main" });
		}
	}
	const tips = ordered.filter(
		(pull) => !carried.has(pull.number) && carriers(pull).length === 0,
	);
	for (const pull of ordered) {
		if (carried.has(pull.number) || tips.includes(pull)) continue;
		const tip = tips.find((candidate) =>
			contains(pull.headSha, candidate.headSha),
		);
		if (tip) result.push({ ...pull, carriedBy: tip.number });
	}
	return result.sort((a, b) => a.number - b.number);
}

export function supersessionComment(found: Supersession): string {
	const where =
		found.carriedBy === "main" ? "main" : `#${found.carriedBy}'s branch`;
	const lands =
		found.carriedBy === "main"
			? "every commit here is already on main"
			: `every commit here lands with #${found.carriedBy}`;
	return `Superseded: head \`${found.headSha}\` is an ancestor of ${where}, so ${lands}. Closing so the work is reviewed and merged once. The branch is kept.`;
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

function parseJson(text: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(text);
		return parsed;
	} catch {
		return undefined;
	}
}

export function parsePullsPage(
	page: JsonValue | undefined,
	repository: string,
): OpenPull[] {
	if (!Array.isArray(page)) return [];
	const pulls: OpenPull[] = [];
	for (const pull of page) {
		if (!isObject(pull) || !isNumber(pull.number) || !isObject(pull.head))
			continue;
		const { sha, repo } = pull.head;
		if (!isText(sha) || !isObject(repo) || repo.full_name !== repository)
			continue;
		pulls.push({ number: pull.number, headSha: sha });
	}
	return pulls;
}

export class RateLimited extends Error {}

function requestHeaders(token: string, json: boolean): Headers {
	const headers = new Headers({
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"x-github-api-version": "2022-11-28",
	});
	if (json) headers.set("content-type", "application/json");
	return headers;
}

async function checked(response: Response, what: string): Promise<string> {
	if (response.status === 403 || response.status === 429)
		throw new RateLimited(`${what} answered ${response.status}`);
	if (!response.ok) throw new Error(`${what} answered ${response.status}`);
	return response.text();
}

async function getJson(
	fetcher: Fetch,
	token: string,
	path: string,
): Promise<JsonValue | undefined> {
	const response = await fetcher(`https://api.github.com${path}`, {
		headers: requestHeaders(token, false),
	});
	return parseJson(await checked(response, `GitHub GET ${path}`));
}

async function send(
	fetcher: Fetch,
	token: string,
	method: "POST" | "PATCH",
	path: string,
	body: Readonly<Record<string, string>>,
): Promise<void> {
	const headers = requestHeaders(token, true);
	const response = await fetcher(`https://api.github.com${path}`, {
		method,
		headers,
		body: JSON.stringify(body),
	});
	await checked(response, `GitHub ${method} ${path}`);
}

export async function listOpenPulls(
	fetcher: Fetch,
	token: string,
	repository: string,
	base: string,
): Promise<OpenPull[]> {
	const pulls: OpenPull[] = [];
	for (let page = 1; page <= 50; page++) {
		const batch = await getJson(
			fetcher,
			token,
			`/repos/${repository}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100&page=${page}`,
		);
		if (!Array.isArray(batch) || batch.length === 0) break;
		pulls.push(...parsePullsPage(batch, repository));
	}
	return pulls;
}

const PACE_MS = 3_000;
const BUDGET_MS = 15 * 60_000;

const PULL_REFS = "refs/supersession/";

export function headsContaining(): (
	ancestor: string,
	descendant: string,
) => boolean {
	const containing = new Map<string, ReadonlySet<string>>();
	return (ancestor, descendant) => {
		let heads = containing.get(ancestor);
		if (!heads) {
			heads = new Set(
				execFileSync(
					"git",
					[
						"for-each-ref",
						"--contains",
						ancestor,
						"--format=%(objectname)",
						PULL_REFS,
					],
					{ encoding: "utf8" },
				)
					.split("\n")
					.filter(Boolean),
			);
			containing.set(ancestor, heads);
		}
		return heads.has(descendant);
	};
}

function gitContains(ancestor: string, descendant: string): boolean {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const token = process.env.GITHUB_TOKEN ?? "";
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const base = process.env.PR_SUPERSESSION_BASE ?? "main";
	const dryRun = process.env.PR_SUPERSESSION_DRY_RUN === "true";
	if (!token || !repository)
		throw new Error("missing configuration: GITHUB_TOKEN, GITHUB_REPOSITORY");
	const pulls = await listOpenPulls(fetch, token, repository, base);
	execFileSync(
		"git",
		[
			"fetch",
			"--quiet",
			"--no-tags",
			"--filter=blob:none",
			"origin",
			`+refs/heads/${base}:refs/remotes/origin/${base}`,
			...pulls.map(
				(pull) => `+refs/pull/${pull.number}/head:${PULL_REFS}${pull.number}`,
			),
		],
		{ stdio: "inherit" },
	);
	const mainRef = `refs/remotes/origin/${base}`;
	const found = findSupersessions(pulls, headsContaining(), (sha) =>
		gitContains(sha, mainRef),
	);
	let closed = 0;
	const deadline = Date.now() + BUDGET_MS;
	for (const item of found) {
		if (!dryRun && Date.now() > deadline) {
			process.stdout.write(
				`time budget spent after ${closed}; the next run continues\n`,
			);
			break;
		}
		const target = item.carriedBy === "main" ? base : `#${item.carriedBy}`;
		process.stdout.write(`#${item.number} carried by ${target}\n`);
		if (dryRun) continue;
		try {
			await send(
				fetch,
				token,
				"POST",
				`/repos/${repository}/issues/${item.number}/comments`,
				{ body: supersessionComment(item) },
			);
			await send(
				fetch,
				token,
				"PATCH",
				`/repos/${repository}/pulls/${item.number}`,
				{ state: "closed" },
			);
		} catch (error) {
			if (!(error instanceof RateLimited)) throw error;
			process.stdout.write(
				`rate limited after ${closed}; the next run continues: ${error.message}\n`,
			);
			break;
		}
		closed++;
		await new Promise((resolve) => setTimeout(resolve, PACE_MS));
	}
	process.stdout.write(
		`${pulls.length} open, ${found.length} superseded${dryRun ? " (dry run)" : ""}\n`,
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error: Error) => {
		process.stderr.write(`${error.message}\n`);
		process.exit(1);
	});
}
