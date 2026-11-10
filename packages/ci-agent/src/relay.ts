import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
import { createSqliteJournal } from "./sqlite-journal.js";

const REPOSITORY = /^(?!\.)[A-Za-z0-9_.-]+\/(?!\.)[A-Za-z0-9_.-]+$/;

/** A repository the relay is connected to, as its configuration names it. */
export type RelayConnection = Readonly<{
	installationId: number;
	repository: string;
}>;

/**
 * The agent as the relay runs it: one agent per connected repository, all
 * writing one journal. `stateDirectory` holds that journal and a bare clone
 * per repository; it is the only thing the agent keeps, and it can be
 * deleted to start over (which forgets attempts and today's spend).
 *
 * A repository that fails does not stop the others; the pass then rejects,
 * which the relay logs as a failed agent pass and nothing more.
 */
export function createRelayAgent(options: {
	config: ParsedAgentConfig;
	connections: () => Promise<readonly RelayConnection[]>;
	/** A short-lived installation token; asked for whenever one is needed. */
	token: (installationId: number) => Promise<string>;
	stateDirectory: string;
	engines: readonly ResolutionEngine[];
	intervalMs?: number;
	fetch?: typeof fetch;
	git?: string;
	/** Where a repository is fetched from and pushed to; GitHub over HTTPS by default. */
	remoteUrl?: (repository: string) => string;
	now?: () => string;
}) {
	mkdirSync(join(options.stateDirectory, "repositories"), { recursive: true });
	const journal = createSqliteJournal(
		join(options.stateDirectory, "agent.sqlite"),
	);
	const agents = new Map<string, CiAgent>();
	const run = promisify(execFile);

	async function agentFor(connection: RelayConnection): Promise<CiAgent> {
		const { repository, installationId } = connection;
		const existing = agents.get(repository);
		if (existing) return existing;
		if (!REPOSITORY.test(repository))
			throw new Error("invalid repository name");
		const token = () => options.token(installationId);
		const directory = join(
			options.stateDirectory,
			"repositories",
			`${repository.replace("/", "__")}.git`,
		);
		if (!existsSync(directory)) {
			const git = options.git ?? "git";
			await run(git, ["init", "--quiet", "--bare", directory]);
			await run(
				git,
				[
					"remote",
					"add",
					"origin",
					options.remoteUrl?.(repository) ??
						`https://github.com/${repository}.git`,
				],
				{ cwd: directory },
			);
		}
		const graphql = createGithubGraphql({ token, fetch: options.fetch });
		const queue = createGithubQueue({
			repository,
			baseRef: await githubDefaultBranch(graphql, repository),
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
			}),
			engines: options.engines,
			journal,
			now: options.now,
		});
		agents.set(repository, agent);
		return agent;
	}

	/** One pass over every connected repository, with each repository's report. */
	async function pass(): Promise<readonly AgentTickReport[]> {
		const reports: AgentTickReport[] = [];
		let failed = 0;
		for (const connection of await options.connections())
			try {
				reports.push(await (await agentFor(connection)).tick());
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
		/** `pass` as the relay schedules it. */
		async tick(): Promise<void> {
			await pass();
		},
		close() {
			journal.close();
		},
	};
}
