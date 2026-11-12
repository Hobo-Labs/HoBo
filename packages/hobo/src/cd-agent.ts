/**
 * Which realizer `hobo deploy agent run` registers on its host (plan 0024).
 *
 * In order: `--simulate` (the labelled fixture), a runner host
 * (HOBO_CD_RUNNER_HOST names its agent config: the runner-host realizer,
 * `cd-agent-runner-host.ts`), a Kubernetes fleet manager (HOBO_CD_KUBE_FLEET).
 * With none of them the run is refused `compose-realizer-missing`.
 *
 * On a runner host the container port is the engine CLI and the job ports
 * are read from the box worker's data directory (`createWorkerHostJobs`:
 * its journal read-only, the advert it writes, the admission marker it
 * honours). A host kind those cannot serve (a `local-runner`'s runner
 * presence) is refused `runner-host-interface-missing`, naming each missing
 * port method, before any loop starts. Nothing is faked to get past it.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	type CampId,
	type Outcome,
	type Realizer,
	ReasonRecordSchema,
} from "@hobo/cd";
import type { RunnerHostPorts } from "@hobo/ci-gh-actions/runner-host";
import {
	CD_RUNNER_HOST_ENV,
	parseRunnerHostAgentConfig,
} from "./cd-agent-runner-host.js";
import type { JsonValue } from "./json.js";

function refusal(code: string, message: string, remediation: string) {
	return {
		ok: false as const,
		reasons: [create(ReasonRecordSchema, { code, message, remediation })],
	};
}

export type AgentRealizerInput = Readonly<{
	simulate: boolean;
	env: Readonly<Record<string, string | undefined>>;
	cwd: string;
	now: () => number;
	/** How the realizer waits between observations (default: a timer). */
	sleep?: ((ms: number) => Promise<void>) | undefined;
	/** The Camps the agent was started for (`--camp`). */
	campIds: readonly CampId[];
	/** The labelled fixture realizer (`--simulate` only). */
	simulated: () => Realizer;
	/** The Kubernetes fleet realizer, when HOBO_CD_KUBE_FLEET configured one. */
	kube?: (() => Realizer) | undefined;
	/**
	 * Host ports that replace the defaults (tests, another composition). The
	 * container port defaults to the host's container engine CLI, the job
	 * ports to the box worker's data directory; a port neither supplies is
	 * refused by name.
	 */
	runnerHost?: RunnerHostPorts | undefined;
}>;

/** The realizer this agent registers, or a typed refusal naming why none. */
export async function agentRealizer(
	input: AgentRealizerInput,
): Promise<Outcome<Realizer>> {
	if (input.simulate) return { ok: true, value: input.simulated() };
	const configFile = input.env[CD_RUNNER_HOST_ENV]?.trim();
	if (configFile) return runnerHostRealizer(input, configFile);
	if (input.kube) return { ok: true, value: input.kube() };
	return refusal(
		"compose-realizer-missing",
		"no agent-local realizer is configured",
		`On a runner host set ${CD_RUNNER_HOST_ENV} to its agent config; on a Kubernetes fleet configure HOBO_CD_KUBE_FLEET; or pass --simulate.`,
	);
}

async function runnerHostRealizer(
	input: AgentRealizerInput,
	configFile: string,
): Promise<Outcome<Realizer>> {
	let raw: JsonValue;
	try {
		raw = JSON.parse(await readFile(resolve(input.cwd, configFile), "utf8"));
	} catch (error) {
		return refusal(
			"runner-host-config-invalid",
			`${configFile}: ${error instanceof Error ? error.message : String(error)}`,
			`${CD_RUNNER_HOST_ENV} must name a readable JSON agent config (packages/ci-gh-actions/deploy/runner-fleet/README.md).`,
		);
	}
	const parsed = parseRunnerHostAgentConfig(raw);
	if (!parsed.ok) return parsed;
	const config = parsed.value;
	const own = `hobo-ci-runners/${config.hostId}`;
	const foreign = input.campIds.filter((campId) => campId !== own);
	if (foreign.length > 0)
		return refusal(
			"runner-host-camp-unbound",
			`this runner host realizes ${own} only; --camp also names ${foreign.join(", ")}`,
			`Run the agent with --camp ${own}.`,
		);
	const runnerHost = await import("@hobo/ci-gh-actions/runner-host");
	const ports: RunnerHostPorts = {
		containers:
			input.runnerHost?.containers ??
			runnerHost.createCliDockerDriver({
				// SAFETY: the process env, passed to the engine CLI unchanged.
				env: input.env as NodeJS.ProcessEnv,
				...(config.dockerBinary ? { binary: config.dockerBinary } : undefined),
			}),
		jobs:
			input.runnerHost?.jobs ??
			runnerHost.createWorkerHostJobs({
				files: runnerHost.workerHostFiles(
					resolve(
						input.cwd,
						config.workerDatabase ||
							input.env.HOBO_CI_WORKER_DB?.trim() ||
							runnerHost.defaultWorkerDatabasePath(input.env, homedir()),
					),
				),
				hostKind: config.hostKind,
			}),
	};
	const gaps = runnerHost.runnerHostInterfaceGaps(ports);
	if (gaps.length > 0)
		return refusal(
			"runner-host-interface-missing",
			`this ${config.hostKind} host has no ${gaps.join(", ")}; the runner-host realizer drains, swaps and verifies only through the worker's container driver and job ports`,
			"A local runner's GitHub presence is not readable from the worker's data directory: upgrade this host as packages/ci/RUNNER-QUEUE.md describes, or run the agent from a composition that supplies the missing ports.",
		);
	const { createRunnerHostRealizer } = await import(
		"./cd-agent-runner-host.js"
	);
	return {
		ok: true,
		value: createRunnerHostRealizer({
			resolver: runnerHost.createRunnerHostResolver({
				hostId: config.hostId,
				hostKind: config.hostKind,
				host: ports,
				now: input.now,
				...(input.sleep ? { sleep: input.sleep } : undefined),
				...(config.drainDeadlineMs === undefined
					? undefined
					: { drainDeadlineMs: config.drainDeadlineMs }),
			}),
			hostId: config.hostId,
			credentialRef: config.credentialRef,
			now: input.now,
		}),
	};
}
