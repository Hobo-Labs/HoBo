/**
 * What a runner-less check reads of GitHub (ADR-0183): the `.hobo/ci.json`
 * that governs the run, the run's pull request and its title, the run's head
 * commit and that commit's archive. Nothing else: no log, no secret.
 *
 * `RelayCheckSource` is the port; `GithubRelayCheckSource` reads it through
 * the App installation that serves the repository. The relay job message
 * carries no token of the job's own (`RelayJobMessage`, `relay_job.proto`),
 * so the archive is read with the installation's `contents: read`.
 */
import { type RelayJobMessage, workflowGitRef } from "@hobo/ci";
import { z } from "zod";
import type { GithubTransport } from "../github.js";
import { GithubCiFile, pullRequestOfRef } from "../relay-answer/ci-file.js";

/** The largest commit archive a lint check reads: 200 MiB. */
export const LINT_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

export type RelayCheckPullRequest = Readonly<{ number: number; title: string }>;

export interface RelayCheckSource {
	/** `.hobo/ci.json` at the branch that governs the run; undefined when absent. Throws when unreadable. */
	ciFile(message: RelayJobMessage): Promise<string | undefined>;
	/** The run's pull request; undefined when the run has none. Throws when unreadable. */
	pullRequest(
		message: RelayJobMessage,
	): Promise<RelayCheckPullRequest | undefined>;
	/** The commit the run tests. Throws when unreadable. */
	commit(message: RelayJobMessage): Promise<string>;
	/** That commit as a gzipped tarball. Throws when unreadable or too large. */
	archive(message: RelayJobMessage, commit: string): Promise<Uint8Array>;
}

const Run = z.object({
	head_sha: z.string().regex(/^[0-9a-f]{40}$/u),
	pull_requests: z
		.array(z.object({ number: z.number().int().positive() }))
		.default([]),
});
const PullRequest = z.object({
	number: z.number().int().positive(),
	title: z.string(),
});

/** Reads what a check needs through the installation that serves the repository. */
export class GithubRelayCheckSource implements RelayCheckSource {
	constructor(
		private readonly github: GithubTransport,
		/** The App installation that serves a repository, or undefined. */
		private readonly installationFor: (
			repository: string,
		) => Promise<number | undefined>,
	) {}

	private async installation(repository: string): Promise<number> {
		const id = await this.installationFor(repository);
		if (id === undefined)
			throw new Error(`no GitHub App installation serves ${repository}`);
		return id;
	}

	private async json<T>(
		repository: string,
		path: string,
		schema: z.ZodType<T>,
		what: string,
	): Promise<T> {
		const response = await this.github.request(
			await this.installation(repository),
			path,
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(
				`GitHub refused to read ${what} of ${repository} (${response.status})`,
			);
		}
		const parsed = schema.safeParse(await response.json());
		if (!parsed.success)
			throw new Error(`GitHub's ${what} of ${repository} could not be read`);
		return parsed.data;
	}

	async ciFile(message: RelayJobMessage): Promise<string | undefined> {
		const file = new GithubCiFile(
			this.github,
			await this.installation(message.repository),
		);
		const branch = await file.governingBranch(
			message.repository,
			workflowGitRef(message.workflowRef),
		);
		return file.read(message.repository, branch);
	}

	private run(message: RelayJobMessage): Promise<z.infer<typeof Run>> {
		return this.json(
			message.repository,
			`/repos/${message.repository}/actions/runs/${message.runId}`,
			Run,
			`run ${message.runId}`,
		);
	}

	async pullRequest(
		message: RelayJobMessage,
	): Promise<RelayCheckPullRequest | undefined> {
		const number =
			pullRequestOfRef(workflowGitRef(message.workflowRef)) ??
			(await this.run(message)).pull_requests[0]?.number;
		if (number === undefined) return undefined;
		const pull = await this.json(
			message.repository,
			`/repos/${message.repository}/pulls/${number}`,
			PullRequest,
			`pull request ${number}`,
		);
		return { number: pull.number, title: pull.title };
	}

	async commit(message: RelayJobMessage): Promise<string> {
		return (await this.run(message)).head_sha;
	}

	async archive(message: RelayJobMessage, commit: string): Promise<Uint8Array> {
		const response = await this.github.request(
			await this.installation(message.repository),
			`/repos/${message.repository}/tarball/${commit}`,
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(
				`GitHub refused the archive of ${message.repository} at ${commit} (${response.status})`,
			);
		}
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (declared > LINT_MAX_ARCHIVE_BYTES) {
			await response.body?.cancel();
			throw new Error(
				`the archive of ${message.repository} at ${commit} is larger than ${LINT_MAX_ARCHIVE_BYTES / 1024 / 1024} MiB`,
			);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > LINT_MAX_ARCHIVE_BYTES)
			throw new Error(
				`the archive of ${message.repository} at ${commit} is larger than ${LINT_MAX_ARCHIVE_BYTES / 1024 / 1024} MiB`,
			);
		return bytes;
	}
}
