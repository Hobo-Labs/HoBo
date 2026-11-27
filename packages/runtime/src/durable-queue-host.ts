import { performance } from "node:perf_hooks";
import {
	DURABLE_QUEUE_WIT_INTERFACE,
	type DurableQueue,
	type DurableQueueOperation,
	parseDurableQueueLimits,
} from "@hobo/core";
import type * as Wit from "@hobo/wit/queue";
import {
	parseQueueDequeue,
	parseQueueEnqueue,
	parseQueueProviderOutcome,
	parseQueueSettlement,
} from "./durable-queue-boundary.js";

export type DurableQueueWitHost = Pick<
	typeof Wit,
	"limits" | "enqueue" | "dequeue" | "complete" | "release" | "extendLease"
>;
export type DurableQueueMethod =
	| "enqueue"
	| "dequeue"
	| "complete"
	| "release"
	| "extendLease";
export interface DurableQueueHostOptions {
	readonly limits: unknown;
	readonly authorize: (
		request: Readonly<{
			method: DurableQueueMethod | "limits";
			phase: "dispatch" | "disclose";
			operation?: DurableQueueOperation;
		}>,
	) => boolean | Promise<boolean>;
	readonly maxInFlight: number;
	readonly timeoutMs: number;
	readonly now: () => number;
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: the host must bound and validate untrusted component and provider values. */
export function createDurableQueueWitHost(
	port: DurableQueue,
	options: DurableQueueHostOptions,
): DurableQueueWitHost {
	const limits = parseDurableQueueLimits(options.limits);
	if (
		!Number.isSafeInteger(options.maxInFlight) ||
		options.maxInFlight < 1 ||
		options.maxInFlight > 1000 ||
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1 ||
		options.timeoutMs > 300_000 ||
		typeof options.now !== "function" ||
		typeof options.authorize !== "function"
	)
		throw new TypeError("durable_queue.invalid_host_options");
	const maxInFlight = options.maxInFlight;
	const timeoutMs = options.timeoutMs;
	const authorize = options.authorize;
	const now = options.now;
	const methods = {
		enqueue: port.enqueue.bind(port),
		dequeue: port.dequeue.bind(port),
		complete: port.complete.bind(port),
		release: port.release.bind(port),
		extendLease: port.extendLease.bind(port),
	};
	let active = 0;
	const pending = new Set<string>();
	const operationResult = (
		status: "unknown" | "expired",
		operation: DurableQueueOperation,
	) => ({
		tag: status,
		val: { id: operation.id, expiresAtMs: BigInt(operation.expiresAtMs) },
	});
	const validNow = () => {
		const current = now();
		if (!Number.isSafeInteger(current) || current < 0)
			throw new TypeError("durable_queue.invalid_clock");
		return current;
	};
	const run = async <T>(
		operation: DurableQueueOperation | undefined,
		work: (alive: () => boolean) => Promise<T>,
	): Promise<T> => {
		if (
			active >= maxInFlight ||
			(operation !== undefined && pending.has(operation.id))
		)
			throw new Error("durable_queue.host_capacity");
		active++;
		if (operation !== undefined) pending.add(operation.id);
		let expired = false;
		const deadline = performance.now() + timeoutMs;
		const alive = () => !expired && performance.now() < deadline;
		const task = Promise.resolve()
			.then(() => work(alive))
			.finally(() => {
				active--;
				if (operation !== undefined) pending.delete(operation.id);
			});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				expired = true;
				reject(new Error("durable_queue.host_timeout"));
			}, timeoutMs);
		});
		return Promise.race([task, timeout]).finally(() => {
			if (timer !== undefined) clearTimeout(timer);
		});
	};
	function invoke(
		method: "enqueue",
		input: Parameters<DurableQueue["enqueue"]>[0],
	): Promise<Wit.EnqueueOutcome>;
	function invoke(
		method: "dequeue",
		input: Parameters<DurableQueue["dequeue"]>[0],
	): Promise<Wit.DequeueOutcome>;
	function invoke(
		method: "complete" | "release",
		input: Parameters<DurableQueue["complete"]>[0],
	): Promise<Wit.SettlementOutcome>;
	function invoke(
		method: "extendLease",
		input: Parameters<DurableQueue["extendLease"]>[0],
	): Promise<Wit.ExtensionOutcome>;
	async function invoke(
		method: DurableQueueMethod,
		input:
			| Parameters<DurableQueue["enqueue"]>[0]
			| Parameters<DurableQueue["dequeue"]>[0]
			| Parameters<DurableQueue["complete"]>[0]
			| Parameters<DurableQueue["extendLease"]>[0],
	): Promise<
		| Wit.EnqueueOutcome
		| Wit.DequeueOutcome
		| Wit.SettlementOutcome
		| Wit.ExtensionOutcome
	> {
		const op = input.operation;
		try {
			const current = validNow();
			if (current >= op.expiresAtMs) return operationResult("expired", op);
			if (op.expiresAtMs - current > limits.operationWindowMs)
				return operationResult("unknown", op);
			return await run(op, async (alive) => {
				const dispatch = Object.freeze({
					method,
					phase: "dispatch" as const,
					operation: op,
				});
				if (!alive() || (await authorize(dispatch)) !== true || !alive())
					return operationResult("unknown", op);
				const before = validNow();
				if (before >= op.expiresAtMs) return operationResult("expired", op);
				let reply: unknown;
				let expected: Parameters<typeof parseQueueProviderOutcome>[3];
				if (method === "enqueue" && "message" in input) {
					if (
						input.message.availableAtMs !== undefined &&
						input.message.availableAtMs > before &&
						input.message.availableAtMs - before > limits.delayMs
					)
						return operationResult("unknown", op);
					expected = {
						kind: "enqueue",
						idempotencyKey: input.message.idempotencyKey,
					};
					reply = await methods.enqueue(input);
				} else if (method === "dequeue" && "maxMessages" in input) {
					expected = { kind: "dequeue", maxMessages: input.maxMessages };
					reply = await methods.dequeue(input);
				} else if (
					method === "extendLease" &&
					"visibilityTimeoutMs" in input &&
					"messageId" in input
				) {
					expected = {
						kind: "extension",
						messageId: input.messageId,
						leaseId: input.leaseId,
					};
					reply = await methods.extendLease(input);
				} else if (
					(method === "complete" || method === "release") &&
					"messageId" in input
				) {
					expected = {
						kind: "settlement",
						messageId: input.messageId,
						leaseId: input.leaseId,
					};
					reply = await methods[method](input);
				} else throw new TypeError("durable_queue.invalid_method");
				if (!alive()) return operationResult("unknown", op);
				const disclose = Object.freeze({
					method,
					phase: "disclose" as const,
					operation: op,
				});
				if ((await authorize(disclose)) !== true || !alive())
					return operationResult("unknown", op);
				const result = parseQueueProviderOutcome(reply, op, limits, expected);
				if (!alive()) return operationResult("unknown", op);
				if (result.status === "unknown" || result.status === "expired")
					return operationResult(result.status, op);
				if (result.status === "rejected")
					return { tag: "rejected", val: result.code };
				if (expected.kind === "dequeue") {
					if (!Array.isArray(result.value))
						throw new TypeError("durable_queue.invalid_response");
					return {
						tag: "committed",
						val: result.value.map((value) => ({
							...value,
							leaseExpiresAtMs: BigInt(value.leaseExpiresAtMs),
						})),
					};
				}
				if (expected.kind === "extension") {
					if (!("leaseExpiresAtMs" in result.value))
						throw new TypeError("durable_queue.invalid_response");
					return {
						tag: "committed",
						val: {
							...result.value,
							leaseExpiresAtMs: BigInt(result.value.leaseExpiresAtMs),
						},
					};
				}
				if (expected.kind === "enqueue") {
					if (!("idempotencyKey" in result.value))
						throw new TypeError("durable_queue.invalid_response");
					return {
						tag: "committed",
						val: {
							messageId: result.value.messageId,
							idempotencyKey: result.value.idempotencyKey,
						},
					};
				}
				if (!("messageId" in result.value) || !("leaseId" in result.value))
					throw new TypeError("durable_queue.invalid_response");
				return {
					tag: "committed",
					val: {
						messageId: result.value.messageId,
						leaseId: result.value.leaseId,
					},
				};
			});
		} catch {
			return operationResult("unknown", op);
		}
	}
	const host: DurableQueueWitHost = {
		async limits() {
			try {
				return await run(undefined, async (alive) => {
					if (
						!alive() ||
						(await authorize(
							Object.freeze({ method: "limits", phase: "dispatch" }),
						)) !== true ||
						!alive()
					)
						return { tag: "unavailable" };
					const value = {
						...limits,
						delayMs: BigInt(limits.delayMs),
						leaseMs: BigInt(limits.leaseMs),
						operationWindowMs: BigInt(limits.operationWindowMs),
					};
					if (
						(await authorize(
							Object.freeze({ method: "limits", phase: "disclose" }),
						)) !== true ||
						!alive()
					)
						return { tag: "unavailable" };
					return { tag: "available", val: value };
				});
			} catch {
				return { tag: "unavailable" };
			}
		},
		async enqueue(input) {
			return invoke("enqueue", parseQueueEnqueue(input, limits));
		},
		async dequeue(input) {
			return invoke("dequeue", parseQueueDequeue(input, limits));
		},
		async complete(input) {
			return invoke("complete", parseQueueSettlement(input, limits, false));
		},
		async release(input) {
			return invoke("release", parseQueueSettlement(input, limits, false));
		},
		async extendLease(input) {
			return invoke("extendLease", parseQueueSettlement(input, limits, true));
		},
	};
	return Object.freeze(host);
}

export function createDurableQueueWitImports(
	port: DurableQueue,
	options: DurableQueueHostOptions,
): Readonly<{ [DURABLE_QUEUE_WIT_INTERFACE]: DurableQueueWitHost }> {
	return Object.freeze({
		[DURABLE_QUEUE_WIT_INTERFACE]: createDurableQueueWitHost(port, options),
	});
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */
