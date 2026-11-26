#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export type OpenPull = Readonly<{
	number: number;
	headSha: string;
	baseSha: string;
}>;

export type Supersession = Readonly<{
	number: number;
	headSha: string;
	baseSha: string;
	carriedBy: number | "main";
}>;

export function findSupersessions(
	pulls: readonly OpenPull[],
	contains: (ancestor: string, descendant: string) => boolean,
	inMain: (sha: string) => boolean,
	preserves: (pull: OpenPull, carrier: string) => boolean,
): Supersession[] {
	const ordered = [...pulls].sort((a, b) => a.number - b.number);
	const carriers = (pull: OpenPull) =>
		ordered.filter(
			(other) =>
				other.number !== pull.number &&
				other.headSha === pull.headSha &&
				other.baseSha === pull.baseSha &&
				contains(pull.headSha, other.headSha) &&
				preserves(pull, other.headSha) &&
				other.number < pull.number,
		);
	const carried = new Set<number>();
	const result: Supersession[] = [];
	for (const pull of ordered) {
		if (inMain(pull.headSha) && preserves(pull, "main")) {
			carried.add(pull.number);
			result.push({ ...pull, carriedBy: "main" });
		}
	}
	const tips = ordered.filter(
		(pull) => !carried.has(pull.number) && carriers(pull).length === 0,
	);
	for (const pull of ordered) {
		if (carried.has(pull.number) || tips.includes(pull)) continue;
		const tip = tips.find((candidate) => carriers(pull).includes(candidate));
		if (tip) result.push({ ...pull, carriedBy: tip.number });
	}
	return result.sort((a, b) => a.number - b.number);
}

export function supersessionComment(found: Supersession): string {
	const where =
		found.carriedBy === "main" ? "main" : `#${found.carriedBy}'s branch`;
	return `Superseded: head \`${found.headSha}\` is an ancestor of ${where}, and its changed paths match that tree. Closing so the work is reviewed and merged once. The branch is kept.`;
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
		if (
			!isObject(pull) ||
			!isNumber(pull.number) ||
			!isObject(pull.head) ||
			!isObject(pull.base) ||
			!isText(pull.base.sha)
		)
			continue;
		const { sha, repo } = pull.head;
		if (!isText(sha) || !isObject(repo) || repo.full_name !== repository)
			continue;
		pulls.push({ number: pull.number, headSha: sha, baseSha: pull.base.sha });
	}
	return pulls;
}

export class RateLimited extends Error {}

export function shouldDryRun(value: string | undefined): boolean {
	return value !== "false";
}

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

function changedPaths(from: string, to: string, cwd: string): Set<string> {
	const output = execFileSync(
		"git",
		[
			"diff",
			"--no-ext-diff",
			"--no-renames",
			"--name-only",
			"-z",
			"--ignore-submodules=none",
			from,
			to,
			"--",
		],
		{ cwd, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
	);
	const paths = new Set<string>();
	let start = 0;
	for (let end = 0; end < output.length; end++) {
		if (output[end] === 0) {
			paths.add(output.subarray(start, end).toString("hex"));
			start = end + 1;
		}
	}
	return paths;
}

export function changesPreserved(
	pull: OpenPull,
	carrier: string,
	cwd = process.cwd(),
): boolean {
	try {
		const fork = execFileSync(
			"git",
			["merge-base", pull.baseSha, pull.headSha],
			{
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		).trim();
		const changed = changedPaths(fork, pull.headSha, cwd);
		if (changed.size === 0) return false;
		const different = changedPaths(pull.headSha, carrier, cwd);
		for (const path of changed) if (different.has(path)) return false;
		return true;
	} catch {
		return false;
	}
}

export async function snapshotsCurrent(
	fetcher: Fetch,
	token: string,
	repository: string,
	base: string,
	mainSha: string,
	pull: OpenPull,
	carrier: OpenPull | "main",
): Promise<boolean> {
	const currentPull = async (snapshot: OpenPull): Promise<boolean> => {
		const value = await getJson(
			fetcher,
			token,
			`/repos/${repository}/pulls/${snapshot.number}`,
		);
		if (
			!isObject(value) ||
			value.state !== "open" ||
			!isObject(value.base) ||
			value.base.ref !== base
		)
			return false;
		const current = parsePullsPage([value], repository)[0];
		return (
			current?.headSha === snapshot.headSha &&
			current.baseSha === snapshot.baseSha
		);
	};
	if (!(await currentPull(pull))) return false;
	if (carrier !== "main") return currentPull(carrier);
	const branch = await getJson(
		fetcher,
		token,
		`/repos/${repository}/branches/${encodeURIComponent(base)}`,
	);
	return (
		isObject(branch) && isObject(branch.commit) && branch.commit.sha === mainSha
	);
}

async function main(): Promise<void> {
	const token = process.env.GITHUB_TOKEN ?? "";
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const base = process.env.PR_SUPERSESSION_BASE ?? "main";
	const dryRun = shouldDryRun(process.env.PR_SUPERSESSION_DRY_RUN);
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
	const mainSha = execFileSync("git", ["rev-parse", mainRef], {
		encoding: "utf8",
	}).trim();
	const preserved = new Map<string, boolean>();
	const found = findSupersessions(
		pulls,
		headsContaining(),
		(sha) => gitContains(sha, mainSha),
		(pull, carrier) => {
			const target = carrier === "main" ? mainSha : carrier;
			const key = `${pull.baseSha}:${pull.headSha}:${target}`;
			if (!preserved.has(key))
				preserved.set(key, changesPreserved(pull, target));
			return preserved.get(key) === true;
		},
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
			const carrier =
				item.carriedBy === "main"
					? "main"
					: pulls.find((pull) => pull.number === item.carriedBy);
			if (
				!carrier ||
				!(await snapshotsCurrent(
					fetch,
					token,
					repository,
					base,
					mainSha,
					item,
					carrier,
				))
			) {
				process.stdout.write(
					`#${item.number} changed since discovery; leaving it open\n`,
				);
				continue;
			}
			await send(
				fetch,
				token,
				"PATCH",
				`/repos/${repository}/pulls/${item.number}`,
				{ state: "closed" },
			);
			await send(
				fetch,
				token,
				"POST",
				`/repos/${repository}/issues/${item.number}/comments`,
				{ body: supersessionComment(item) },
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
