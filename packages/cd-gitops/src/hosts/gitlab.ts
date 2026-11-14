// GitLab REST adapter (v4): one commit with several actions.
//   head   GET  /projects/{id}/repository/branches/{branch}
//   read   GET  /projects/{id}/repository/files/{path}?ref={sha}
//   commit POST /projects/{id}/repository/commits
//          { branch, commit_message, start_sha, actions: [{ action, file_path, content }] }
// `start_sha` makes GitLab refuse the commit if the branch moved (400/409),
// which maps to `gitops-host-conflict`.

import type { HttpTransport } from "@hobo/core";
import type { GitRepositoryRecord } from "../_generated/gitops_pb.js";
import { GitopsError } from "../errors.js";
import { hostFailure, ok, parseJson, pick, send } from "../http.js";
import type { GitHostClient } from "./types.js";

export function createGitLabClient(
	repo: GitRepositoryRecord,
	http: HttpTransport,
	token: () => Promise<string>,
): GitHostClient {
	const base = `${repo.apiBaseUrl}/projects/${encodeURIComponent(repo.repository)}/repository`;
	const headers = async (): Promise<Record<string, string>> => ({
		authorization: `Bearer ${await token()}`,
		"content-type": "application/json",
	});
	return {
		async head() {
			const response = await send(http, {
				method: "GET",
				url: `${base}/branches/${encodeURIComponent(repo.branch)}`,
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
				url: `${base}/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
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
				blobId: pick(body, "blob_id") ?? "",
			};
		},
		async commit({ parent, message, changes }) {
			const response = await send(http, {
				method: "POST",
				url: `${base}/commits`,
				headers: await headers(),
				body: JSON.stringify({
					branch: repo.branch,
					commit_message: message,
					start_sha: parent,
					actions: changes.map((c) => ({
						action: c.exists ? "update" : "create",
						file_path: c.path,
						content: c.content,
					})),
				}),
			});
			if (response.status === 400) {
				throw new GitopsError(
					"gitops-host-conflict",
					"commit: branch moved or file state changed (HTTP 400)",
					400,
				);
			}
			if (!ok(response)) throw hostFailure(response, "commit");
			const id = pick(parseJson(response, "commit"), "id");
			if (id === undefined)
				throw new GitopsError("gitops-host-response-invalid", "commit: no id");
			return id;
		},
	};
}
