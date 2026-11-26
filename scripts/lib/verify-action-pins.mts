import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type ActionPinAllowlist = Record<string, readonly string[]>;

const allowlistPath = join(
	import.meta.dirname,
	"..",
	"action-pin-allowlist.json",
);

const actionPinAllowlistSchema = z.record(
	z.string(),
	z.array(z.string().regex(/^[0-9a-f]{40}$/)),
);

let cachedAllowlist: ActionPinAllowlist | undefined;

export function loadActionPinAllowlist(): ActionPinAllowlist {
	if (cachedAllowlist) return cachedAllowlist;
	const raw: unknown = JSON.parse(readFileSync(allowlistPath, "utf8"));
	cachedAllowlist = actionPinAllowlistSchema.parse(raw);
	return cachedAllowlist;
}

export function isActionPinAllowlisted(repo: string, sha: string): boolean {
	const allowlist = loadActionPinAllowlist();
	return allowlist[repo]?.includes(sha) ?? false;
}

export function resolveGitHubToken(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const token =
		env.GITHUB_TOKEN?.trim() ||
		env.GH_TOKEN?.trim() ||
		env.ACTIONS_RUNTIME_TOKEN?.trim();
	return token || undefined;
}

type VerifyOutcome = "ok" | "missing" | "unavailable";

export async function verifyActionPinViaGitHubApi(
	repo: string,
	sha: string,
	token: string | undefined,
): Promise<VerifyOutcome> {
	const headers = new Headers({
		Accept: "application/vnd.github+json",
		"User-Agent": "hobo-lint-actions",
	});
	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	const url = `https://api.github.com/repos/${repo}/commits/${sha}`;
	const response = await fetch(url, { headers, redirect: "follow" });
	if (response.status === 404) return "missing";
	if (response.ok) return "ok";
	if (response.status === 403 || response.status === 429) return "unavailable";
	return "unavailable";
}

export function verifyActionPinViaGitLsRemote(
	repo: string,
	sha: string,
): VerifyOutcome {
	const url = `https://github.com/${repo}.git`;
	const result = spawnSync("git", ["ls-remote", url, sha], {
		encoding: "utf8",
		timeout: 120_000,
	});
	if (result.error || result.status !== 0) return "unavailable";
	const firstLine = result.stdout.trim().split("\n").find(Boolean);
	if (!firstLine) return "missing";
	const remoteSha = firstLine.split("\t")[0]?.trim();
	return remoteSha === sha ? "ok" : "missing";
}

/** Returns an error message when the pin cannot be verified; undefined when ok. */
export async function verifyPinnedActionSha(
	repo: string,
	sha: string,
	context: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	if (isActionPinAllowlisted(repo, sha)) return undefined;
	const token = resolveGitHubToken(env);
	const api = await verifyActionPinViaGitHubApi(repo, sha, token || undefined);
	if (api === "ok") return undefined;
	if (api === "missing") {
		return `${context}: pinned action ${repo}@${sha} does not exist on GitHub (404)`;
	}
	const git = verifyActionPinViaGitLsRemote(repo, sha);
	if (git === "ok") return undefined;
	if (git === "missing") {
		return `${context}: pinned action ${repo}@${sha} does not exist (git ls-remote)`;
	}
	return `${context}: could not verify ${repo}@${sha} (GitHub API rate-limited or unavailable; not in scripts/action-pin-allowlist.json)`;
}
