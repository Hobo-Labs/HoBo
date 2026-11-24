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

export function simulatorMachineGithub(
	github: GithubSimulator,
	options: Readonly<{
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

export function jitRunnerName(encoded: string): string {
	const files = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	const runner = JSON.parse(
		Buffer.from(String(files[".runner"]), "base64").toString("utf8"),
	);
	for (const [key, value] of Object.entries(runner))
		if (key.toLowerCase() === "agentname") return String(value);
	throw new Error("the configuration names no runner");
}

export type SimulatedRunnerRun = {
	readonly runner: string;
	readonly where: string;
	readonly env: ReadonlyMap<string, string>;
	jobId: number | undefined;
	finished: boolean;
};

export type SimulatedRunnerProgram = Readonly<{
	program: FakeRunnerProgram;
	runs: SimulatedRunnerRun[];
}>;

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
