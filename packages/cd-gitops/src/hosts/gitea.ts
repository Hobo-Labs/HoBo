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

function giteaPrState(body: JsonObject): PullRequestState {
	if (body.merged === true || pick(body, "merged_at") !== undefined) {
		return "merged";
	}
	return pick(body, "state") === "closed" ? "closed" : "open";
}

function giteaPrInfo(body: JsonObject, what: string): PullRequestInfo {
	const rawNumber = body.number;
	const id = isJsonNumber(rawNumber) ? String(rawNumber) : pick(body, "number");
	const url = pick(body, "html_url") ?? pick(body, "url");
	if (id === undefined || url === undefined) {
		throw new GitopsError(
			"gitops-host-response-invalid",
			`${what}: missing pull request number or html_url`,
		);
	}
	const mergeCommitSha =
		pick(body, "merged_commit_id") ?? pick(body, "merged_commit_sha");
	return {
		id,
		url,
		state: giteaPrState(body),
		headBranch: pick(body, "head.ref") ?? "",
		baseBranch: pick(body, "base.ref") ?? "",
		...(mergeCommitSha !== undefined ? { mergeCommitSha } : undefined),
	};
}

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
		async head(branch = repo.branch) {
			const response = await send(http, {
				method: "GET",
				url: `${base}/branches/${encodePath(branch)}`,
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
		async commit({ message, changes, branch = repo.branch }) {
			const response = await send(http, {
				method: "POST",
				url: `${base}/contents`,
				headers: await headers(),
				body: JSON.stringify({
					branch,
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
		async createBranch({ name, fromSha }) {
			const response = await send(http, {
				method: "POST",
				url: `${base}/branches`,
				headers: await headers(),
				body: JSON.stringify({
					new_branch_name: name,
					old_ref_name: fromSha,
				}),
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
				url: `${base}/pulls`,
				headers: await headers(),
				body: JSON.stringify({
					head: headBranch,
					base: baseBranch,
					title,
					body,
				}),
			});
			if (!ok(response)) throw hostFailure(response, "open pull request");
			return giteaPrInfo(
				parseJson(response, "open pull request"),
				"open pull request",
			);
		},
		async getPullRequest(prId) {
			const response = await send(http, {
				method: "GET",
				url: `${base}/pulls/${encodeURIComponent(prId)}`,
				headers: await headers(),
			});
			if (!ok(response)) throw hostFailure(response, "get pull request");
			return giteaPrInfo(
				parseJson(response, "get pull request"),
				"get pull request",
			);
		},
		async mergePullRequest({ prId, method = "merge", commitTitle }) {
			const response = await send(http, {
				method: "POST",
				url: `${base}/pulls/${encodeURIComponent(prId)}/merge`,
				headers: await headers(),
				body: JSON.stringify({
					Do: method,
					...(commitTitle !== undefined
						? { MergeTitleField: commitTitle }
						: undefined),
				}),
			});
			if (!ok(response)) throw hostFailure(response, "merge pull request");
			const updated = await send(http, {
				method: "GET",
				url: `${base}/pulls/${encodeURIComponent(prId)}`,
				headers: await headers(),
			});
			if (!ok(updated)) return { merged: true };
			const info = giteaPrInfo(
				parseJson(updated, "get merged pull request"),
				"get merged pull request",
			);
			return {
				merged: true,
				...(info.mergeCommitSha !== undefined
					? { mergeCommitSha: info.mergeCommitSha }
					: undefined),
			};
		},
	};
}
