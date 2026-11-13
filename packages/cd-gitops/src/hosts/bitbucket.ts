// Bitbucket Cloud REST adapter (2.0): multi-file commit through /src.
//   head   GET  /repositories/{ws}/{repo}/refs/branches/{branch}
//   read   GET  /repositories/{ws}/{repo}/src/{sha}/{path}           (raw)
//   commit POST /repositories/{ws}/{repo}/src  (form: branch, message,
//          parents, <path>=<content>…) → 201, Location …/commit/{hash}
// `parents` makes Bitbucket refuse the commit if the branch moved.

import type { HttpTransport } from "@hobo/core";
import type { GitRepositoryRecord } from "../_generated/gitops_pb.js";
import { GitopsError } from "../errors.js";
import { encodePath, hostFailure, ok, parseJson, pick, send } from "../http.js";
import type { GitHostClient } from "./types.js";

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
		async head() {
			const response = await send(http, {
				method: "GET",
				url: `${base}/refs/branches/${encodePath(repo.branch)}`,
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
		async commit({ parent, message, changes }) {
			const form = new URLSearchParams();
			form.set("branch", repo.branch);
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
	};
}
