import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	BackendUnavailableError,
	createArtifact,
	type PipelineBackend,
	type PipelineSession,
	type PipelineStep,
	type PipelineStepResult,
	PipelineStepResultSchema,
	parseRelativePath,
} from "./execution.js";

const maximumBytes = 1024 * 1024;

/** Execute inside the explicitly bound original CI workspace, never the relay's host. */
export function createWorkspaceBackend(options: {
	workspace: string;
	kind: "gh-actions" | "ado";
}): PipelineBackend {
	let leased = false;
	return {
		kind: options.kind,
		capabilities: ["commands", "artifacts", "cancellation"],
		async open(pipeline, signal) {
			signal.throwIfAborted();
			if (process.platform === "win32")
				throw new BackendUnavailableError(
					"process-group cancellation requires a POSIX runner",
				);
			if (leased)
				throw new BackendUnavailableError(
					"source workspace already has an active pipeline session",
				);
			leased = true;
			let root: string;
			try {
				root = await realpath(options.workspace);
				if (!(await stat(root)).isDirectory())
					throw new Error("not a directory");
				signal.throwIfAborted();
			} catch (error) {
				leased = false;
				if (signal.aborted) throw error;
				throw new BackendUnavailableError("bound CI workspace is unavailable");
			}
			let closed = false;
			let operation: Promise<void> | undefined;
			let stopActive: (() => void) | undefined;
			let closing: Promise<void> | undefined;
			let shutdownError: Error | undefined;
			async function within(path: string): Promise<string> {
				const target = await realpath(
					path === "." ? root : join(root, parseRelativePath(path)),
				);
				const inside = relative(root, target);
				if (
					inside === ".." ||
					inside.startsWith(`..${sep}`) ||
					isAbsolute(inside)
				)
					throw new Error("path escapes bound source workspace");
				return target;
			}
			async function launch(
				step: PipelineStep,
				commandSignal: AbortSignal,
			): Promise<PipelineStepResult> {
				commandSignal.throwIfAborted();
				const cwd = await within(step.cwd || ".");
				if (closed) throw new Error("CI session is closed");
				commandSignal.throwIfAborted();
				const [program, ...argv] = step.argv;
				if (!program) throw new Error("empty command");
				return new Promise((resolve, reject) => {
					const child = spawn(program, argv, {
						cwd,
						env: {
							...workspaceEnvironment(process.env),
							...step.env,
							HOBO_CI_EXECUTION_ID: pipeline.id,
						},
						stdio: ["ignore", "pipe", "pipe"],
						detached: true,
					});
					const stdout: Buffer[] = [];
					const stderr: Buffer[] = [];
					let stdoutBytes = 0;
					let stderrBytes = 0;
					let failure: Error | undefined;
					let escalation: NodeJS.Timeout | undefined;
					const groupSignal = (name: NodeJS.Signals) => {
						if (!child.pid) return;
						try {
							process.kill(-child.pid, name);
						} catch (error) {
							if (
								!(
									error instanceof Error &&
									"code" in error &&
									error.code === "ESRCH"
								)
							) {
								shutdownError = new Error(
									"runner process group shutdown could not be confirmed",
								);
								failure = shutdownError;
							}
						}
					};
					const stop = () => {
						groupSignal("SIGTERM");
						escalation ??= setTimeout(() => groupSignal("SIGKILL"), 150);
					};
					const aborted = () => {
						failure = new Error("command cancelled");
						stop();
					};
					stopActive = () => {
						failure ??= new Error("CI session closed during command");
						stop();
					};
					const capture = (chunk: Buffer, stream: "stdout" | "stderr") => {
						if (failure) return;
						if (stream === "stdout") stdoutBytes += chunk.length;
						else stderrBytes += chunk.length;
						if (stdoutBytes > maximumBytes || stderrBytes > maximumBytes) {
							failure = new Error("command output exceeds one MiB limit");
							stop();
							return;
						}
						(stream === "stdout" ? stdout : stderr).push(chunk);
					};
					child.stdout.on("data", (chunk) =>
						capture(Buffer.from(chunk), "stdout"),
					);
					child.stderr.on("data", (chunk) =>
						capture(Buffer.from(chunk), "stderr"),
					);
					child.once("error", () => {
						failure = new Error("command could not start");
					});
					// A command's background children belong to this command, not the next step.
					child.once("exit", stop);
					child.once("close", (code) => {
						clearTimeout(escalation);
						groupSignal("SIGKILL");
						commandSignal.removeEventListener("abort", aborted);
						stopActive = undefined;
						if (failure) {
							reject(failure);
							return;
						}
						if (code === null || code < 0 || code > 255) {
							reject(new Error("command terminated without an exit code"));
							return;
						}
						resolve(
							create(PipelineStepResultSchema, {
								id: step.id,
								exitCode: code,
								stdout: Buffer.concat(stdout).toString("utf8"),
								stderr: Buffer.concat(stderr).toString("utf8"),
							}),
						);
					});
					commandSignal.addEventListener("abort", aborted, { once: true });
					if (commandSignal.aborted) aborted();
				});
			}
			async function collect(path: string, artifactSignal: AbortSignal) {
				artifactSignal.throwIfAborted();
				const target = await within(path);
				if (closed) throw new Error("CI session is closed");
				const file = await open(
					target,
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				try {
					const metadata = await file.stat({ bigint: true });
					if (!metadata.isFile() || metadata.size > BigInt(maximumBytes))
						throw new Error("artifact is not a bounded regular file");
					const size = Number(metadata.size);
					const buffer = Buffer.alloc(size + 1);
					let offset = 0;
					// FileHandle.read may short-read even before EOF; accumulate the complete snapshot.
					while (offset < size) {
						artifactSignal.throwIfAborted();
						const { bytesRead } = await file.read(
							buffer,
							offset,
							Math.min(64 * 1024, size - offset),
							offset,
						);
						if (bytesRead === 0)
							throw new Error("artifact changed while being collected");
						offset += bytesRead;
					}
					const tail = await file.read(buffer, size, 1, size);
					const after = await file.stat({ bigint: true });
					if (
						tail.bytesRead !== 0 ||
						after.size !== metadata.size ||
						after.ino !== metadata.ino ||
						after.dev !== metadata.dev ||
						after.mtimeNs !== metadata.mtimeNs ||
						after.ctimeNs !== metadata.ctimeNs
					)
						throw new Error("artifact changed while being collected");
					artifactSignal.throwIfAborted();
					return createArtifact(path, buffer.subarray(0, size));
				} finally {
					await file.close();
				}
			}
			function perform<T>(work: () => Promise<T>): Promise<T> {
				if (closed || operation)
					return Promise.reject(new Error("CI session is closed or busy"));
				const result = work().finally(() => {
					operation = undefined;
				});
				operation = result.then(
					() => undefined,
					() => undefined,
				);
				return result;
			}
			const session: PipelineSession = {
				run(step, commandSignal) {
					return perform(() => launch(step, commandSignal));
				},
				artifact(path, artifactSignal) {
					return perform(() => collect(path, artifactSignal));
				},
				close() {
					closing ??= (async () => {
						closed = true;
						stopActive?.();
						await operation;
						if (shutdownError) throw shutdownError;
						leased = false;
					})();
					return closing;
				},
			};
			return session;
		},
	};
}

/** Only host plumbing is inherited. Credentials must be explicit step inputs. */
export function workspaceEnvironment(
	env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const name of [
		"PATH",
		"HOME",
		"USER",
		"SHELL",
		"LANG",
		"LC_ALL",
		"TMPDIR",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"NODE_EXTRA_CA_CERTS",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
	]) {
		if (env[name] !== undefined) result[name] = env[name];
	}
	return result;
}
