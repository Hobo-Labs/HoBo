import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentTickReport, type CiAgent, createCiAgent } from "./agent.js";
import type { ParsedAgentConfig } from "./config.js";
import { agentPolicies } from "./config.js";
import { createGitWorkspace } from "./git-workspace.js";
import {
	createGithubGraphql,
	createGithubQueue,
	githubDefaultBranch,
} from "./github-queue.js";
import type { ResolutionEngine } from "./resolver.js";
import type { CommitSigningKey } from "./signing.js";
import { createSqliteJournal } from "./sqlite-journal.js";
import type { StructuredMerger } from "./structured-merge.js";

const REPOSITORY = /^(?!\.)[A-Za-z0-9_.-]+\/(?!\.)[A-Za-z0-9_.-]+$/;

export type RelayConnection = Readonly<{
	installationId: number;
	repository: string;
}>;

export function createRelayAgent(options: {
	config: ParsedAgentConfig;
	connections: () => Promise<readonly RelayConnection[]>;
	token: (installationId: number) => Promise<string>;
	stateDirectory: string;
	engines: readonly ResolutionEngine[];
	structured?: StructuredMerger | undefined;
	signingKey?: CommitSigningKey | undefined;
	intervalMs?: number;
	fetch?: typeof fetch | undefined;
	git?: string;
	remoteUrl?: ((repository: string) => string) | undefined;
	now?: () => string;
	onReport?: ((report: AgentTickReport) => void) | undefined;
}) {
	mkdirSync(join(options.stateDirectory, "repositories"), { recursive: true });
	const journal = createSqliteJournal(
		join(options.stateDirectory, "agent.sqlite"),
	);
	const agents = new Map<string, { identity: string; agent: CiAgent }>();
	const run = promisify(execFile);

	async function agentFor(connection: RelayConnection): Promise<CiAgent> {
		const { repository, installationId } = connection;
		if (!REPOSITORY.test(repository))
			throw new Error("invalid repository name");
		const token = () => options.token(installationId);
		const graphql = createGithubGraphql({ token, fetch: options.fetch });
		const baseRef = await githubDefaultBranch(graphql, repository);
		const identity = `${installationId}@${baseRef}`;
		const existing = agents.get(repository);
		if (existing?.identity === identity) return existing.agent;
		const directory = join(
			options.stateDirectory,
			"repositories",
			`${repository.replace("/", "__")}.git`,
		);
		const git = options.git ?? "git";
		await run(git, ["init", "--quiet", "--bare", directory]);
		await run(
			git,
			[
				"config",
				"remote.origin.url",
				options.remoteUrl?.(repository) ??
					`https://github.com/${repository}.git`,
			],
			{ cwd: directory },
		);
		const queue = createGithubQueue({
			repository,
			baseRef,
			label: agentPolicies(options.config).queue.label,
			graphql,
			now: options.now,
		});
		const agent = createCiAgent({
			config: options.config,
			queue,
			publisher: queue,
			workspace: createGitWorkspace({
				directory,
				auth: token,
				git: options.git,
				identity: agentPolicies(options.config).commit,
				signer: options.signingKey,
			}),
			engines: options.engines,
			structured: options.structured,
			journal,
			now: options.now,
		});
		agents.set(repository, { identity, agent });
		return agent;
	}

	async function pass(): Promise<readonly AgentTickReport[]> {
		const reports: AgentTickReport[] = [];
		let failed = 0;
		for (const connection of await options.connections())
			try {
				const report = await (await agentFor(connection)).tick();
				reports.push(report);
				options.onReport?.(report);
			} catch {
				failed++;
			}
		if (failed > 0)
			throw new Error(`CI agent failed for ${failed} repositories`);
		return reports;
	}

	return {
		intervalMs: options.intervalMs ?? 60_000,
		journal,
		pass,
		async tick(): Promise<void> {
			await pass();
		},
		close() {
			journal.close();
		},
	};
}

export function reportLogEntries(
	report: AgentTickReport,
): readonly Readonly<Record<string, string | number>>[] {
	return [
		{
			event: "agent.pass",
			resolutions: report.resolutions.length,
			enqueued: report.enqueued.length,
			ejected: report.ejected.length,
			failures: report.failures,
		},
		...report.engineFailures.map((failure) => ({
			event: "agent.engine_failed",
			engine: failure.engineId,
			reason: failure.reason,
			status: failure.status,
		})),
	];
}
