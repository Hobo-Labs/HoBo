import type { HttpTransport, JsonObject } from "@hobo/core";
import type { GitRepositoryRecord } from "../_generated/gitops_pb.js";
import { GitopsError } from "../errors.js";
import { encodePath, hostFailure, ok, parseJson, pick, send } from "../http.js";
import { isJsonNumber } from "../json.js";
import type {
	GitHostClient,
	PullRequestInfo,
	PullRequestState,
} from "./types.js";

function githubPrState(body: JsonObject): PullRequestState {
	if (body.merged === true || pick(body, "merged_at") !== undefined) {
		return "merged";
	}
	return pick(body, "state") === "closed" ? "closed" : "open";
}

function githubPrInfo(body: JsonObject, what: string): PullRequestInfo {
	const rawNumber = body.number;
	const id = isJsonNumber(rawNumber) ? String(rawNumber) : pick(body, "number");
	const url = pick(body, "html_url") ?? pick(body, "url");
	const headBranch = pick(body, "head.ref") ?? "";
	const baseBranch = pick(body, "base.ref") ?? "";
	if (id === undefined || url === undefined) {
		throw new GitopsError(
			"gitops-host-response-invalid",
			`${what}: missing pull request number or html_url`,
		);
	}
	const mergeCommitSha = pick(body, "merge_commit_sha");
	return {
		id,
		url,
		state: githubPrState(body),
		headBranch,
		baseBranch,
		...(mergeCommitSha !== undefined ? { mergeCommitSha } : undefined),
	};
}

export function createGitHubClient(
	repo: GitRepositoryRecord,
	http: HttpTransport,
	token: () => Promise<string>,
): GitHostClient {
	const base = `${repo.apiBaseUrl}/repos/${repo.repository}`;
	const headers = async (): Promise<Record<string, string>> => ({
		authorization: `Bearer ${await token()}`,
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"content-type": "application/json",
	});
	const json = async (
		method: "GET" | "POST" | "PATCH" | "PUT",
		path: string,
		what: string,
		body?: JsonObject,
	) => {
		const response = await send(http, {
			method,
			url: `${base}${path}`,
			headers: await headers(),
			...(body !== undefined ? { body: JSON.stringify(body) } : undefined),
		});
		if (!ok(response)) throw hostFailure(response, what);
		return parseJson(response, what);
	};
	const sha = (value: JsonObject, path: string, what: string): string => {
		const found = pick(value, path);
		if (found === undefined)
			throw new GitopsError(
				"gitops-host-response-invalid",
				`${what}: no ${path}`,
			);
		return found;
	};
	return {
		async head(branch = repo.branch) {
			const ref = await json(
				"GET",
				`/git/ref/heads/${encodePath(branch)}`,
				"read branch",
			);
			return sha(ref, "object.sha", "read branch");
		},
		async read(path, ref) {
			const response = await send(http, {
				method: "GET",
				url: `${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
				headers: await headers(),
			});
			if (response.status === 404) return undefined;
			if (!ok(response)) throw hostFailure(response, `read ${path}`);
			const body = parseJson(response, `read ${path}`);
			const content = pick(body, "content");
			if (content === undefined || pick(body, "encoding") !== "base64") {
				throw new GitopsError(
					"gitops-host-response-invalid",
					`read ${path}: no base64 content`,
				);
			}
			return {
				content: Buffer.from(content, "base64").toString("utf8"),
				blobId: pick(body, "sha") ?? "",
			};
		},
		async commit({ parent, message, changes, branch = repo.branch }) {
			const parentCommit = await json(
				"GET",
				`/git/commits/${parent}`,
				"read parent commit",
			);
			const baseTree = sha(parentCommit, "tree.sha", "read parent commit");
			const tree = await json("POST", "/git/trees", "create tree", {
				base_tree: baseTree,
				tree: changes.map((c) => ({
					path: c.path,
					mode: "100644",
					type: "blob",
					content: c.content,
				})),
			});
			const commit = await json("POST", "/git/commits", "create commit", {
				message,
				tree: sha(tree, "sha", "create tree"),
				parents: [parent],
			});
			const commitSha = sha(commit, "sha", "create commit");
			await json(
				"PATCH",
				`/git/refs/heads/${encodePath(branch)}`,
				"advance branch",
				{
					sha: commitSha,
					force: false,
				},
			);
			return commitSha;
		},
		async createBranch({ name, fromSha }) {
			await json("POST", "/git/refs", "create branch", {
				ref: `refs/heads/${name}`,
				sha: fromSha,
			});
		},
		async openPullRequest({
			headBranch,
			baseBranch = repo.branch,
			title,
			body,
		}) {
			const created = await json("POST", "/pulls", "open pull request", {
				title,
				head: headBranch,
				base: baseBranch,
				body,
			});
			return githubPrInfo(created, "open pull request");
		},
		async getPullRequest(prId) {
			const fetched = await json(
				"GET",
				`/pulls/${encodeURIComponent(prId)}`,
				"get pull request",
			);
			return githubPrInfo(fetched, "get pull request");
		},
		async mergePullRequest({ prId, method = "merge", commitTitle }) {
			const merged = await json(
				"PUT",
				`/pulls/${encodeURIComponent(prId)}/merge`,
				"merge pull request",
				{
					merge_method: method,
					...(commitTitle !== undefined
						? { commit_title: commitTitle }
						: undefined),
				},
			);
			const mergeCommitSha = pick(merged, "sha");
			return {
				merged: merged.merged === true || mergeCommitSha !== undefined,
				...(mergeCommitSha !== undefined ? { mergeCommitSha } : undefined),
			};
		},
	};
}
