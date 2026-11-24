import { type RelayJobMessage, workflowGitRef } from "@hobo/ci";
import { z } from "zod";
import { type GithubTransport, githubApiUrl } from "../github.js";
import { GithubCiFile, pullRequestOfRef } from "../relay-answer/ci-file.js";

export const LINT_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
export const LINT_ARCHIVE_TIMEOUT_MS = 3 * 60_000;
// public-contract: the one host GitHub sends archive downloads to; a redirect elsewhere is refused.
export const ARCHIVE_DOWNLOAD_HOST = "codeload.github.com";

export type RelayArchiveAccess = Readonly<{
	installationToken: (installationId: number) => Promise<string>;
	fetch?: typeof fetch | undefined;
	timeoutMs?: number | undefined;
}>;

export type RelayCheckPullRequest = Readonly<{ number: number; title: string }>;

export interface RelayCheckSource {
	ciFile(message: RelayJobMessage): Promise<string | undefined>;
	pullRequest(
		message: RelayJobMessage,
	): Promise<RelayCheckPullRequest | undefined>;
	commit(message: RelayJobMessage): Promise<string>;
	archive(message: RelayJobMessage, commit: string): Promise<Uint8Array>;
}

const Run = z.object({
	head_sha: z.string().regex(/^[0-9a-f]{40}$/u),
	head_branch: z.string().nullish(),
	head_repository: z
		.object({ owner: z.object({ login: z.string().min(1) }) })
		.nullish(),
	pull_requests: z
		.array(z.object({ number: z.number().int().positive() }))
		.default([]),
});
const PullRequest = z.object({
	number: z.number().int().positive(),
	title: z.string(),
});
const OpenPulls = z.array(
	z.object({
		number: z.number().int().positive(),
		title: z.string(),
		head: z.object({ sha: z.string() }),
	}),
);

export class GithubRelayCheckSource implements RelayCheckSource {
	constructor(
		private readonly github: GithubTransport,
		private readonly installationFor: (
			repository: string,
		) => Promise<number | undefined>,
		private readonly archives: RelayArchiveAccess,
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
		const number = pullRequestOfRef(workflowGitRef(message.workflowRef));
		if (number !== undefined) {
			const pull = await this.json(
				message.repository,
				`/repos/${message.repository}/pulls/${number}`,
				PullRequest,
				`pull request ${number}`,
			);
			return { number: pull.number, title: pull.title };
		}
		const run = await this.run(message);
		const owner = run.head_repository?.owner.login;
		if (!run.head_branch || !owner) return undefined;
		const head = encodeURIComponent(`${owner}:${run.head_branch}`);
		const pulls = (
			await this.json(
				message.repository,
				`/repos/${message.repository}/pulls?state=open&head=${head}&per_page=100`,
				OpenPulls,
				`the open pull requests from ${owner}:${run.head_branch}`,
			)
		).filter((pull) => pull.head.sha === run.head_sha);
		const named = new Set(run.pull_requests.map((pull) => pull.number));
		const pull =
			pulls.find((candidate) => named.has(candidate.number)) ?? pulls[0];
		return pull === undefined
			? undefined
			: { number: pull.number, title: pull.title };
	}

	async commit(message: RelayJobMessage): Promise<string> {
		return (await this.run(message)).head_sha;
	}

	async archive(message: RelayJobMessage, commit: string): Promise<Uint8Array> {
		const where = `the archive of ${message.repository} at ${commit}`;
		const send = this.archives.fetch ?? fetch;
		const token = await this.archives.installationToken(
			await this.installation(message.repository),
		);
		const api = await send(
			githubApiUrl(`/repos/${message.repository}/tarball/${commit}`),
			{
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
				},
				redirect: "manual",
				signal: AbortSignal.timeout(15_000),
			},
		);
		await api.body?.cancel();
		if (api.status < 300 || api.status > 399)
			throw new Error(`GitHub refused ${where} (${api.status})`);
		const location = archiveLocation(api.headers.get("location"));
		if (location === undefined)
			throw new Error(
				`GitHub sent ${where} somewhere other than https://${ARCHIVE_DOWNLOAD_HOST}`,
			);
		const download = await send(location, {
			redirect: "error",
			signal: AbortSignal.timeout(
				this.archives.timeoutMs ?? LINT_ARCHIVE_TIMEOUT_MS,
			),
		});
		if (!download.ok) {
			await download.body?.cancel();
			throw new Error(`${where} could not be downloaded (${download.status})`);
		}
		return readCapped(download, LINT_MAX_ARCHIVE_BYTES, where);
	}
}

export function archiveLocation(location: string | null): string | undefined {
	if (!location) return undefined;
	let url: URL;
	try {
		url = new URL(location);
	} catch {
		return undefined;
	}
	return url.protocol === "https:" &&
		url.hostname === ARCHIVE_DOWNLOAD_HOST &&
		url.port === "" &&
		!url.username &&
		!url.password
		? url.href
		: undefined;
}

export async function readCapped(
	response: Response,
	max: number,
	what: string,
): Promise<Uint8Array> {
	const tooLarge = () =>
		new Error(`${what} is larger than ${max / 1024 / 1024} MiB`);
	if (Number(response.headers.get("content-length") ?? "0") > max) {
		await response.body?.cancel();
		throw tooLarge();
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			throw tooLarge();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
}
