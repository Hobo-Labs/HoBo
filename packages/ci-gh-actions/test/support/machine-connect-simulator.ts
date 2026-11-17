/**
 * The GitHub simulator as a connected machine sees it: REST with the owner's
 * token, and a runner program that signs in as the one-job runner it is given
 * and takes its job. The machine-worker tests and the machine parity
 * scenarios share it.
 *
 * The simulator's `generate-jitconfig` answers with placeholder URLs and RSA
 * parameters, which `parseJitConfig` rightly refuses. The adapter swaps each
 * answer's configuration for one the runner-protocol fake issues for the same
 * runner name: GitHub's hosts and a real RSA key, as GitHub's own would be.
 */
import { Buffer } from "node:buffer";
import type { MachineGithub } from "../../src/machine-worker/jobs.js";
import type {
	FakeRunnerProgram,
	FakeRunnerStart,
} from "../../src/machine-worker/testing.js";
import { FakeGithubRunnerService } from "../../src/runner-protocol/fake-service.js";
import { testJitConfig } from "../../src/runner-protocol/port.js";
import {
	type GithubSimulator,
	SimulatedRunnerService,
} from "./github-simulator/index.js";

/** The simulator's REST as the signed-in owner, with GitHub-shaped one-job configurations. */
export function simulatorMachineGithub(
	github: GithubSimulator,
	options: Readonly<{
		/** Rewrite each configuration before the worker sees it (a refusal test). */
		rewriteJit?: (encoded: string) => string;
	}> = {},
): MachineGithub {
	const issuer = new FakeGithubRunnerService();
	return {
		async request(path, init = {}) {
			const response = await github.fetch(`${github.baseUrl}${path}`, {
				method: init.method ?? "GET",
				headers: { authorization: "Bearer simulator-user-token" },
				body: init.body ?? null,
			});
			if (!path.endsWith("/generate-jitconfig") || !response.ok)
				return response;
			const body = await response.json();
			const encoded = issuer.jitConfig(String(body.runner.name));
			return Response.json(
				{
					...body,
					encoded_jit_config: options.rewriteJit?.(encoded) ?? encoded,
				},
				{ status: response.status },
			);
		},
	};
}

/** The runner name a one-job configuration was made for. */
export function jitRunnerName(encoded: string): string {
	const files = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	const runner = JSON.parse(
		Buffer.from(String(files[".runner"]), "base64").toString("utf8"),
	);
	for (const [key, value] of Object.entries(runner))
		if (key.toLowerCase() === "agentname") return String(value);
	throw new Error("the configuration names no runner");
}

/** One run of the simulated runner program. */
export type SimulatedRunnerRun = {
	readonly runner: string;
	readonly where: string;
	readonly env: ReadonlyMap<string, string>;
	jobId: number | undefined;
	finished: boolean;
};

/** A runner program over the simulator, and every run of it. */
export type SimulatedRunnerProgram = Readonly<{
	program: FakeRunnerProgram;
	runs: SimulatedRunnerRun[];
}>;

/**
 * A runner program over the simulator: it brings its one-job runner online,
 * takes the job GitHub offers it, and finishes it with `success` once `hold`
 * (if given) resolves. Stopped first, it leaves the job unfinished.
 */
export function simulatedRunnerProgram(
	github: GithubSimulator,
	options: Readonly<{ hold?: () => Promise<void> }> = {},
): SimulatedRunnerProgram {
	const service = new SimulatedRunnerService(github);
	const runs: SimulatedRunnerRun[] = [];
	async function program(start: FakeRunnerStart): Promise<number> {
		const name = jitRunnerName(start.encodedJitConfig);
		const run: SimulatedRunnerRun = {
			runner: name,
			where: start.where,
			env: start.env,
			jobId: undefined,
			finished: false,
		};
		runs.push(run);
		const session = await service.open(testJitConfig(name));
		try {
			const job = github.claim(name);
			if (!job) return 0;
			run.jobId = job.id;
			if (options.hold) {
				const stopped = new Promise<"stopped">((resolve) =>
					start.signal.addEventListener("abort", () => resolve("stopped"), {
						once: true,
					}),
				);
				if ((await Promise.race([options.hold(), stopped])) === "stopped")
					return 143;
			}
			github.complete(job.id, { conclusion: "success" });
			run.finished = true;
			return 0;
		} finally {
			await session.close();
		}
	}
	return { program, runs };
}
