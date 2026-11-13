/**
 * The runtime calls of the OCI sandbox drivers, behind one port so that the
 * driver's logic runs against a recording double in unit tests (L38 isolated
 * checks) and against the real runtime binary (`crun`, `runc`, `runsc`) here.
 * Every call is a child process; no secret is ever on its argv or environment:
 * an exec's process (argv and environment) is written to a private file and
 * passed with `--process`, and its standard input is piped.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import type { ForwardRoute } from "./forwarder.js";
import { FORWARDER_READY, FORWARDER_SCRIPT } from "./forwarder.js";

export type ExecIo = Readonly<{
	stdin?: Uint8Array;
	signal: AbortSignal;
	onOutput(chunk: Uint8Array): void;
}>;

export type OciCalls = Readonly<{
	/** The runtime's version line; fails when the binary is missing. */
	version(): Promise<string>;
	/** Creates and starts the container of `bundle` detached; answers its init pid. */
	start(id: string, bundle: string): Promise<number>;
	/** Runs the process described by `processFile` in the container; answers its exit code. */
	exec(id: string, processFile: string, io: ExecIo): Promise<number>;
	/** Starts the forwarder inside the network namespace of `pid`; resolves once it listens. */
	forward(
		pid: number,
		routes: readonly ForwardRoute[],
	): Promise<Readonly<{ stop(): void }>>;
	/** Kills and deletes the container; succeeds when it is already gone. */
	remove(id: string): Promise<void>;
}>;

const GRACE_MS = 5_000;

type Collected = Readonly<{ code: number; stdout: string; stderr: string }>;

function collect(command: string, args: readonly string[]): Promise<Collected> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code, signal) =>
			resolve({
				code: code ?? (signal === null ? 1 : 128 + 9),
				stdout,
				stderr,
			}),
		);
	});
}

/** Real calls to an OCI runtime binary, with its state under `stateRoot`. */
export function createOciCalls(
	options: Readonly<{
		binary: string;
		stateRoot: string;
		/** Runtime flags placed before the subcommand (`runsc` needs `--network=host`). */
		globalFlags: readonly string[];
		/** True when the agent is not root: the forwarder also enters the container's user namespace. */
		rootless: boolean;
	}>,
): OciCalls {
	const base = ["--root", options.stateRoot, ...options.globalFlags];
	return {
		async version() {
			const answer = await collect(options.binary, ["--version"]);
			if (answer.code !== 0)
				throw new Error(`${options.binary} --version exited ${answer.code}`);
			return answer.stdout.split("\n")[0] ?? "";
		},
		async start(id, bundle) {
			const pidFile = `${bundle}/init.pid`;
			const logFile = `${bundle}/runtime.log`;
			// A detached container inherits the runtime's stdio, so the runtime's
			// output goes to a file, never to a pipe the container would hold open.
			const log = openSync(logFile, "w", 0o600);
			let code: number;
			try {
				code = await new Promise<number>((resolve, reject) => {
					const child = spawn(
						options.binary,
						[
							...base,
							"run",
							"--detach",
							"--bundle",
							bundle,
							"--pid-file",
							pidFile,
							id,
						],
						{ stdio: ["ignore", log, log] },
					);
					child.on("error", reject);
					child.on("exit", (exit) => resolve(exit ?? 1));
				});
			} finally {
				closeSync(log);
			}
			if (code !== 0)
				throw new Error(
					`${options.binary} run failed (${code}): ${readFileSync(logFile, "utf8").trim().slice(0, 500)}`,
				);
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			if (!Number.isInteger(pid) || pid <= 0)
				throw new Error(`${options.binary} wrote no init pid`);
			return pid;
		},
		exec(id, processFile, io) {
			return new Promise((resolve, reject) => {
				const child = spawn(
					options.binary,
					[...base, "exec", "--process", processFile, id],
					{ stdio: ["pipe", "pipe", "pipe"] },
				);
				let killer: NodeJS.Timeout | undefined;
				const abort = () => {
					child.kill("SIGTERM");
					killer = setTimeout(() => child.kill("SIGKILL"), GRACE_MS);
				};
				io.signal.addEventListener("abort", abort, { once: true });
				child.stdout.on("data", (chunk: Buffer) =>
					io.onOutput(new Uint8Array(chunk)),
				);
				child.stderr.on("data", (chunk: Buffer) =>
					io.onOutput(new Uint8Array(chunk)),
				);
				child.stdin.on("error", () => undefined);
				child.stdin.end(
					io.stdin === undefined ? undefined : Buffer.from(io.stdin),
				);
				child.on("error", reject);
				child.on("close", (code, signal) => {
					io.signal.removeEventListener("abort", abort);
					if (killer !== undefined) clearTimeout(killer);
					resolve(code ?? (signal === "SIGKILL" ? 137 : 143));
				});
			});
		},
		forward(pid, routes) {
			const enter = options.rootless
				? ["--user", "--preserve-credentials"]
				: [];
			return new Promise((resolve, reject) => {
				const child = spawn(
					"nsenter",
					[
						"--target",
						String(pid),
						"--net",
						...enter,
						"--",
						process.execPath,
						"-e",
						FORWARDER_SCRIPT,
						JSON.stringify(routes),
					],
					{ stdio: ["pipe", "pipe", "pipe"] },
				);
				let stderr = "";
				let out = "";
				let settled = false;
				const stop = () => {
					child.stdin.destroy();
					child.kill("SIGKILL");
				};
				child.stderr.on("data", (chunk) => {
					stderr += String(chunk);
				});
				child.stdout.on("data", (chunk) => {
					out += String(chunk);
					if (!settled && out.includes(FORWARDER_READY)) {
						settled = true;
						resolve({ stop });
					}
				});
				child.on("error", (error) => {
					if (!settled) {
						settled = true;
						reject(error);
					}
				});
				child.on("close", (code) => {
					if (!settled) {
						settled = true;
						reject(
							new Error(
								`the forwarder exited ${code}: ${stderr.trim().slice(0, 300)}`,
							),
						);
					}
				});
			});
		},
		async remove(id) {
			const answer = await collect(options.binary, [
				...base,
				"delete",
				"--force",
				id,
			]);
			if (
				answer.code !== 0 &&
				!/does not exist|not found|no such/iu.test(answer.stderr)
			)
				throw new Error(
					`${options.binary} delete failed (${answer.code}): ${answer.stderr.trim().slice(0, 300)}`,
				);
		},
	};
}
