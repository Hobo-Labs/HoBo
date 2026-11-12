import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_URL } from "./live.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..", "..");
const workerPath = join(here, "store-worker.ts");

export type WorkerReply =
	| Readonly<{ id: number; ok: true; value: unknown }>
	| Readonly<{ id: number; ok: false; code: string; failure?: string; message: string }>;

/** Handle on a store running in a separate OS process. */
export interface StoreProcess {
	readonly pid: number | undefined;
	send(op: string, args?: Readonly<Record<string, unknown>>): Promise<WorkerReply>;
	/** Like `send`, but throws unless the reply is ok, and returns its value. */
	call(op: string, args?: Readonly<Record<string, unknown>>): Promise<unknown>;
	/** SIGKILL: the process dies holding whatever it held. */
	kill(): Promise<void>;
	stop(): Promise<void>;
}

export function startStoreProcess(schema: string, startIso: string): StoreProcess {
	const child: ChildProcessWithoutNullStreams = spawn(
		process.execPath,
		["--import", "tsx", workerPath, POSTGRES_URL, schema, startIso],
		{ cwd: packageDir, stdio: ["pipe", "pipe", "pipe"] },
	);
	let nextId = 0;
	const waiting = new Map<number, (reply: WorkerReply) => void>();
	let buffer = "";
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim() === "") continue;
			// SAFETY: the worker writes one JSON reply per line.
			const reply = JSON.parse(line) as WorkerReply;
			waiting.get(reply.id)?.(reply);
			waiting.delete(reply.id);
		}
	});
	const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
	child.on("close", () => {
		for (const [id, resolve] of waiting) {
			resolve({ id, ok: false, code: "PROCESS_EXITED", message: stderr });
		}
		waiting.clear();
	});
	const handle: StoreProcess = {
		pid: child.pid,
		send(op, args = {}) {
			nextId += 1;
			const id = nextId;
			return new Promise<WorkerReply>((resolve) => {
				waiting.set(id, resolve);
				child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
			});
		},
		async call(op, args = {}) {
			const reply = await handle.send(op, args);
			if (!reply.ok) throw new Error(`${op} failed: ${reply.code} ${reply.message}`);
			return reply.value;
		},
		async kill() {
			child.kill("SIGKILL");
			await exited;
		},
		async stop() {
			child.stdin.end();
			await exited;
		},
	};
	return handle;
}
