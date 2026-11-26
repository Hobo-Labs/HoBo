import type { HttpTransport } from "@hobo/core";
import { GitHost, type GitRepositoryRecord } from "../_generated/gitops_pb.js";
import { GitopsError } from "../errors.js";
import { createBitbucketClient } from "./bitbucket.js";
import { createGiteaClient } from "./gitea.js";
import { createGitHubClient } from "./github.js";
import { createGitLabClient } from "./gitlab.js";
import type { GitHostClient } from "./types.js";

export { createBitbucketClient } from "./bitbucket.js";
export { createGiteaClient } from "./gitea.js";
export { createGitHubClient } from "./github.js";
export { createGitLabClient } from "./gitlab.js";
export {
	type FileChange,
	GIT_CREDENTIAL_SCOPE,
	type GitHostClient,
	type RemoteFile,
} from "./types.js";

export function createGitHostClient(
	repo: GitRepositoryRecord,
	http: HttpTransport,
	token: () => Promise<string>,
): GitHostClient {
	switch (repo.host) {
		case GitHost.GITHUB:
			return createGitHubClient(repo, http, token);
		case GitHost.GITLAB:
			return createGitLabClient(repo, http, token);
		case GitHost.GITEA:
			return createGiteaClient(repo, http, token);
		case GitHost.BITBUCKET:
			return createBitbucketClient(repo, http, token);
		default:
			throw new GitopsError(
				"gitops-config-invalid",
				"repository.host is not a supported Git host",
			);
	}
}
