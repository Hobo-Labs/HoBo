import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { FORWARDER_READY } from "./forwarder.js";

export type ExecIo = Readonly<{
	stdin?: Uint8Array;
	signal: AbortSignal;
	onOutput(chunk: Uint8Array): void;
}>;

export type OciCalls = Readonly<{
	version(): Promise<string>;
	start(id: string, bundle: string): Promise<number>;
	exec(id: string, processFile: string, io: ExecIo): Promise<number>;
	forward(
		id: string,
		bundle: string,
	): Promise<Readonly<{ stop(): Promise<void> }>>;
	remove(id: string): Promise<void>;
}>;

const GRACE_MS = 5_000;
const READY_MS = 60_000;

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

export function createOciCalls(
	options: Readonly<{
		binary: string;
		stateRoot: string;
		globalFlags: readonly string[];
	}>,
): OciCalls {
	const base = ["--root", options.stateRoot, ...options.globalFlags];

	async function remove(id: string): Promise<void> {
		const answer = await collect(options.binary, [
			...base,
			"delete",
			"--force",
			id,
		]);
		if (
			answer.code !== 0 &&
			!/does not exist|not found|no such|not exist/iu.test(answer.stderr)
		)
			throw new Error(
				`${options.binary} delete failed (${answer.code}): ${answer.stderr.trim().slice(0, 300)}`,
			);
	}

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
		forward(id, bundle) {
			return new Promise((resolve, reject) => {
				const child = spawn(
					options.binary,
					[...base, "run", "--bundle", bundle, id],
					{ stdio: ["pipe", "pipe", "pipe"] },
				);
				let stderr = "";
				let out = "";
				let settled = false;
				const close = () => {
					child.stdin.destroy();
					child.stdout.destroy();
					child.stderr.destroy();
				};
				const stop = async () => {
					close();
					child.kill("SIGKILL");
					await remove(id);
				};
				const settle = (error?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (error === undefined) {
						resolve({ stop });
						return;
					}
					close();
					remove(id).then(
						() => reject(error),
						() => reject(error),
					);
				};
				const timer = setTimeout(
					() =>
						settle(
							new Error(
								`the forwarder printed no ready line in ${READY_MS} ms: ${stderr.trim().slice(0, 300)}`,
							),
						),
					READY_MS,
				);
				child.stderr.on("data", (chunk) => {
					stderr += String(chunk);
				});
				child.stdout.on("data", (chunk) => {
					out += String(chunk);
					if (out.includes(FORWARDER_READY)) settle();
				});
				child.stdin.on("error", () => undefined);
				child.on("error", (error) => settle(error));
				child.on("exit", (code) =>
					settle(
						new Error(
							`${options.binary} run of the forwarder exited ${code} before it was ready: ${stderr.trim().slice(0, 300)}`,
						),
					),
				);
			});
		},
		remove,
	};
}
