/**
 * A libSQL client of the ephemeral-state port in its own thread, so the
 * concurrency cases race independent connections to one `file:` database
 * instead of statements queued on one event loop.
 *
 * Runs as plain Node (type stripping), so it loads the package's built
 * `dist/` — `pretest` builds it — and `@libsql/client`'s Node entry point.
 * The clock is a shared `BigInt64Array` the main thread advances.
 */
import { parentPort, workerData } from "node:worker_threads";

import type { EphemeralStatePort } from "@hobo/core";
import { KvRedisCompatibleError } from "@hobo/kv-redis-compatible";
import { createClient } from "@libsql/client";

import { createLibsqlEphemeralState } from "../../dist/index.js";

type WorkerSetup = {
	readonly url: string;
	readonly clock: SharedArrayBuffer;
};

type PortMethod = keyof EphemeralStatePort;

type PortCall =
	| {
			[M in PortMethod]: {
				readonly id: number;
				readonly method: M;
				readonly args: Parameters<EphemeralStatePort[M]>;
			};
	  }[PortMethod]
	| { readonly id: number; readonly method: "close"; readonly args: [] };

type PortResult = Awaited<ReturnType<EphemeralStatePort[PortMethod]>> | null;

const setup: WorkerSetup = workerData;
const clock = new BigInt64Array(setup.clock);
const client = createClient({ url: setup.url, timeout: 10_000 });
const port = createLibsqlEphemeralState({
	client,
	now: () => Number(Atomics.load(clock, 0)),
	purge: false,
});

async function dispatch(call: PortCall): Promise<PortResult> {
	switch (call.method) {
		case "close":
			client.close();
			return null;
		case "get":
			return port.get(...call.args);
		case "getMany":
			return port.getMany(...call.args);
		case "putIfAbsent":
			return port.putIfAbsent(...call.args);
		case "compareAndSet":
			return port.compareAndSet(...call.args);
		case "delete":
			return port.delete(...call.args);
		case "increment":
			return port.increment(...call.args);
		case "expire":
			return port.expire(...call.args);
	}
}

parentPort?.on("message", async (call: PortCall) => {
	try {
		parentPort?.postMessage({
			id: call.id,
			ok: true,
			result: await dispatch(call),
		});
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		parentPort?.postMessage({
			id: call.id,
			ok: false,
			error: {
				name: failure.name,
				message: failure.message,
				code: failure instanceof KvRedisCompatibleError ? failure.code : null,
			},
		});
	}
});
