// The Git host seam: just enough of a host's HTTP API to read a branch head,
// read a file at a commit, and make one commit with several files on top of
// a known parent. No Git binary, no clone.

export type FileChange = Readonly<{
	path: string;
	content: string;
	/** Whether the file already exists at the parent commit. */
	exists: boolean;
	/** Host blob id of the existing file, when the host needs it (Gitea). */
	blobId?: string;
}>;

export type RemoteFile = Readonly<{ content: string; blobId?: string }>;

export interface GitHostClient {
	/** Commit id the branch points at. */
	head(): Promise<string>;
	/** File content at a commit, or undefined when absent. */
	read(path: string, ref: string): Promise<RemoteFile | undefined>;
	/**
	 * One commit on top of `parent` that writes every change, advancing the
	 * branch only if it still points at `parent` (else `gitops-host-conflict`).
	 */
	commit(
		input: Readonly<{
			parent: string;
			message: string;
			changes: readonly FileChange[];
		}>,
	): Promise<string>;
}

// public-contract: credential scope for Git host tokens.
export const GIT_CREDENTIAL_SCOPE = "cd.gitops.git" as const;
