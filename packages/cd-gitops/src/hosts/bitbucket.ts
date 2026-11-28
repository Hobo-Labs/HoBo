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

function bitbucketPrState(body: JsonObject): PullRequestState {
	const state = pick(body, "state");
	if (state === "MERGED") return "merged";
	if (state === "DECLINED" || state === "SUPERSEDED") return "closed";
	return "open";
}

function bitbucketPrInfo(body: JsonObject, what: string): PullRequestInfo {
	const rawId = body.id;
	const id = isJsonNumber(rawId) ? String(rawId) : pick(body, "id");
	const url = pick(body, "links.html.href");
	if (id === undefined || url === undefined) {
		throw new GitopsError(
			"gitops-host-response-invalid",
			`${what}: missing pull request id or links.html.href`,
		);
	}
	const mergeCommitSha = pick(body, "merge_commit.hash");
	return {
		id,
		url,
		state: bitbucketPrState(body),
		headBranch: pick(body, "source.branch.name") ?? "",
		baseBranch: pick(body, "destination.branch.name") ?? "",
		...(mergeCommitSha !== undefined ? { mergeCommitSha } : undefined),
	};
}

export function createBitbucketClient(
	repo: GitRepositoryRecord,
	http: HttpTransport,
	token: () => Promise<string>,
): GitHostClient {
	const base = `${repo.apiBaseUrl}/repositories/${repo.repository}`;
	const auth = async (): Promise<Record<string, string>> => ({
		authorization: `Bearer ${await token()}`,
	});
	return {
		async head(branch = repo.branch) {
			const response = await send(http, {
				method: "GET",
				url: `${base}/refs/branches/${encodePath(branch)}`,
				headers: await auth(),
			});
			if (!ok(response)) throw hostFailure(response, "read branch");
			const hash = pick(parseJson(response, "read branch"), "target.hash");
			if (hash === undefined)
				throw new GitopsError(
					"gitops-host-response-invalid",
					"read branch: no target.hash",
				);
			return hash;
		},
		async read(path, ref) {
			const response = await send(http, {
				method: "GET",
				url: `${base}/src/${encodeURIComponent(ref)}/${encodePath(path)}`,
				headers: { ...(await auth()), accept: "text/plain" },
			});
			if (response.status === 404) return undefined;
			if (!ok(response)) throw hostFailure(response, `read ${path}`);
			return { content: response.body };
		},
		async commit({ parent, message, changes, branch = repo.branch }) {
			const form = new URLSearchParams();
			form.set("branch", branch);
			form.set("message", message);
			form.set("parents", parent);
			for (const change of changes) form.set(change.path, change.content);
			const response = await send(http, {
				method: "POST",
				url: `${base}/src`,
				headers: {
					...(await auth()),
					"content-type": "application/x-www-form-urlencoded",
				},
				body: form.toString(),
			});
			if (!ok(response)) throw hostFailure(response, "commit");
			const location =
				Object.entries(response.headers).find(
					([k]) => k.toLowerCase() === "location",
				)?.[1] ?? "";
			const hash = /\/commit\/([0-9a-f]{7,64})$/u.exec(location)?.[1];
			if (hash === undefined)
				throw new GitopsError(
					"gitops-host-response-invalid",
					"commit: no commit hash in Location",
				);
			return hash;
		},
		async createBranch({ name, fromSha }) {
			const response = await send(http, {
				method: "POST",
				url: `${base}/refs/branches`,
				headers: {
					...(await auth()),
					"content-type": "application/json",
				},
				body: JSON.stringify({ name, target: { hash: fromSha } }),
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
				url: `${base}/pullrequests`,
				headers: {
					...(await auth()),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					title,
					description: body,
					source: { branch: { name: headBranch } },
					destination: { branch: { name: baseBranch } },
				}),
			});
			if (!ok(response)) throw hostFailure(response, "open pull request");
			return bitbucketPrInfo(
				parseJson(response, "open pull request"),
				"open pull request",
			);
		},
		async getPullRequest(prId) {
			const response = await send(http, {
				method: "GET",
				url: `${base}/pullrequests/${encodeURIComponent(prId)}`,
				headers: await auth(),
			});
			if (!ok(response)) throw hostFailure(response, "get pull request");
			return bitbucketPrInfo(
				parseJson(response, "get pull request"),
				"get pull request",
			);
		},
		async mergePullRequest({ prId, method = "merge", commitTitle }) {
			const strategy =
				method === "squash"
					? "squash"
					: method === "rebase"
						? "fast_forward"
						: "merge_commit";
			const response = await send(http, {
				method: "POST",
				url: `${base}/pullrequests/${encodeURIComponent(prId)}/merge`,
				headers: {
					...(await auth()),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					merge_strategy: strategy,
					...(commitTitle !== undefined ? { message: commitTitle } : undefined),
				}),
			});
			if (!ok(response)) throw hostFailure(response, "merge pull request");
			const body = parseJson(response, "merge pull request");
			const mergeCommitSha = pick(body, "merge_commit.hash");
			return {
				merged:
					pick(body, "state") === "MERGED" || mergeCommitSha !== undefined,
				...(mergeCommitSha !== undefined ? { mergeCommitSha } : undefined),
			};
		},
	};
}
