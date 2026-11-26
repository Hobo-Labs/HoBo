/**
 * Conformance contexts for the libSQL binding, all offline:
 *
 * - `file:` with an injected clock and four in-process clients, each its own
 *   `@libsql/client` (its own connection pool) on one database file;
 * - `:memory:` with one client (an in-memory database exists only on the
 *   connection that opened it, so a second client would see another database);
 * - `file:` with the first client in this thread and three in worker threads,
 *   racing real connections and SQLite's locks, the clock shared through a
 *   `SharedArrayBuffer`;
 * - `file:` with the database's own clock and real sleeps, which is the
 *   default a deployed relay runs with.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { type EphemeralStatePort, parseEphemeralKey } from "@hobo/core";
import {
	type EphemeralConformanceContext,
	KV_REDIS_ERROR_CODES,
	KvRedisCompatibleError,
} from "@hobo/kv-redis-compatible";
import { type Client, createClient } from "@libsql/client";

import {
	createLibsqlEphemeralState,
	meterLibsqlClient,
} from "../../src/index.js";

export type LibsqlLane = {
	readonly context: EphemeralConformanceContext;
	close(): Promise<void>;
};

export type TemporaryDatabase = {
	readonly url: string;
	remove(): void;
};

export function temporaryDatabase(): TemporaryDatabase {
	const dir = mkdtempSync(join(tmpdir(), "hobo-libsql-"));
	return {
		url: `file:${join(dir, "ephemeral.db")}`,
		remove: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function sharedClock(startMs: number) {
	const buffer = new SharedArrayBuffer(8);
	const cells = new BigInt64Array(buffer);
	Atomics.store(cells, 0, BigInt(startMs));
	return {
		buffer,
		now: () => Number(Atomics.load(cells, 0)),
		advance(ms: number) {
			Atomics.add(cells, 0, BigInt(Math.round(ms)));
		},
	};
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function lane(
	clients: Client[],
	ports: [EphemeralStatePort, ...EphemeralStatePort[]],
	metered: ReturnType<typeof meterLibsqlClient>,
	advanceTime: (ms: number) => Promise<void>,
	ttlMs: number,
	keyPrefix: string,
	cleanup: () => Promise<void> | void,
): LibsqlLane {
	return {
		context: {
			clients: ports,
			advanceTime,
			usage: () => {
				const requests = metered.requests();
				return { total: requests.total, byVerb: requests.byKind };
			},
			keyPrefix,
			ttlMs,
		},
		async close() {
			for (const client of clients) client.close();
			await cleanup();
		},
	};
}

/** `file:` or `:memory:` with in-process clients and an injected clock. */
export function inProcessLane(kind: "file" | "memory"): LibsqlLane {
	const clock = sharedClock(1_000_000);
	const database = kind === "file" ? temporaryDatabase() : undefined;
	const url = database?.url ?? ":memory:";
	const clients = Array.from({ length: kind === "file" ? 4 : 1 }, () =>
		createClient({ url, timeout: 10_000 }),
	);
	const [first, ...rest] = clients;
	if (first === undefined) throw new Error("no client");
	const metered = meterLibsqlClient(first);
	const ports: [EphemeralStatePort, ...EphemeralStatePort[]] = [
		createLibsqlEphemeralState({ client: metered, now: clock.now }),
		...rest.map((client) =>
			createLibsqlEphemeralState({ client, now: clock.now }),
		),
	];
	return lane(
		clients,
		ports,
		metered,
		async (ms) => clock.advance(ms),
		1_000,
		`${kind}:`,
		() => database?.remove(),
	);
}

/** `file:` with the database's clock: TTLs are real, so `advanceTime` sleeps. */
export function serverClockLane(ttlMs: number): LibsqlLane {
	const database = temporaryDatabase();
	const clients = [0, 1].map(() =>
		createClient({ url: database.url, timeout: 10_000 }),
	);
	const [first, second] = clients;
	if (first === undefined || second === undefined) throw new Error("no client");
	const metered = meterLibsqlClient(first);
	return lane(
		clients,
		[
			createLibsqlEphemeralState({ client: metered }),
			createLibsqlEphemeralState({ client: second }),
		],
		metered,
		(ms) => sleep(ms),
		ttlMs,
		"server-clock:",
		() => database.remove(),
	);
}

type PortMethod = keyof EphemeralStatePort;
type PortResult = Awaited<ReturnType<EphemeralStatePort[PortMethod]>> | null;
type PortArg = Parameters<EphemeralStatePort[PortMethod]>[number];

type Reply =
	| { readonly id: number; readonly ok: true; readonly result: PortResult }
	| {
			readonly id: number;
			readonly ok: false;
			readonly error: ReplyError;
	  };

type ReplyError = {
	readonly name: string;
	readonly message: string;
	readonly code: string | null;
};

type Waiter = {
	resolve(value: PortResult): void;
	reject(error: Error): void;
};

type WorkerPort = {
	readonly port: EphemeralStatePort;
	close(): Promise<void>;
};

function replyError(error: ReplyError): Error {
	const code = KV_REDIS_ERROR_CODES.find((known) => known === error.code);
	return code === undefined
		? new Error(`${error.name}: ${error.message}`)
		: new KvRedisCompatibleError(code, error.message);
}

/** A port whose calls run on a worker thread's own client of `url`. */
function workerPort(url: string, clock: SharedArrayBuffer): WorkerPort {
	const worker = new Worker(new URL("./port-worker.mts", import.meta.url), {
		workerData: { url, clock },
	});
	let next = 0;
	const pending = new Map<number, Waiter>();
	worker.on("message", (reply: Reply) => {
		const waiter = pending.get(reply.id);
		pending.delete(reply.id);
		if (waiter === undefined) return;
		if (reply.ok) waiter.resolve(reply.result);
		else waiter.reject(replyError(reply.error));
	});
	const send = (method: PortMethod | "close", args: readonly PortArg[]) =>
		new Promise<PortResult>((resolve, reject) => {
			next += 1;
			pending.set(next, { resolve, reject });
			worker.postMessage({ id: next, method, args });
		});
	function call<M extends PortMethod>(
		method: M,
		args: Parameters<EphemeralStatePort[M]>,
	): ReturnType<EphemeralStatePort[M]> {
		// SAFETY: the worker answers method M with the structured clone of its own port's M result.
		return send(method, args) as ReturnType<EphemeralStatePort[M]>;
	}
	const port: EphemeralStatePort = {
		get: (...args) => call("get", args),
		getMany: (...args) => call("getMany", args),
		putIfAbsent: (...args) => call("putIfAbsent", args),
		compareAndSet: (...args) => call("compareAndSet", args),
		delete: (...args) => call("delete", args),
		increment: (...args) => call("increment", args),
		expire: (...args) => call("expire", args),
	};
	return {
		port,
		async close() {
			await send("close", []);
			await worker.terminate();
		},
	};
}

/** One client here and three in worker threads, all on one `file:` database. */
export async function workerLane(): Promise<LibsqlLane> {
	const clock = sharedClock(1_000_000);
	const database = temporaryDatabase();
	const first = createClient({ url: database.url, timeout: 10_000 });
	const metered = meterLibsqlClient(first);
	const local = createLibsqlEphemeralState({ client: metered, now: clock.now });
	// Create the table before the workers race to.
	await local.get(parseEphemeralKey("worker:warm"));
	const workers = [0, 1, 2].map(() => workerPort(database.url, clock.buffer));
	return lane(
		[first],
		[local, ...workers.map((worker) => worker.port)],
		metered,
		async (ms) => clock.advance(ms),
		1_000,
		"worker:",
		async () => {
			await Promise.all(workers.map((worker) => worker.close()));
			database.remove();
		},
	);
}
