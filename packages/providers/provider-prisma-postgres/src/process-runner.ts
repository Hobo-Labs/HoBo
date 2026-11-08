import { spawn } from "node:child_process";
import type { ProcessRunner } from "./cli.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./cli.js";
import { PrismaProviderError } from "./errors.js";

/** Real CLI/migration runner: explicit environment, no shell, bounded streams and lifetime. */
export function createNodeProcessRunner(
	options: { readonly maxOutputBytes?: number } = {},
): ProcessRunner {
	const maximum = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	if (!Number.isSafeInteger(maximum) || maximum < 1)
		throw new Error("process output limit must be a positive safe integer");
	return {
		run(argv, input) {
			const executable = argv[0];
			if (
				!executable ||
				argv.some((arg) => arg.includes("\0")) ||
				!Number.isSafeInteger(input.timeoutMs) ||
				input.timeoutMs < 1
			) {
				return Promise.reject(
					new PrismaProviderError(
						"PROVIDER_CONTRACT_CHANGED",
						"process invocation requires argv and a finite positive timeout",
					),
				);
			}
			return new Promise((resolve, reject) => {
				const child = spawn(executable, argv.slice(1), {
					cwd: input.cwd,
					env: { ...input.env },
					shell: false,
					detached: process.platform !== "win32",
					stdio: ["pipe", "pipe", "pipe"],
				});
				let done = false;
				let stdout = "",
					stderr = "";
				let stdoutBytes = 0,
					stderrBytes = 0;
				function kill() {
					if (!child.pid) return;
					try {
						if (process.platform === "win32") child.kill("SIGKILL");
						else process.kill(-child.pid, "SIGKILL");
					} catch {
						/* The process may have exited before its close event. */
					}
				}
				function fail(message: string) {
					if (done) return;
					done = true;
					clearTimeout(deadline);
					kill();
					reject(
						new PrismaProviderError("PROVIDER_OPERATION_AMBIGUOUS", message),
					);
				}
				const deadline = setTimeout(
					() =>
						fail(
							"process deadline elapsed; the remote operation may have completed",
						),
					input.timeoutMs,
				);
				child.on("error", () =>
					fail(
						"process failed to start or communicate; no remote outcome is confirmed",
					),
				);
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					stdoutBytes += Buffer.byteLength(chunk, "utf8");
					if (stdoutBytes > maximum) {
						fail(
							"process stdout exceeded its byte limit; the remote outcome is unconfirmed",
						);
						return;
					}
					stdout += chunk;
				});
				child.stderr.on("data", (chunk: string) => {
					stderrBytes += Buffer.byteLength(chunk, "utf8");
					if (stderrBytes > maximum) {
						fail(
							"process stderr exceeded its byte limit; the remote outcome is unconfirmed",
						);
						return;
					}
					stderr += chunk;
				});
				child.on("close", (code) => {
					clearTimeout(deadline);
					if (done) return;
					done = true;
					resolve({ code: code ?? 128, stdout, stderr });
				});
				child.stdin.on("error", () =>
					fail("process stdin closed before the supplied input was accepted"),
				);
				child.stdin.end(input.stdin);
			});
		},
	};
}
