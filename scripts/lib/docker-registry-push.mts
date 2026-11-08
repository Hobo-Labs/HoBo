/** Retryable GHCR/docker registry push failures (transient blob/manifest races). */
import { spawnSync } from "node:child_process";

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

export function dockerPushBackoffMs(attempt: number): number {
	const base = 5_000;
	return Math.min(60_000, base * 2 ** Math.max(0, attempt - 1));
}

export type DockerPushAttempt = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
};

export function spawnDockerPush(tag: string): DockerPushAttempt {
	const result = spawnSync("docker", ["push", tag], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});
	return {
		exitCode: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

export function runDockerPushWithRetry(options: {
	tag: string;
	maxAttempts?: number;
	push?: (tag: string) => DockerPushAttempt;
	sleepMs?: (ms: number) => void;
	log?: (line: string) => void;
}): void {
	const maxAttempts = options.maxAttempts ?? 5;
	const push = options.push ?? spawnDockerPush;
	const sleep =
		options.sleepMs ??
		((ms: number) => {
			spawnSync("sleep", [`${Math.max(1, Math.ceil(ms / 1000))}`]);
		});
	const log = options.log ?? ((line: string) => console.warn(line));
	let lastOutput = "";

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const { exitCode, stdout, stderr } = push(options.tag);
		const combined = `${stdout}\n${stderr}`.trim();
		if (exitCode === 0) {
			if (combined) process.stdout.write(`${combined}\n`);
			return;
		}
		lastOutput = combined;
		const retryable =
			isRetryableDockerPushOutput(combined) && attempt < maxAttempts;
		if (!retryable) {
			if (stdout) process.stdout.write(stdout);
			if (stderr) process.stderr.write(stderr);
			throw new Error(
				`docker push ${options.tag} failed (${exitCode ?? "signal"})`,
			);
		}
		const delayMs = dockerPushBackoffMs(attempt);
		log(
			`::warning::docker push ${options.tag} retryable registry error (attempt ${attempt}/${maxAttempts}); retry in ${delayMs}ms`,
		);
		if (combined) log(combined);
		sleep(delayMs);
	}
	throw new Error(
		`docker push ${options.tag} failed after ${maxAttempts} attempts: ${lastOutput}`,
	);
}
