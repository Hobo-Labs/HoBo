#!/usr/bin/env node
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { resolve } from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_SECONDS = 180;
const KILL_GRACE_MS = 2_000;
const DIAGNOSTIC_LIMIT = 65_536;

export type SpawnedInstall = EventEmitter &
	Readonly<{
		pid?: number | undefined;
		stdout: Readable;
		stderr: Readable;
	}>;

export type InstallSpawner = (
	command: string,
	args: readonly string[],
	options: Readonly<{
		detached: boolean;
		env: NodeJS.ProcessEnv;
	}>,
) => SpawnedInstall;

export type InstallRunOptions = Readonly<{
	env?: NodeJS.ProcessEnv;
	spawn?: InstallSpawner;
	now?: () => number;
	schedule?: (callback: () => void, delayMs: number) => () => void;
	killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
	writeOutput?: (stream: "stdout" | "stderr", text: string) => void;
	log?: (line: string) => void;
}>;

type AttemptOutcome =
	| "success"
	| "failed"
	| "timeout"
	| "lockfile-mismatch"
	| "kill-failed";

type AttemptResult = Readonly<{
	status: number;
	outcome: AttemptOutcome;
}>;

export function parseInstallTimeoutSeconds(value: string | undefined): number {
	if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
	if (!/^[1-9][0-9]*$/u.test(value)) {
		throw new Error(
			"HOBO_PNPM_INSTALL_TIMEOUT_S must be a positive integer number of seconds",
		);
	}
	const seconds = Number(value);
	if (!Number.isSafeInteger(seconds) || seconds * 1_000 > 2_147_483_647) {
		throw new Error(
			"HOBO_PNPM_INSTALL_TIMEOUT_S exceeds the supported timer range",
		);
	}
	return seconds;
}

const defaultSpawn: InstallSpawner = (command, args, options) =>
	spawn(command, args, {
		...options,
		stdio: ["ignore", "pipe", "pipe"],
	});

function defaultSchedule(callback: () => void, delayMs: number): () => void {
	const timer = setTimeout(callback, delayMs);
	return () => clearTimeout(timer);
}

function defaultKillProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH")
			return;
		throw error;
	}
}

function errorText(error: Error): string {
	return error.message;
}

async function runAttempt(
	args: readonly string[],
	timeoutMs: number,
	attempt: number,
	startedAt: number,
	options: Required<
		Pick<
			InstallRunOptions,
			"spawn" | "now" | "schedule" | "killProcessGroup" | "writeOutput" | "log"
		>
	>,
	env: NodeJS.ProcessEnv,
): Promise<AttemptResult> {
	const childArgs = ["install", ...args];
	let diagnostics = "";
	const result = await new Promise<AttemptResult>((resolveResult) => {
		let child: SpawnedInstall;
		try {
			child = options.spawn("pnpm", childArgs, {
				detached: true,
				env,
			});
		} catch (error) {
			options.writeOutput(
				"stderr",
				`${errorText(error instanceof Error ? error : new Error(String(error)))}\n`,
			);
			resolveResult({ status: 1, outcome: "failed" });
			return;
		}

		let settled = false;
		let timedOut = false;
		let cancelDeadline = () => {};
		let cancelKill: (() => void) | undefined;
		const capture = (stream: "stdout" | "stderr", text: string) => {
			options.writeOutput(stream, text);
			diagnostics = `${diagnostics}${text}`.slice(-DIAGNOSTIC_LIMIT);
		};
		child.stdout.on("data", (chunk: Buffer | string) =>
			capture("stdout", chunk.toString()),
		);
		child.stderr.on("data", (chunk: Buffer | string) =>
			capture("stderr", chunk.toString()),
		);

		const finish = (code: number | null, forcedOutcome?: AttemptOutcome) => {
			if (settled) return;
			settled = true;
			cancelDeadline();
			cancelKill?.();
			const lockfileMismatch =
				code !== 0 &&
				/ERR_PNPM_OUTDATED_LOCKFILE|frozen[ -]lockfile violation/iu.test(
					diagnostics,
				);
			resolveResult({
				status: code ?? 1,
				outcome:
					forcedOutcome ??
					(timedOut
						? "timeout"
						: code === 0
							? "success"
							: lockfileMismatch
								? "lockfile-mismatch"
								: "failed"),
			});
		};
		const signalGroup = (signal: NodeJS.Signals): boolean => {
			if (child.pid === undefined) {
				options.writeOutput("stderr", "pnpm child has no process id\n");
				finish(1, "kill-failed");
				return false;
			}
			try {
				options.killProcessGroup(child.pid, signal);
				return true;
			} catch (error) {
				options.writeOutput(
					"stderr",
					`failed to send ${signal} to pnpm process group: ${errorText(error instanceof Error ? error : new Error(String(error)))}\n`,
				);
				finish(1, "kill-failed");
				return false;
			}
		};

		child.once("error", (error: Error) => {
			options.writeOutput("stderr", `${error.message}\n`);
			finish(null);
		});
		child.once("close", (code: number | null) => finish(code));
		cancelDeadline = options.schedule(() => {
			if (settled) return;
			timedOut = true;
			if (!signalGroup("SIGTERM")) return;
			cancelKill = options.schedule(() => {
				if (!settled) signalGroup("SIGKILL");
			}, KILL_GRACE_MS);
		}, timeoutMs);
	});
	options.log(
		JSON.stringify({
			attempt,
			args: childArgs,
			outcome: result.outcome,
			durationMs: options.now() - startedAt,
		}),
	);
	return result;
}

export async function runPnpmInstall(
	args: readonly string[],
	runOptions: InstallRunOptions = {},
): Promise<number> {
	const env = runOptions.env ?? process.env;
	const timeoutSeconds = parseInstallTimeoutSeconds(
		env.HOBO_PNPM_INSTALL_TIMEOUT_S,
	);
	const options = {
		spawn: runOptions.spawn ?? defaultSpawn,
		now: runOptions.now ?? Date.now,
		schedule: runOptions.schedule ?? defaultSchedule,
		killProcessGroup: runOptions.killProcessGroup ?? defaultKillProcessGroup,
		writeOutput:
			runOptions.writeOutput ??
			((stream: "stdout" | "stderr", text: string) => {
				process[stream].write(text);
			}),
		log: runOptions.log ?? ((line: string) => console.log(line)),
	};

	let finalStatus = 1;
	for (const attempt of [1, 2]) {
		const attemptArgs = attempt === 1 ? args : [...args, "--prefer-offline"];
		const result = await runAttempt(
			attemptArgs,
			timeoutSeconds * 1_000,
			attempt,
			options.now(),
			options,
			env,
		);
		finalStatus = result.status;
		if (
			result.status === 0 ||
			result.outcome === "lockfile-mismatch" ||
			result.outcome === "kill-failed"
		)
			return result.status;
	}
	return finalStatus;
}

const invokedPath = process.argv[1];
if (
	invokedPath &&
	import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
	try {
		process.exitCode = await runPnpmInstall(process.argv.slice(2));
	} catch (error) {
		console.error(
			errorText(error instanceof Error ? error : new Error(String(error))),
		);
		process.exitCode = 1;
	}
}
