import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

import { z } from "zod";

// How a supervising host (`hobo ci serve --with-worker`) hands the isolated
// worker its App key and webhook secret: as JSON on an inherited pipe whose
// descriptor `HOBO_CI_WORKER_SECRETS_FD` names, written once and closed. The
// secrets are on no disk and in no environment, so nothing the worker spawns
// (a runner container, a build) inherits them.

// public-contract: the variable naming the descriptor the worker reads its secrets from.
export const WORKER_SECRETS_FD = "HOBO_CI_WORKER_SECRETS_FD";

const HandedSecrets = z
	.object({
		githubAppPrivateKey: z.string().min(1).max(32_768),
		webhookSecret: z.string().min(1).max(4096).optional(),
	})
	.strict();

export type WorkerSecrets = z.infer<typeof HandedSecrets>;

/** The serialized form a host writes to the worker's secrets pipe. */
export function workerSecretsPayload(secrets: WorkerSecrets): string {
	return JSON.stringify(HandedSecrets.parse(secrets));
}

/** Read the secrets a host handed over, or nothing when it handed none. */
export function readHandedWorkerSecrets(
	env: NodeJS.ProcessEnv,
	read: (fd: number) => string = (fd) => readFileSync(fd, "utf8"),
): WorkerSecrets | undefined {
	const named = env[WORKER_SECRETS_FD];
	if (named === undefined || named === "") return undefined;
	if (!/^[3-9]$/u.test(named))
		throw new Error(
			`${WORKER_SECRETS_FD} must name an inherited descriptor (3-9)`,
		);
	let text: string;
	try {
		text = read(Number(named));
	} catch {
		throw new Error(
			`the secrets pipe ${WORKER_SECRETS_FD}=${named} is not readable`,
		);
	}
	try {
		return HandedSecrets.parse(JSON.parse(text));
	} catch {
		throw new Error("the secrets handed to the worker are not valid");
	}
}

// public-contract: the event the isolated worker logs once it is serving.
export const WORKER_STARTED_EVENT = "hobo_ci_isolated_worker_started";

/**
 * Resolve once the worker logs that it has started (its stderr is forwarded
 * to `forward`); reject when it exits first or does not start in time.
 */
export function waitForWorkerStart(
	worker: ChildProcess,
	options: {
		readonly timeoutMs: number;
		readonly forward?: (chunk: Buffer) => void;
	},
): Promise<void> {
	return new Promise((resolve, reject) => {
		let pending = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker.off("exit", onExit);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => {
			worker.kill("SIGTERM");
			finish(
				new Error(
					`the CI worker did not start within ${options.timeoutMs} ms; it was stopped`,
				),
			);
		}, options.timeoutMs);
		const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
			finish(
				new Error(
					`the CI worker exited before it started (${code !== null ? `exit ${code}` : `signal ${signal}`}); its log is above`,
				),
			);
		worker.on("exit", onExit);
		worker.stderr?.on("data", (chunk: Buffer) => {
			options.forward?.(chunk);
			if (settled) return;
			pending += chunk.toString("utf8");
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			if (lines.some((line) => line.includes(`"${WORKER_STARTED_EVENT}"`)))
				finish();
		});
	});
}
