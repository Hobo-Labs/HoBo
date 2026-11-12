import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject, JsonValue } from "@hobo/core";
import { isJsonObject, isJsonString, parseJsonText } from "../../src/json.js";
import { POSTGRES_URL } from "./live.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..", "..");
const workerPath = join(here, "store-worker.ts");

/** A reply as the worker wrote it: `{ id, ok, value }` or `{ id, ok: false, code, failure, message }`. */
export type WorkerReply = JsonObject;

export type WorkerLease = Readonly<{ fence: string; expiresAt: string }>;

/** Handle on a store running in a separate OS process. */
export interface StoreProcess {
	readonly pid: number | undefined;
	send(op: string, args?: JsonObject): Promise<WorkerReply>;
	/** Like `send`, but throws unless the reply is ok, and returns its value. */
	call(op: string, args?: JsonObject): Promise<JsonValue>;
	lease(op: "claim" | "renew", args: JsonObject): Promise<WorkerLease>;
	strings(op: string, args?: JsonObject): Promise<readonly string[]>;
	text(op: string, args?: JsonObject): Promise<string>;
	/** SIGKILL: the process dies holding whatever it held. */
	kill(): Promise<void>;
	stop(): Promise<void>;
}

export function startStoreProcess(
	schema: string,
	startIso: string,
): StoreProcess {
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
			const reply = parseJsonText(line);
			if (!isJsonObject(reply)) continue;
			const id = Number(reply.id);
			waiting.get(id)?.(reply);
			waiting.delete(id);
		}
	});
	const exited = new Promise<void>((resolve) =>
		child.on("close", () => resolve()),
	);
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
				child.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`);
			});
		},
		async call(op, args = {}) {
			const reply = await handle.send(op, args);
			if (reply.ok !== true) {
				throw new Error(`${op} failed: ${JSON.stringify(reply)}`);
			}
			return reply.value ?? null;
		},
		async lease(op, args) {
			const value = await handle.call(op, args);
			if (
				!isJsonObject(value) ||
				!isJsonString(value.fence) ||
				!isJsonString(value.expiresAt)
			) {
				throw new Error(`${op}: not a lease: ${JSON.stringify(value)}`);
			}
			return { fence: value.fence, expiresAt: value.expiresAt };
		},
		async strings(op, args = {}) {
			const value = await handle.call(op, args);
			if (!Array.isArray(value) || !value.every(isJsonString)) {
				throw new Error(`${op}: not a string list: ${JSON.stringify(value)}`);
			}
			return value.map(String);
		},
		async text(op, args = {}) {
			const value = await handle.call(op, args);
			if (!isJsonString(value)) {
				throw new Error(`${op}: not a string: ${JSON.stringify(value)}`);
			}
			return value;
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
