import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	createGithubAppTransport,
	startRelayFromEnvironment,
} from "@hobo/ci-gh-actions/cli-serve";
import { parseCiAgentBlock } from "@hobo/ci-gh-actions/project-config";
import {
	createConfiguredEngines,
	environmentCredentials,
} from "./ai-sdk-engine.js";
import { agentPolicies, parseAgentConfig } from "./config.js";
import { createRelayAgent, reportLogEntries } from "./relay.js";
import { parseCommitSigningKey } from "./signing.js";
import { configuredStructuredMerger } from "./structured-merge.js";

/**
 * Start the relay's Node host with the agent beside it.
 *
 * This is the relay's own `HOBO_CI_*` startup plus two settings:
 * `HOBO_CI_AGENT_CONFIG`, a `.hobo/ci.json` whose `agent` block configures
 * the agent, and `HOBO_CI_AGENT_DIR`, a directory the agent may write its
 * journal and clones to. Without `HOBO_CI_AGENT_CONFIG`, or when that file
 * has no `agent` block, the relay starts exactly as it does without this
 * package. `HOBO_CI_AGENT_INTERVAL_SECONDS` sets the pass interval
 * (60 by default).
 *
 * Model credentials are read from this process's environment by the names
 * the block references; a referenced name that is not set stops startup.
 */
export async function startRelayWithAgentFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): Promise<Awaited<ReturnType<typeof startRelayFromEnvironment>>> {
	const path = env.HOBO_CI_AGENT_CONFIG;
	const block = path
		? parseCiAgentBlock(readFileSync(path, "utf8"))
		: undefined;
	if (block === undefined) return startRelayFromEnvironment(env);
	const stateDirectory = env.HOBO_CI_AGENT_DIR;
	if (!stateDirectory)
		throw new Error("missing configuration: HOBO_CI_AGENT_DIR");
	const seconds = Number(env.HOBO_CI_AGENT_INTERVAL_SECONDS ?? "60");
	if (!Number.isInteger(seconds) || seconds < 10 || seconds > 86_400)
		throw new Error("invalid agent interval");
	const config = parseAgentConfig(block);
	const credential = environmentCredentials(env);
	const engines = await createConfiguredEngines(config, { credential });
	const structured = await configuredStructuredMerger(config);
	const signingReference = agentPolicies(config).commit.signingKey;
	const signingText = signingReference
		? credential(signingReference)
		: undefined;
	if (signingReference && !signingText)
		throw new Error(`CI agent credential is not set: ${signingReference}`);
	const signingKey = signingText
		? parseCommitSigningKey(signingText)
		: undefined;
	const appId = env.HOBO_CI_GITHUB_APP_ID;
	const keyFile = env.HOBO_CI_GITHUB_APP_KEY_FILE;
	if (!appId || !keyFile)
		throw new Error("missing configuration: HOBO_CI_GITHUB_APP_ID");
	const github = createGithubAppTransport({
		appId,
		privateKey: readFileSync(keyFile, "utf8"),
	});
	let close = () => {};
	const running = await startRelayFromEnvironment(env, {
		github,
		agent: ({ connections }) => {
			const agent = createRelayAgent({
				config,
				connections,
				token: (installationId) => github.installationToken(installationId),
				stateDirectory,
				engines,
				structured,
				signingKey,
				intervalMs: seconds * 1000,
				onReport: (report) => {
					for (const entry of reportLogEntries(report))
						process.stdout.write(
							`${JSON.stringify({ level: "info", ...entry })}\n`,
						);
				},
			});
			close = () => agent.close();
			return agent;
		},
	}).catch((error) => {
		// The relay failed to start after the agent opened its journal.
		close();
		throw error;
	});
	return {
		...running,
		async stop() {
			const result = await running.stop();
			// A pass still running after the drain timed out owns the journal.
			if (result.drained) close();
			return result;
		},
	};
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	startRelayWithAgentFromEnvironment()
		.then((running) => {
			const stop = () => {
				void running
					.stop()
					.then((result) => {
						if (!result.drained) process.exit(1);
					})
					.catch(() => process.exit(1));
			};
			process.once("SIGTERM", stop);
			process.once("SIGINT", stop);
		})
		.catch(() => {
			process.stderr.write(
				"HoBo CI service could not start; check secret bindings, database ownership, the agent block and its named credentials.\n",
			);
			process.exitCode = 1;
		});
}
