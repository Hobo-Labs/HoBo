/**
 * A `LintSandbox` on Docker: each tool runs in a fresh container with no
 * network (`--network none`), a read-only root, no capabilities, an
 * unprivileged user and bounded memory and processes. The commit's archive is
 * piped in on standard input and unpacked into a scratch folder; nothing on
 * the host is mounted. The container is removed when the tool ends or its
 * time runs out.
 *
 * The image must hold the five tools of `LINT_TOOLS`, `sh` and `tar`. A tool
 * that is missing exits 127, which the check reports as not installed.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	LINT_MAX_OUTPUT_BYTES,
	type LintRun,
	type LintRunResult,
	type LintSandbox,
} from "./lint.js";

/** One command run on the host: `docker` with its arguments. */
export type SandboxCommand = Readonly<{
	command: string;
	args: readonly string[];
	stdin: Uint8Array | undefined;
	timeoutMs: number;
}>;

export type SandboxCommandResult = Readonly<{
	exitCode: number;
	output: string;
	timedOut: boolean;
}>;

/** Runs one host command; `runHostCommand` in production. */
export type SandboxCommandRunner = (
	command: SandboxCommand,
) => Promise<SandboxCommandResult>;

export type DockerLintSandboxOptions = Readonly<{
	/** The image holding the lint tools, pinned by digest in production. */
	image: string;
	/** `docker` when absent. */
	docker?: string | undefined;
	/** `runHostCommand` when absent. */
	runner?: SandboxCommandRunner | undefined;
	/** A fresh container name each run; random when absent. */
	name?: (() => string) | undefined;
}>;

const UNPACK_THEN_RUN =
	'tar -xzf - --strip-components=1 -C /work && cd /work && exec "$@"';

/** The `docker run` arguments for one lint run. */
export function dockerLintArgs(
	image: string,
	name: string,
	request: LintRun,
): readonly string[] {
	return [
		"run",
		"--rm",
		"-i",
		"--name",
		name,
		"--network",
		request.network,
		"--read-only",
		"--tmpfs",
		"/work:rw,exec,size=2g,uid=65534,gid=65534",
		"--tmpfs",
		"/tmp:rw,size=256m,uid=65534,gid=65534",
		"--user",
		"65534:65534",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit",
		"512",
		"--memory",
		"2g",
		"--workdir",
		"/work",
		image,
		"sh",
		"-c",
		UNPACK_THEN_RUN,
		"lint",
		...request.argv,
	];
}

/** Run a host command, piping `stdin` in and reading output up to the cap. */
export function runHostCommand(
	command: SandboxCommand,
): Promise<SandboxCommandResult> {
	return new Promise((resolve) => {
		const child = spawn(command.command, [...command.args], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let timedOut = false;
		const keep = (chunk: Buffer): void => {
			if (size >= LINT_MAX_OUTPUT_BYTES) return;
			const part = chunk.subarray(0, LINT_MAX_OUTPUT_BYTES - size);
			chunks.push(part);
			size += part.byteLength;
		};
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		let settled = false;
		const finish = (exitCode: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode,
				output: Buffer.concat(chunks).toString("utf8"),
				timedOut,
			});
		};
		// A killed process's own children can hold its output open, so a run
		// that overstays ends at once instead of waiting for them.
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
			child.stdout.destroy();
			child.stderr.destroy();
			finish(137);
		}, command.timeoutMs);
		child.on("error", (error) => {
			chunks.push(Buffer.from(error.message));
			finish(127);
		});
		child.on("close", (code) => finish(code ?? 1));
		child.stdin.on("error", () => undefined);
		child.stdin.end(command.stdin ?? new Uint8Array());
	});
}

/** The lint sandbox on Docker. */
export function createDockerLintSandbox(
	options: DockerLintSandboxOptions,
): LintSandbox {
	const docker = options.docker ?? "docker";
	const runner = options.runner ?? runHostCommand;
	const nameOf =
		options.name ?? (() => `hobo-lint-${randomUUID().slice(0, 12)}`);
	return {
		async run(request: LintRun): Promise<LintRunResult> {
			const name = nameOf();
			const result = await runner({
				command: docker,
				args: dockerLintArgs(options.image, name, request),
				stdin: request.archive,
				timeoutMs: request.timeoutMs,
			});
			if (result.timedOut)
				await runner({
					command: docker,
					args: ["rm", "-f", name],
					stdin: undefined,
					timeoutMs: 30_000,
				}).catch(() => undefined);
			return result;
		},
	};
}
