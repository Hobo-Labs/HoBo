// GitHub REST adapter: Git Data API for one atomic multi-file commit.
//   head   GET   /repos/{o}/{r}/git/ref/heads/{branch}
//   read   GET   /repos/{o}/{r}/contents/{path}?ref={sha}
//   commit GET   /repos/{o}/{r}/git/commits/{parent}       (base tree)
//          POST  /repos/{o}/{r}/git/trees                  (inline contents)
//          POST  /repos/{o}/{r}/git/commits
//          PATCH /repos/{o}/{r}/git/refs/heads/{branch}    (force: false)

import type { HttpTransport } from "@hobo/core";
import type { GitRepositoryRecord } from "../_generated/gitops_pb.js";
import { GitopsError } from "../errors.js";
import { encodePath, hostFailure, ok, parseJson, pick, send } from "../http.js";
import type { GitHostClient } from "./types.js";

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
		method: "GET" | "POST" | "PATCH",
		path: string,
		what: string,
		body?: unknown,
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
	const sha = (value: unknown, path: string, what: string): string => {
		const found = pick(value, path);
		if (found === undefined)
			throw new GitopsError(
				"gitops-host-response-invalid",
				`${what}: no ${path}`,
			);
		return found;
	};
	return {
		async head() {
			const ref = await json(
				"GET",
				`/git/ref/heads/${encodePath(repo.branch)}`,
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
		async commit({ parent, message, changes }) {
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
				`/git/refs/heads/${encodePath(repo.branch)}`,
				"advance branch",
				{
					sha: commitSha,
					force: false,
				},
			);
			return commitSha;
		},
	};
}
