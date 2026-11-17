/**
 * What relay mode reads of a repository: `.hobo/ci.json` and nothing else
 * (ADR-0183). It is read through the contents API at the default branch, or
 * at a pull request's base branch, never at the commit a run is testing, so a
 * branch cannot change how its own jobs are routed or turn relay mode on for
 * itself.
 *
 * Two blocks of the file matter here: `relayJobs` (whether a relay answers
 * the repository's relay jobs at all, and the label it answers) and
 * `runnerOrder` (the order `answerRelayJob` walks).
 */
import {
	DEFAULT_RELAY_JOBS,
	DEFAULT_RUNNER_ORDER,
	type RelayJobsConfig,
	type RunnerOrderLookup,
	type RunnerOrderSource,
} from "@hobo/ci";
import { z } from "zod";
import type { GithubTransport } from "../github.js";
import { parseCiRunnerOrder } from "../runner-order-config.js";

// public-contract: the one file relay mode reads from a repository.
export const RELAY_CONFIG_PATH = ".hobo/ci.json";

const Contents = z.object({
	content: z.string(),
	encoding: z.literal("base64"),
});

/** The `relayJobs` block of `.hobo/ci.json`; the project schema accepts the same shape. */
export const RelayJobsSettingsSchema = z
	.object({
		answer: z.boolean().optional(),
		label: z.string().trim().min(1).max(100).optional(),
	})
	.strict();

const RelayJobsBlock = z.looseObject({
	relayJobs: RelayJobsSettingsSchema.optional(),
});

/**
 * The `relayJobs` block of `.hobo/ci.json`. A file that does not parse, or a
 * block that is malformed, leaves relay mode off: answering is opt-in.
 */
export function parseRelayJobs(json: string | undefined): RelayJobsConfig {
	if (json === undefined) return DEFAULT_RELAY_JOBS;
	let value: z.infer<ReturnType<typeof z.json>>;
	try {
		value = z.json().parse(JSON.parse(json));
	} catch {
		return DEFAULT_RELAY_JOBS;
	}
	const block = RelayJobsBlock.safeParse(value);
	if (!block.success || !block.data.relayJobs) return DEFAULT_RELAY_JOBS;
	return Object.freeze({
		answer: block.data.relayJobs.answer ?? DEFAULT_RELAY_JOBS.answer,
		label: block.data.relayJobs.label ?? DEFAULT_RELAY_JOBS.label,
	});
}

/** The pull request number a `refs/pull/<n>/...` ref names, if it names one. */
export function pullRequestOfRef(ref: string | undefined): number | undefined {
	const match = /^refs\/pull\/(\d+)\//u.exec(ref ?? "");
	const number = Number(match?.[1]);
	return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

const PullRequest = z.object({ base: z.object({ ref: z.string().min(1) }) });

/**
 * Reads `.hobo/ci.json` of repositories one installation can see. A file
 * that is not there reads as undefined; a read GitHub refuses throws.
 */
export class GithubCiFile {
	constructor(
		private readonly github: GithubTransport,
		private readonly installationId: number,
	) {}

	/** The file at `branch`, or at the default branch when undefined. */
	async read(
		repository: string,
		branch: string | undefined,
	): Promise<string | undefined> {
		const query =
			branch === undefined ? "" : `?ref=${encodeURIComponent(branch)}`;
		const response = await this.github.request(
			this.installationId,
			`/repos/${repository}/contents/${encodeURIComponent(RELAY_CONFIG_PATH)}${query}`,
		);
		if (response.status === 404) return undefined;
		if (!response.ok)
			throw new Error(
				`GitHub refused to read ${RELAY_CONFIG_PATH} of ${repository} (${response.status})`,
			);
		const payload = Contents.parse(await response.json());
		return Buffer.from(payload.content, "base64").toString("utf8");
	}

	/**
	 * The branch whose `.hobo/ci.json` governs a run at `ref`: a pull request's
	 * base branch, or undefined (the default branch) for anything else or when
	 * the pull request cannot be read.
	 */
	async governingBranch(
		repository: string,
		ref: string | undefined,
	): Promise<string | undefined> {
		const number = pullRequestOfRef(ref);
		if (number === undefined) return undefined;
		try {
			const response = await this.github.request(
				this.installationId,
				`/repos/${repository}/pulls/${number}`,
			);
			if (!response.ok) return undefined;
			const pull = PullRequest.safeParse(await response.json());
			return pull.success ? pull.data.base.ref : undefined;
		} catch {
			return undefined;
		}
	}
}

/**
 * The runner order a relay walks: `runnerOrder` from `.hobo/ci.json` at the
 * default branch or a pull request's base branch. A file that cannot be read
 * is a problem sentence, so the relay job fails with it instead of routing on
 * an order nobody committed.
 */
export class GithubCiOrderSource implements RunnerOrderSource {
	constructor(private readonly file: GithubCiFile) {}

	async order(
		repository: string,
		ref: string | undefined,
	): Promise<RunnerOrderLookup> {
		let text: string | undefined;
		try {
			const branch = await this.file.governingBranch(repository, ref);
			text = await this.file.read(repository, branch);
		} catch (error) {
			return {
				order: DEFAULT_RUNNER_ORDER,
				problem: `the runner order could not be read: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const committed = parseCiRunnerOrder(text ?? "{}");
		return { order: committed.order, problem: committed.problem };
	}
}
