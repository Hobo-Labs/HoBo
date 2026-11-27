import type { HttpTransport, JsonObject } from "@hobo/core";
import type { GitRepositoryRecord } from "../_generated/gitops_pb.js";
import { GitopsError } from "../errors.js";
import { hostFailure, ok, parseJson, pick, send } from "../http.js";
import { isJsonNumber } from "../json.js";
import type {
	GitHostClient,
	PullRequestInfo,
	PullRequestState,
} from "./types.js";

function gitlabMrState(body: JsonObject): PullRequestState {
	const state = pick(body, "state");
	if (state === "merged") return "merged";
	if (state === "closed") return "closed";
	return "open";
}

function gitlabMrInfo(body: JsonObject, what: string): PullRequestInfo {
	const rawIid = body.iid;
	const id = isJsonNumber(rawIid) ? String(rawIid) : pick(body, "iid");
	const url = pick(body, "web_url");
	if (id === undefined || url === undefined) {
		throw new GitopsError(
			"gitops-host-response-invalid",
			`${what}: missing merge request iid or web_url`,
		);
	}
	const mergeCommitSha = pick(body, "merge_commit_sha");
	return {
		id,
		url,
		state: gitlabMrState(body),
		headBranch: pick(body, "source_branch") ?? "",
		baseBranch: pick(body, "target_branch") ?? "",
		...(mergeCommitSha !== undefined ? { mergeCommitSha } : undefined),
	};
}

export function createGitLabClient(
	repo: GitRepositoryRecord,
	http: HttpTransport,
	token: () => Promise<string>,
): GitHostClient {
	const projectBase = `${repo.apiBaseUrl}/projects/${encodeURIComponent(repo.repository)}`;
	const base = `${projectBase}/repository`;
	const headers = async (): Promise<Record<string, string>> => ({
		authorization: `Bearer ${await token()}`,
		"content-type": "application/json",
	});
	return {
		async head(branch = repo.branch) {
			const response = await send(http, {
				method: "GET",
				url: `${base}/branches/${encodeURIComponent(branch)}`,
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
		async commit({ parent, message, changes, branch = repo.branch }) {
			const response = await send(http, {
				method: "POST",
				url: `${base}/commits`,
				headers: await headers(),
				body: JSON.stringify({
					branch,
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
		async createBranch({ name, fromSha }) {
			const response = await send(http, {
				method: "POST",
				url: `${base}/branches`,
				headers: await headers(),
				body: JSON.stringify({ branch: name, ref: fromSha }),
			});
			if (!ok(response)) throw hostFailure(response, "create branch");
		},
		async openPullRequest({
			headBranch,
			baseBranch = repo.branch,
			title,
			body,
		}) {
			const response = await send(http, {
				method: "POST",
				url: `${projectBase}/merge_requests`,
				headers: await headers(),
				body: JSON.stringify({
					source_branch: headBranch,
					target_branch: baseBranch,
					title,
					description: body,
				}),
			});
			if (!ok(response)) throw hostFailure(response, "open merge request");
			return gitlabMrInfo(
				parseJson(response, "open merge request"),
				"open merge request",
			);
		},
		async getPullRequest(prId) {
			const response = await send(http, {
				method: "GET",
				url: `${projectBase}/merge_requests/${encodeURIComponent(prId)}`,
				headers: await headers(),
			});
			if (!ok(response)) throw hostFailure(response, "get merge request");
			return gitlabMrInfo(
				parseJson(response, "get merge request"),
				"get merge request",
			);
		},
		async mergePullRequest({ prId, method = "merge", commitTitle }) {
			const response = await send(http, {
				method: "PUT",
				url: `${projectBase}/merge_requests/${encodeURIComponent(prId)}/merge`,
				headers: await headers(),
				body: JSON.stringify({
					squash: method === "squash",
					...(commitTitle !== undefined
						? { merge_commit_message: commitTitle }
						: undefined),
				}),
			});
			if (!ok(response)) throw hostFailure(response, "merge merge request");
			const body = parseJson(response, "merge merge request");
			const mergeCommitSha = pick(body, "merge_commit_sha");
			return {
				merged:
					pick(body, "state") === "merged" || mergeCommitSha !== undefined,
				...(mergeCommitSha !== undefined ? { mergeCommitSha } : undefined),
			};
		},
	};
}
