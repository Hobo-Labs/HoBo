/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: this test harness validates IPC replies from its own worker. */
import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DurableMessagingConformanceHarness } from "@hobo/conformance";
import {
	DURABLE_TOPIC_REDUCER_CAPABILITIES as RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
	DURABLE_TOPIC_REDUCER_LIMITS as RIVET_DURABLE_TOPIC_BUS_LIMITS,
} from "@hobo/runtime/durable-topic-reducer";
import { createRivetDurableTopicMetadataGrant } from "../../src/durable-topic-client.js";
import { signFixtureClaim } from "./durable-topic-bus-conformance.js";
import type { RivetMessagingConformanceHost } from "./durable-topic-conformance.js";

const loader = createRequire(import.meta.url).resolve("tsx");
const workerFile = fileURLToPath(
	new URL("./durable-topic-bus-process.mjs", import.meta.url),
);
const actorName = "hoboTopic";
const semanticDigest = `sha256:${"b".repeat(64)}`;
type WorkerReply = null | { status: number; body: string };
type WorkerRequest =
	| { kind: "advance"; delta: number }
	| {
			kind: "fetch";
			tenant: "tenant-a" | "tenant-b";
			path: string;
			headers: Record<string, string>;
			body: string;
	  };
type Pending = {
	resolve: (value: WorkerReply) => void;
	reject: (error: Error) => void;
};
type Worker = {
	child: ChildProcess;
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	call: (message: WorkerRequest) => Promise<WorkerReply>;
	pending: Map<number, Pending>;
};

async function startWorker(
	directory: string,
	clock: number,
	afterReady?: (pid: number) => Promise<void>,
): Promise<Worker> {
	const child = fork(workerFile, [directory, String(clock)], {
		execArgv: ["--import", loader],
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	const pending = new Map<number, Pending>();
	let serial = 0;
	let ready = () => {};
	let failed = (_error: Error) => {};
	const started = new Promise<void>((resolve, reject) => {
		ready = resolve;
		failed = reject;
	});
	const exited = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve) => {
		child.once("exit", (code, signal) => {
			failed(new Error("worker exited before ready"));
			for (const item of pending.values())
				item.reject(new Error("worker exited"));
			pending.clear();
			resolve({ code, signal });
		});
		child.once("error", (error) => {
			failed(error);
			for (const item of pending.values()) item.reject(error);
			pending.clear();
			if (child.pid === undefined) resolve({ code: null, signal: null });
		});
	});
	child.on("message", (raw) => {
		if (typeof raw !== "object" || raw === null) return;
		// SAFETY: IPC data is deserialized by Node; every used field is checked below.
		const message = raw as {
			kind?: string;
			id?: number;
			error?: string;
			result?: unknown;
		};
		if (message.kind === "ready") {
			ready();
			return;
		}
		if (typeof message.id !== "number") return;
		const item = pending.get(message.id);
		if (!item) return;
		pending.delete(message.id);
		if (message.error !== undefined)
			item.reject(new Error("worker request failed"));
		else if (message.result === null) item.resolve(null);
		else if (
			typeof message.result === "object" &&
			message.result !== null &&
			"status" in message.result &&
			"body" in message.result &&
			typeof message.result.status === "number" &&
			Number.isInteger(message.result.status) &&
			message.result.status >= 200 &&
			message.result.status <= 599 &&
			typeof message.result.body === "string" &&
			Buffer.byteLength(message.result.body) <= 262_144
		)
			item.resolve({
				status: message.result.status,
				body: message.result.body,
			});
		else item.reject(new Error("invalid worker response"));
	});
	child.stdout?.resume();
	child.stderr?.resume();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error("worker start timed out")),
			10_000,
		);
	});
	try {
		await Promise.race([
			started.then(async () => {
				if (afterReady !== undefined) {
					if (child.pid === undefined) throw new Error("worker has no pid");
					await afterReady(child.pid);
				}
			}),
			timeout,
		]);
	} catch (error) {
		child.kill("SIGKILL");
		await exited;
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	return {
		child,
		exited,
		pending,
		call: (message) =>
			new Promise((resolve, reject) => {
				const id = ++serial;
				const timer = setTimeout(() => {
					pending.delete(id);
					child.kill("SIGKILL");
					reject(new Error("worker call timed out"));
				}, 10_000);
				const done = (value: WorkerReply) => {
					clearTimeout(timer);
					resolve(value);
				};
				const fail = (error: Error) => {
					clearTimeout(timer);
					reject(error);
				};
				pending.set(id, { resolve: done, reject: fail });
				try {
					child.send({ ...message, id }, (error) => {
						if (!error) return;
						pending.delete(id);
						fail(error);
					});
				} catch (error) {
					pending.delete(id);
					fail(
						error instanceof Error ? error : new Error("worker send failed"),
					);
				}
			}),
	};
}
async function stopWorker(worker: Worker, allowExited = false): Promise<void> {
	const hadPending = worker.pending.size !== 0;
	if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
		await worker.exited;
		if (!allowExited || hadPending)
			throw new Error("worker exited before termination");
		return;
	}
	if (!worker.child.kill("SIGTERM")) {
		await worker.exited;
		throw new Error("worker did not accept termination");
	}
	const timer = setTimeout(() => worker.child.kill("SIGKILL"), 5_000);
	try {
		const result = await worker.exited;
		if (result.signal !== "SIGTERM")
			throw new Error("worker did not terminate with SIGTERM");
		if (hadPending) throw new Error("worker terminated with in-flight calls");
	} finally {
		clearTimeout(timer);
	}
}

export async function createProcessBusConformanceHost(
	options: { readonly afterRestartReady?: (pid: number) => Promise<void> } = {},
): Promise<RivetMessagingConformanceHost> {
	const directory = await mkdtemp(join(tmpdir(), "hobo-rivet-bus-process-"));
	let clock = 1_000;
	let worker: Worker;
	try {
		worker = await startWorker(directory, clock);
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	let epoch = 0;
	let closed = false;
	let changing = false;
	let transition: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let drop: "throw" | "disconnect" | undefined;
	let barrier:
		| { reached: () => void; wait: Promise<void>; release: () => void }
		| undefined;
	const releases: Array<() => void> = [];
	const grants: Array<ReturnType<typeof createRivetDurableTopicMetadataGrant>> =
		[];
	const unavailable = async (): Promise<never> => {
		throw new Error("fixture control unavailable");
	};
	const controls: Omit<DurableMessagingConformanceHarness, "connect"> = {
		async restart() {
			if (closed || changing) throw new Error("fixture is not available");
			changing = true;
			epoch++;
			for (const grant of grants.splice(0)) grant.revoke();
			transition = (async () => {
				await stopWorker(worker);
				if (closed) throw new Error("fixture closed during restart");
				worker = await startWorker(directory, clock, options.afterRestartReady);
				if (closed) throw new Error("fixture closed during restart");
			})();
			try {
				await transition;
			} finally {
				transition = undefined;
				changing = false;
			}
		},
		async close() {
			if (closing !== undefined) return closing;
			closed = true;
			epoch++;
			for (const release of releases) release();
			for (const grant of grants.splice(0)) grant.revoke();
			closing = (async () => {
				try {
					if (transition !== undefined) await transition.catch(() => {});
				} finally {
					try {
						await stopWorker(worker, true);
					} finally {
						await rm(directory, { recursive: true, force: true });
					}
				}
			})();
			return closing;
		},
		nowMs: () => clock,
		async advanceMs(delta) {
			if ((await worker.call({ kind: "advance", delta })) !== null)
				throw new Error("invalid clock response");
			clock += delta;
		},
		async loseNextMutationResponse(point) {
			if (point !== "after-commit") return unavailable();
			drop = "throw";
		},
		async loseNextMutationTransport(mode) {
			drop = mode;
		},
		rejectNextDeadLetterWrite: unavailable,
		blockNextReceiptLookup: unavailable,
		switchAuthority: unavailable,
		holdConcurrentMutations: unavailable,
		async holdNextMutation(point) {
			if (point !== "before-dispatch" || barrier !== undefined)
				return unavailable();
			let reached = () => {};
			const reachedPromise = new Promise<void>((resolve) => {
				reached = resolve;
			});
			let release = () => {};
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			barrier = { reached, wait, release };
			releases.push(release);
			return { reached: reachedPromise, release: async () => release() };
		},
	};
	return {
		controls,
		async open(tenant) {
			if (closed || changing) throw new Error("fixture is not available");
			const boundEpoch = epoch;
			const grant = createRivetDurableTopicMetadataGrant();
			grants.push(grant);
			const fetch = async (path: string, init: RequestInit) => {
				if (closed || boundEpoch !== epoch)
					throw new Error("old worker fenced");
				const held = barrier;
				if (held !== undefined && path !== "/events") {
					barrier = undefined;
					held.reached();
					await held.wait;
					if (closed || boundEpoch !== epoch)
						throw new Error("old worker fenced");
				}
				if (typeof init.body !== "string")
					throw new Error("invalid request body");
				const response = await worker.call({
					kind: "fetch",
					tenant,
					path,
					headers: Object.fromEntries(new Headers(init.headers).entries()),
					body: init.body,
				});
				if (response === null) throw new Error("invalid worker response");
				if (drop !== undefined && path !== "/events") {
					const mode = drop;
					drop = undefined;
					const outcome: { status?: string } = JSON.parse(response.body);
					if (outcome.status !== "committed")
						throw new Error("fault did not follow commit");
					if (mode === "throw") throw new Error("test lost committed reply");
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.error(
									new Error("test disconnected committed reply"),
								);
							},
						}),
					);
				}
				return new Response(response.body, { status: response.status });
			};
			return {
				binding: {
					actorName,
					actorKey: [tenant],
					tenant,
					instance: "orders",
					semanticDigest,
					limits: RIVET_DURABLE_TOPIC_BUS_LIMITS,
					actorCapabilities: RIVET_DURABLE_TOPIC_BUS_CAPABILITIES,
				},
				metadataGrant: grant,
				verifyTransport: (claim) =>
					!closed && boundEpoch === epoch && claim.fetch === fetch,
				authorize: (claim) => ({
					"x-hobo-proof": signFixtureClaim(claim, "request"),
					"x-hobo-instance-proof": signFixtureClaim(claim, "instance"),
				}),
				revalidate: () => !closed && boundEpoch === epoch,
				fetch,
			};
		},
	};
}
