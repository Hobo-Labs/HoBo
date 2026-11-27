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

const NativePromise = Promise;
const nativeThen = Promise.prototype.then;
const nativeApply = Reflect.apply;
const nativeSetHas = Set.prototype.has;
const nativeSetAdd = Set.prototype.add;
const nativeSetDelete = Set.prototype.delete;
const nativeCreate = Object.create;
const nativeDefine = Object.defineProperty;
const nativeFreeze = Object.freeze;
const nativeBigInt = BigInt;
const nativeIsArray = Array.isArray;
const nativeIsSafeInteger = Number.isSafeInteger;
const nativeSchedule = setTimeout;
const nativeCancel = clearTimeout;
const monotonicNow = performance.now.bind(performance);

function variant<Tag extends string, Value>(
	tag: Tag,
	value: Value,
): { tag: Tag; val: Value } {
	// SAFETY: the two own data fields are defined before the value is returned.
	const result = nativeCreate(null) as { tag: Tag; val: Value };
	nativeDefine(result, "tag", { value: tag, enumerable: true });
	nativeDefine(result, "val", { value, enumerable: true });
	return nativeFreeze(result);
}
function unavailable(): { tag: "unavailable" } {
	// SAFETY: the own discriminant is defined before the value is returned.
	const result = nativeCreate(null) as { tag: "unavailable" };
	nativeDefine(result, "tag", { value: "unavailable", enumerable: true });
	return nativeFreeze(result);
}

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
		!nativeIsSafeInteger(options.maxInFlight) ||
		options.maxInFlight < 1 ||
		options.maxInFlight > 1000 ||
		!nativeIsSafeInteger(options.timeoutMs) ||
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
	) =>
		variant(status, {
			id: operation.id,
			expiresAtMs: nativeBigInt(operation.expiresAtMs),
		});
	const validNow = () => {
		const current = now();
		if (!nativeIsSafeInteger(current) || current < 0)
			throw new TypeError("durable_queue.invalid_clock");
		return current;
	};
	const run = <T>(
		operation: DurableQueueOperation | undefined,
		work: (alive: () => boolean) => Promise<T>,
	): Promise<T> => {
		if (
			active >= maxInFlight ||
			(operation !== undefined &&
				nativeApply(nativeSetHas, pending, [operation.id]))
		)
			return new NativePromise((_resolve, reject) =>
				reject(new Error("durable_queue.host_capacity")),
			);
		active++;
		if (operation !== undefined)
			nativeApply(nativeSetAdd, pending, [operation.id]);
		let expired = false;
		const deadline = monotonicNow() + timeoutMs;
		const alive = () => !expired && monotonicNow() < deadline;
		return new NativePromise<T>((resolve, reject) => {
			const timer = nativeSchedule(() => {
				expired = true;
				reject(new Error("durable_queue.host_timeout"));
			}, timeoutMs);
			const finish = () => {
				active--;
				if (operation !== undefined)
					nativeApply(nativeSetDelete, pending, [operation.id]);
				nativeCancel(timer);
			};
			try {
				const task = work(alive);
				nativeApply(nativeThen, task, [
					(value: T) => {
						finish();
						resolve(value);
					},
					(error: unknown) => {
						finish();
						reject(error);
					},
				]);
			} catch (error) {
				expired = true;
				finish();
				reject(error);
			}
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
				try {
					const dispatch = nativeFreeze({
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
					const disclose = nativeFreeze({
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
						return variant("rejected", result.code);
					if (expected.kind === "dequeue") {
						if (!nativeIsArray(result.value))
							throw new TypeError("durable_queue.invalid_response");
						const deliveries: Wit.LeasedMessage[] = [];
						for (let index = 0; index < result.value.length; index++) {
							const value = result.value[index];
							if (value === undefined)
								throw new TypeError("durable_queue.invalid_response");
							deliveries[index] = {
								...value,
								leaseExpiresAtMs: nativeBigInt(value.leaseExpiresAtMs),
							};
						}
						return variant("committed", deliveries);
					}
					if (expected.kind === "extension") {
						if (!("leaseExpiresAtMs" in result.value))
							throw new TypeError("durable_queue.invalid_response");
						return variant("committed", {
							...result.value,
							leaseExpiresAtMs: nativeBigInt(result.value.leaseExpiresAtMs),
						});
					}
					if (expected.kind === "enqueue") {
						if (!("idempotencyKey" in result.value))
							throw new TypeError("durable_queue.invalid_response");
						return variant("committed", {
							messageId: result.value.messageId,
							idempotencyKey: result.value.idempotencyKey,
						});
					}
					if (!("messageId" in result.value) || !("leaseId" in result.value))
						throw new TypeError("durable_queue.invalid_response");
					return variant("committed", {
						messageId: result.value.messageId,
						leaseId: result.value.leaseId,
					});
				} catch {
					return operationResult("unknown", op);
				}
			});
		} catch {
			return operationResult("unknown", op);
		}
	}
	const fromInput = <T>(start: () => Promise<T>): Promise<T> => {
		try {
			return start();
		} catch (error) {
			return new NativePromise((_resolve, reject) => reject(error));
		}
	};
	const host: DurableQueueWitHost = {
		async limits() {
			try {
				return await run(undefined, async (alive) => {
					try {
						if (
							!alive() ||
							(await authorize(
								nativeFreeze({ method: "limits", phase: "dispatch" }),
							)) !== true ||
							!alive()
						)
							return unavailable();
						const value = {
							...limits,
							delayMs: nativeBigInt(limits.delayMs),
							leaseMs: nativeBigInt(limits.leaseMs),
							operationWindowMs: nativeBigInt(limits.operationWindowMs),
						};
						if (
							(await authorize(
								nativeFreeze({ method: "limits", phase: "disclose" }),
							)) !== true ||
							!alive()
						)
							return unavailable();
						return variant("available", value);
					} catch {
						return unavailable();
					}
				});
			} catch {
				return unavailable();
			}
		},
		enqueue(input) {
			return fromInput(() =>
				invoke("enqueue", parseQueueEnqueue(input, limits)),
			);
		},
		dequeue(input) {
			return fromInput(() =>
				invoke("dequeue", parseQueueDequeue(input, limits)),
			);
		},
		complete(input) {
			return fromInput(() =>
				invoke("complete", parseQueueSettlement(input, limits, false)),
			);
		},
		release(input) {
			return fromInput(() =>
				invoke("release", parseQueueSettlement(input, limits, false)),
			);
		},
		extendLease(input) {
			return fromInput(() =>
				invoke("extendLease", parseQueueSettlement(input, limits, true)),
			);
		},
	};
	return nativeFreeze(host);
}

export function createDurableQueueWitImports(
	port: DurableQueue,
	options: DurableQueueHostOptions,
): Readonly<{ [DURABLE_QUEUE_WIT_INTERFACE]: DurableQueueWitHost }> {
	return nativeFreeze({
		[DURABLE_QUEUE_WIT_INTERFACE]: createDurableQueueWitHost(port, options),
	});
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */
