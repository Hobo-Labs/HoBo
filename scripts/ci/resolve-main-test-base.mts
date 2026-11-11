/**
 * Pick the git base Main full gate uses for affected workspace tests: last green
 * main push on HoBo CI Fabric when reachable, else the push parent, else HEAD~1.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function commitExists(rev: string): boolean {
	return (
		spawnSync("git", ["cat-file", "-e", `${rev}^{commit}`], { stdio: "ignore" })
			.status === 0
	);
}

export function isAncestor(ancestor: string, commit: string): boolean {
	return (
		spawnSync("git", ["merge-base", "--is-ancestor", ancestor, commit], {
			stdio: "ignore",
		}).status === 0
	);
}

export type MainTestBaseSource =
	| "last-green"
	| "push-before"
	| "head-parent"
	| "none";

export type ResolvedMainTestBase = Readonly<{
	base: string;
	source: MainTestBaseSource;
}>;

export type WorkflowRunRow = Readonly<{
	head_sha: string;
	conclusion: string | null;
	event: string;
	path: string;
}>;

export type FetchLastGreenOptions = Readonly<{
	repository: string;
	token: string;
	workflowBasename: string;
	head: string;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
}>;

export async function fetchLastGreenMainSha(
	options: FetchLastGreenOptions,
): Promise<string | undefined> {
	const [owner, repo] = options.repository.split("/");
	if (!owner || !repo) return undefined;
	// Runs of this one workflow: the repository-wide list mixes in every other
	// workflow's push runs, which could crowd the last green one out of the page.
	const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(options.workflowBasename)}/runs?branch=main&event=push&status=completed&per_page=30`;
	// Every caller falls back without a last green commit (push parent, the push's
	// own range), so a slow, refused or unreadable answer is "none", never a throw.
	let runs: readonly WorkflowRunRow[];
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
		// SAFETY: GitHub REST `workflow_runs` entries expose the fields `WorkflowRunRow` uses; extras are ignored.
		const body = (await response.json()) as {
			workflow_runs?: WorkflowRunRow[];
		};
		runs = body.workflow_runs ?? [];
	} catch {
		return undefined;
	}
	for (const run of runs) {
		if (run.conclusion !== "success") continue;
		if (!run.path.endsWith(`/${options.workflowBasename}`)) continue;
		const sha = run.head_sha.trim();
		if (!/^[0-9a-f]{40}$/iu.test(sha)) continue;
		if (sha === options.head) continue;
		if (!commitExists(sha)) continue;
		if (!isAncestor(sha, options.head)) continue;
		return sha;
	}
	return undefined;
}

export function resolveMainTestBase(input: {
	eventName: string;
	pushBefore: string;
	head: string;
	lastGreenSha?: string;
}): ResolvedMainTestBase {
	if (input.eventName === "schedule") {
		return { base: "", source: "none" };
	}
	const head = input.head.trim();
	if (
		input.lastGreenSha &&
		commitExists(input.lastGreenSha) &&
		isAncestor(input.lastGreenSha, head)
	) {
		return { base: input.lastGreenSha, source: "last-green" };
	}
	const before = input.pushBefore.trim();
	if (before && before !== "0".repeat(40) && commitExists(before)) {
		return { base: before, source: "push-before" };
	}
	const parent = spawnSync("git", ["rev-parse", `${head}^`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).stdout.trim();
	if (parent && commitExists(parent)) {
		return { base: parent, source: "head-parent" };
	}
	return { base: "", source: "none" };
}

async function main(): Promise<void> {
	const eventName = process.env.EVENT_NAME ?? "";
	const pushBefore = process.env.PUSH_BEFORE ?? "";
	const head = process.env.HEAD_SHA ?? "";
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const token = process.env.GITHUB_TOKEN?.trim() ?? "";
	let lastGreen: string | undefined;
	if (token && repository && eventName === "push") {
		lastGreen = await fetchLastGreenMainSha({
			repository,
			token,
			workflowBasename: "hobo-ci.yml",
			head,
			fetch: globalThis.fetch,
		});
	}
	const resolved = resolveMainTestBase(
		lastGreen === undefined
			? { eventName, pushBefore, head }
			: { eventName, pushBefore, head, lastGreenSha: lastGreen },
	);
	process.stdout.write(`${resolved.base}\n`);
	process.stderr.write(
		`main test base: ${resolved.source} (${resolved.base || "repo-wide"})\n`,
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	void main();
}
