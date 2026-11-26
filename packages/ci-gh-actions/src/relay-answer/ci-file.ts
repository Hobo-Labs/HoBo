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

export const RELAY_CONFIG_PATH = ".hobo/ci.json";

const Contents = z.object({
	content: z.string(),
	encoding: z.literal("base64"),
});

export const RelayJobsSettingsSchema = z
	.object({
		answer: z.boolean().optional(),
		label: z.string().trim().min(1).max(100).optional(),
	})
	.strict();

const RelayJobsBlock = z.looseObject({
	relayJobs: RelayJobsSettingsSchema.optional(),
});

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

export function pullRequestOfRef(ref: string | undefined): number | undefined {
	const match = /^refs\/pull\/(\d+)\//u.exec(ref ?? "");
	const number = Number(match?.[1]);
	return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

const PullRequest = z.object({ base: z.object({ ref: z.string().min(1) }) });

export class GithubCiFile {
	constructor(
		private readonly github: GithubTransport,
		private readonly installationId: number,
	) {}

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
		return {
			order: committed.order ?? DEFAULT_RUNNER_ORDER,
			problem: committed.problem,
		};
	}
}
