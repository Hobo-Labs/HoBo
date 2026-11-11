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
	/** The syntax-aware merge tried before any engine; see `resolution.structuredMerge`. */
	structured?: StructuredMerger | undefined;
	/** Signs every commit the agent writes; see `commit.signingKey`. */
	signingKey?: CommitSigningKey | undefined;
	intervalMs?: number;
	fetch?: typeof fetch | undefined;
	git?: string;
	/** Where a repository is fetched from and pushed to; GitHub over HTTPS by default. */
	remoteUrl?: ((repository: string) => string) | undefined;
	now?: () => string;
}) {
	mkdirSync(join(options.stateDirectory, "repositories"), { recursive: true });
	const journal = createSqliteJournal(
		join(options.stateDirectory, "agent.sqlite"),
	);
	/** One agent per repository, rebuilt when its installation or default branch changes. */
	const agents = new Map<string, { identity: string; agent: CiAgent }>();
	const run = promisify(execFile);

	async function agentFor(connection: RelayConnection): Promise<CiAgent> {
		const { repository, installationId } = connection;
		if (!REPOSITORY.test(repository))
			throw new Error("invalid repository name");
		const token = () => options.token(installationId);
		const graphql = createGithubGraphql({ token, fetch: options.fetch });
		// Read every pass: a repository can rename its default branch.
		const baseRef = await githubDefaultBranch(graphql, repository);
		const identity = `${installationId}@${baseRef}`;
		const existing = agents.get(repository);
		if (existing?.identity === identity) return existing.agent;
		const directory = join(
			options.stateDirectory,
			"repositories",
			`${repository.replace("/", "__")}.git`,
		);
		// Both steps are idempotent, so a setup cut short is finished next time.
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
