/** Retryable GHCR/docker registry push failures (transient blob/manifest races). */
import {
	type SpawnSyncOptionsWithStringEncoding,
	spawnSync,
} from "node:child_process";

export const RETRYABLE_DOCKER_PUSH_MARKERS = [
	"unknown blob",
	"blob upload unknown",
	"failed to copy",
	"connection reset by peer",
	"use of closed network connection",
	"unexpected status: 502",
	"unexpected status: 503",
	"unexpected status: 504",
	"received unexpected http status: 502",
	"received unexpected http status: 503",
	"received unexpected http status: 504",
	"error parsing HTTP 502",
	"error parsing HTTP 503",
	"error parsing HTTP 504",
] as const;

export function isRetryableDockerPushOutput(output: string): boolean {
	const lower = output.toLowerCase();
	return RETRYABLE_DOCKER_PUSH_MARKERS.some((marker) =>
		lower.includes(marker.toLowerCase()),
	);
}

/** A retry starts only if at least this long is left of the budget. */
export const MIN_PUSH_ATTEMPT_MS = 60_000;

export function dockerPushBackoffMs(attempt: number): number {
	const base = 5_000;
	return Math.min(60_000, base * 2 ** Math.max(0, attempt - 1));
}

export type DockerPushAttempt = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	/** The attempt was stopped because it ran past its time limit. */
	timedOut?: boolean;
};

export function spawnDockerPush(
	tag: string,
	timeoutMs?: number,
): DockerPushAttempt {
	const options: SpawnSyncOptionsWithStringEncoding = {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	};
	if (timeoutMs !== undefined) options.timeout = timeoutMs;
	const result = spawnSync("docker", ["push", tag], options);
	const error = result.error;
	const timedOut =
		error !== undefined && "code" in error && error.code === "ETIMEDOUT";
	return {
		exitCode: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		timedOut,
	};
}

export function runDockerPushWithRetry(options: {
	tag: string;
	maxAttempts?: number;
	/**
	 * Stop one `docker push` after this long and try again. A push that stalls
	 * prints nothing (its output is captured), so without a limit it holds the
	 * job until the job's own timeout cancels it with no clue which layer hung.
	 */
	attemptTimeoutMs?: number;
	/** No new attempt starts once this much time has passed since the first. */
	budgetMs?: number;
	push?: (tag: string, timeoutMs?: number) => DockerPushAttempt;
	sleepMs?: (ms: number) => void;
	log?: (line: string) => void;
	now?: () => number;
}): void {
	const maxAttempts = options.maxAttempts ?? 5;
	const push = options.push ?? spawnDockerPush;
	const sleep =
		options.sleepMs ??
		((ms: number) => {
			spawnSync("sleep", [`${Math.max(1, Math.ceil(ms / 1000))}`]);
		});
	const log = options.log ?? ((line: string) => console.warn(line));
	const now = options.now ?? Date.now;
	const started = now();
	let lastOutput = "";

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const left =
			options.budgetMs === undefined
				? undefined
				: options.budgetMs - (now() - started);
		const timeoutMs =
			left === undefined
				? options.attemptTimeoutMs
				: Math.max(1, Math.min(options.attemptTimeoutMs ?? left, left));
		const { exitCode, stdout, stderr, timedOut } = push(options.tag, timeoutMs);
		const combined = `${stdout}\n${stderr}`.trim();
		if (exitCode === 0 && !timedOut) {
			if (combined) process.stdout.write(`${combined}\n`);
			return;
		}
		lastOutput = timedOut
			? `timed out after ${timeoutMs}ms${combined ? `\n${combined}` : ""}`
			: combined;
		const delayMs = dockerPushBackoffMs(attempt);
		// An attempt left with seconds of budget only fails late; fail now instead.
		const roomForAnother =
			options.budgetMs === undefined ||
			now() - started + delayMs + MIN_PUSH_ATTEMPT_MS <= options.budgetMs;
		const retryable =
			(timedOut || isRetryableDockerPushOutput(combined)) &&
			attempt < maxAttempts &&
			roomForAnother;
		if (!retryable) {
			if (stdout) process.stdout.write(stdout);
			if (stderr) process.stderr.write(stderr);
			throw new Error(
				timedOut
					? `docker push ${options.tag} timed out after ${timeoutMs}ms (attempt ${attempt}/${maxAttempts})`
					: `docker push ${options.tag} failed (${exitCode ?? "signal"})`,
			);
		}
		log(
			timedOut
				? `::warning::docker push ${options.tag} stalled past ${timeoutMs}ms (attempt ${attempt}/${maxAttempts}); retry in ${delayMs}ms`
				: `::warning::docker push ${options.tag} retryable registry error (attempt ${attempt}/${maxAttempts}); retry in ${delayMs}ms`,
		);
		if (combined) log(combined);
		sleep(delayMs);
	}
	throw new Error(
		`docker push ${options.tag} failed after ${maxAttempts} attempts: ${lastOutput}`,
	);
}
