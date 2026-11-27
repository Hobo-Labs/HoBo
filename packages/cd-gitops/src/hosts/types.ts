export type FileChange = Readonly<{
	path: string;
	content: string;
	exists: boolean;
	blobId?: string;
}>;

export type RemoteFile = Readonly<{ content: string; blobId?: string }>;

export type PullRequestState = "open" | "merged" | "closed";

export type PullRequestMergeMethod = "merge" | "squash" | "rebase";

export type PullRequestInfo = Readonly<{
	id: string;
	url: string;
	state: PullRequestState;
	headBranch: string;
	baseBranch: string;
	mergeCommitSha?: string;
}>;

export interface GitHostClient {
	head(branch?: string): Promise<string>;
	read(path: string, ref: string): Promise<RemoteFile | undefined>;
	commit(
		input: Readonly<{
			parent: string;
			message: string;
			changes: readonly FileChange[];
			branch?: string;
		}>,
	): Promise<string>;
	createBranch(
		input: Readonly<{
			name: string;
			fromSha: string;
		}>,
	): Promise<void>;
	openPullRequest(
		input: Readonly<{
			headBranch: string;
			baseBranch?: string;
			title: string;
			body: string;
		}>,
	): Promise<PullRequestInfo>;
	getPullRequest(prId: string): Promise<PullRequestInfo>;
	mergePullRequest(
		input: Readonly<{
			prId: string;
			method?: PullRequestMergeMethod;
			commitTitle?: string;
		}>,
	): Promise<Readonly<{ merged: boolean; mergeCommitSha?: string }>>;
}

export const GIT_CREDENTIAL_SCOPE = "cd.gitops.git" as const;
