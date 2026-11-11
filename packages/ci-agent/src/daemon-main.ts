import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createGithubAppTransport } from "@hobo/ci-gh-actions/cli-serve";
import { parseCiAgentBlock } from "@hobo/ci-gh-actions/project-config";
import { z } from "zod";
import type { AgentTickReport } from "./agent.js";
import {
	createConfiguredEngines,
	environmentCredentials,
} from "./ai-sdk-engine.js";
import { agentPolicies, parseAgentConfig } from "./config.js";
import { createRelayAgent, type RelayConnection } from "./relay.js";
import { parseCommitSigningKey } from "./signing.js";

const REPOSITORY = /^(?!\.)[A-Za-z0-9_.-]+\/(?!\.)[A-Za-z0-9_.-]+$/;
const Installation = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** What the daemon needs from a GitHub App, and nothing more. */
export interface AgentGithubApp {
	/** `GET /repos/{owner}/{name}/installation`, signed as the App. */
	appRequest(path: string): Promise<Response>;
	installationToken(installationId: number): Promise<string>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`missing configuration: ${name}`);
	return value;
}

/**
 * The agent as a process of its own, beside any relay host: the box worker,
 * a container, or a machine next to a relay on Vercel. It needs the GitHub
 * App's credentials and the repositories to watch, not the relay's store.
 *
 * Settings: `HOBO_CI_AGENT_CONFIG` (a `.hobo/ci.json` with an `agent` block),
 * `HOBO_CI_AGENT_DIR` (journal and clones), `HOBO_CI_AGENT_REPOSITORIES`
 * (comma-separated `owner/name`), `HOBO_CI_GITHUB_APP_ID` and
 * `HOBO_CI_GITHUB_APP_KEY_FILE`, and the model credentials the block names.
 * `HOBO_CI_AGENT_INTERVAL_SECONDS` sets the pass interval (60).
 */
export async function startAgentDaemonFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	ports: {
		github?: AgentGithubApp;
		fetch?: typeof fetch;
		remoteUrl?: (repository: string) => string;
		/** Log one line per event; errors never carry repository or model text. */
		log?: (entry: Readonly<Record<string, string | number>>) => void;
	} = {},
) {
	const block = parseCiAgentBlock(
		readFileSync(required(env, "HOBO_CI_AGENT_CONFIG"), "utf8"),
	);
	if (block === undefined)
		throw new Error("HOBO_CI_AGENT_CONFIG has no agent block");
	const config = parseAgentConfig(block);
	const repositories = required(env, "HOBO_CI_AGENT_REPOSITORIES")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (
		repositories.length === 0 ||
		repositories.length > 50 ||
		repositories.some((repository) => !REPOSITORY.test(repository))
	)
		throw new Error("invalid HOBO_CI_AGENT_REPOSITORIES");
	const seconds = Number(env.HOBO_CI_AGENT_INTERVAL_SECONDS ?? "60");
	if (!Number.isInteger(seconds) || seconds < 10 || seconds > 86_400)
		throw new Error("invalid agent interval");
	const credential = environmentCredentials(env);
	const engines = await createConfiguredEngines(config, { credential });
	const signingReference = agentPolicies(config).commit.signingKey;
	const signingText = signingReference
		? credential(signingReference)
		: undefined;
	if (signingReference && !signingText)
		throw new Error(`CI agent credential is not set: ${signingReference}`);
	const github =
		ports.github ??
		createGithubAppTransport({
			appId: required(env, "HOBO_CI_GITHUB_APP_ID"),
			privateKey: readFileSync(
				required(env, "HOBO_CI_GITHUB_APP_KEY_FILE"),
				"utf8",
			),
		});
	const log =
		ports.log ??
		((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));

	// Installation ids are looked up once and kept; a repository the App is not
	// installed on is skipped and looked up again on the next pass.
	const installations = new Map<string, number>();
	async function connections(): Promise<readonly RelayConnection[]> {
		const found: RelayConnection[] = [];
		for (const repository of repositories) {
			let installationId = installations.get(repository);
			if (installationId === undefined) {
				const response = await github
					.appRequest(`/repos/${repository}/installation`)
					.catch(() => undefined);
				const parsed = response?.ok
					? Installation.safeParse(await response.json())
					: undefined;
				if (!parsed?.success) {
					log({ event: "agent.installation_missing", repository });
					continue;
				}
				installationId = parsed.data.id;
				installations.set(repository, installationId);
			}
			found.push({ repository, installationId });
		}
		return found;
	}

	const agent = createRelayAgent({
		config,
		connections,
		token: (installationId) => github.installationToken(installationId),
		stateDirectory: required(env, "HOBO_CI_AGENT_DIR"),
		engines,
		signingKey: signingText ? parseCommitSigningKey(signingText) : undefined,
		intervalMs: seconds * 1000,
		fetch: ports.fetch,
		remoteUrl: ports.remoteUrl,
	});

	let pass: Promise<void> | undefined;
	let stopped = false;
	async function once(): Promise<readonly AgentTickReport[]> {
		const reports = await agent.pass();
		for (const report of reports)
			log({
				event: "agent.pass",
				resolutions: report.resolutions.length,
				enqueued: report.enqueued.length,
				ejected: report.ejected.length,
				failures: report.failures,
			});
		return reports;
	}
	function tick() {
		if (stopped || pass) return;
		pass = once()
			.then(() => undefined)
			.catch(() => log({ event: "agent.pass_failed" }))
			.finally(() => {
				pass = undefined;
			});
	}
	let timer: ReturnType<typeof setInterval> | undefined;
	return {
		/** One pass now, for an acceptance run or a test. */
		once,
		start() {
			timer = setInterval(tick, seconds * 1000);
			tick();
			log({ event: "agent.started", repositories: repositories.length });
		},
		/** Stop scheduling, wait for a pass in flight, close the journal. */
		async stop() {
			stopped = true;
			clearInterval(timer);
			await pass;
			agent.close();
			log({ event: "agent.stopped" });
		},
	};
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	const once = process.argv.includes("--once");
	startAgentDaemonFromEnvironment()
		.then(async (daemon) => {
			if (once) {
				// An acceptance run: one pass, its reports on stdout, then exit.
				const reports = await daemon.once();
				process.stdout.write(
					`${JSON.stringify({ reports: reports.length })}\n`,
				);
				await daemon.stop();
				return;
			}
			daemon.start();
			const stop = () => {
				void daemon.stop().then(() => process.exit(0));
			};
			process.once("SIGTERM", stop);
			process.once("SIGINT", stop);
		})
		.catch((error) => {
			process.stderr.write(
				`HoBo CI agent could not start: ${error instanceof Error ? error.message : "unknown error"}\n`,
			);
			process.exitCode = 1;
		});
}
