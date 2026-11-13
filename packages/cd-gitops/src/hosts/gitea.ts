// Gitea / Forgejo REST adapter (API v1): multi-file ChangeFiles commit.
//   head   GET  /repos/{o}/{r}/branches/{branch}
//   read   GET  /repos/{o}/{r}/contents/{path}?ref={sha}
//   commit POST /repos/{o}/{r}/contents
//          { branch, message, files: [{ operation, path, content(base64), sha? }] }
// An update carries the file's current blob sha, so a concurrent writer makes
// the commit fail (409/422 → `gitops-host-conflict`). The API has no parent
// guard for newly created files; the publisher re-reads before each commit.

import type { HttpTransport } from "@hobo/core";
import type { GitRepositoryRecord } from "../_generated/gitops_pb.js";
import { GitopsError } from "../errors.js";
import { encodePath, hostFailure, ok, parseJson, pick, send } from "../http.js";
import type { GitHostClient } from "./types.js";

export function createGiteaClient(
	repo: GitRepositoryRecord,
	http: HttpTransport,
	token: () => Promise<string>,
): GitHostClient {
	const base = `${repo.apiBaseUrl}/repos/${repo.repository}`;
	const headers = async (): Promise<Record<string, string>> => ({
		authorization: `token ${await token()}`,
		"content-type": "application/json",
	});
	return {
		async head() {
			const response = await send(http, {
				method: "GET",
				url: `${base}/branches/${encodePath(repo.branch)}`,
				headers: await headers(),
			});
			if (!ok(response)) throw hostFailure(response, "read branch");
			const id = pick(parseJson(response, "read branch"), "commit.id");
			if (id === undefined)
				throw new GitopsError(
					"gitops-host-response-invalid",
					"read branch: no commit.id",
				);
			return id;
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
			if (content === undefined)
				throw new GitopsError(
					"gitops-host-response-invalid",
					`read ${path}: no content`,
				);
			return {
				content: Buffer.from(content, "base64").toString("utf8"),
				blobId: pick(body, "sha") ?? "",
			};
		},
		async commit({ message, changes }) {
			const response = await send(http, {
				method: "POST",
				url: `${base}/contents`,
				headers: await headers(),
				body: JSON.stringify({
					branch: repo.branch,
					message,
					files: changes.map((c) => ({
						operation: c.exists ? "update" : "create",
						path: c.path,
						content: Buffer.from(c.content, "utf8").toString("base64"),
						...(c.exists && c.blobId ? { sha: c.blobId } : undefined),
					})),
				}),
			});
			if (!ok(response)) throw hostFailure(response, "commit");
			const sha = pick(parseJson(response, "commit"), "commit.sha");
			if (sha === undefined)
				throw new GitopsError(
					"gitops-host-response-invalid",
					"commit: no commit.sha",
				);
			return sha;
		},
	};
}
