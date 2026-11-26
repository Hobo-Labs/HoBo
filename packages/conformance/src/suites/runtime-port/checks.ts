import { parseIdempotencyKey, parseQueueName } from "@hobo/core";
import { isJsonObject, type JsonValue } from "../../json.js";

import { proveCheckoutDurability } from "./checkout-proof.js";
import { type RuntimeDurabilityBackend, readEventStream } from "./types.js";

type CheckDefinition = {
	checkId: string;
	port: string;
	failureMessage: string;
	run: (backend: RuntimeDurabilityBackend) => boolean | Promise<boolean>;
};

export const RUNTIME_PORT_CHECKS: readonly CheckDefinition[] = Object.freeze([
	Object.freeze({
		checkId: "eventStore.local.seq-conditional-append",
		port: "EventStore",
		failureMessage: "stale expectedSeq append was accepted",
		run: provesSeqConditionalAppend,
	}),
	Object.freeze({
		checkId: "eventStore.local.idempotency-key-dedup",
		port: "EventStore",
		failureMessage: "duplicate EventStore idempotency key was appended twice",
		run: provesEventStoreIdempotency,
	}),
	Object.freeze({
		checkId: "queue.local.idempotency-key-dedup",
		port: "Queue",
		failureMessage: "duplicate Queue idempotency key was enqueued twice",
		run: provesQueueIdempotency,
	}),
	Object.freeze({
		checkId: "actorHost.local.stale-fence-rejected",
		port: "ActorHost",
		failureMessage: "stale lease append was accepted",
		run: provesActorHostStaleFence,
	}),
	Object.freeze({
		checkId: "runtime.local.checkout-replay-equals-live",
		port: "Runtime",
		failureMessage: "checkout replay state diverged from live state",
		run: provesCheckoutReplayEqualsLive,
	}),
]);

async function provesSeqConditionalAppend(backend: RuntimeDurabilityBackend) {
	const { eventStore } = backend;
	await eventStore.append(
		"seq-check",
		[{ type: "seq.Started", data: {} }],
		appendOptions(0, "seq-started"),
	);

	try {
		await eventStore.append(
			"seq-check",
			[{ type: "seq.Raced", data: {} }],
			appendOptions(0, "seq-raced"),
		);
		return false;
	} catch {
		return (await readEventStream(eventStore, "seq-check")).length === 1;
	}
}

async function provesEventStoreIdempotency(backend: RuntimeDurabilityBackend) {
	const { eventStore } = backend;
	const event = {
		type: "payment.Captured",
		data: { cents: 4200 },
		meta: { idempotencyKey: "payment-1" },
	};

	await eventStore.append(
		"eventstore-dedup",
		[event],
		appendOptions(0, "payment"),
	);
	const retry = await eventStore.append(
		"eventstore-dedup",
		[event],
		appendOptions(0, "payment-retry"),
	);

	return (
		retry.appended.length === 0 &&
		retry.deduped.length === 1 &&
		(await readEventStream(eventStore, "eventstore-dedup")).length === 1
	);
}

async function provesQueueIdempotency(backend: RuntimeDurabilityBackend) {
	const { queue } = backend;
	const queueName = parseQueueName("payments");
	const first = await queue.enqueue(
		queueName,
		{ cents: 4200 },
		{ idempotencyKey: parseIdempotencyKey("charge-1") },
	);
	const retry = await queue.enqueue(
		queueName,
		{ cents: 4200 },
		{ idempotencyKey: parseIdempotencyKey("charge-1") },
	);

	return retry.deduped === true && retry.messageId === first.messageId;
}

function provesActorHostStaleFence(backend: RuntimeDurabilityBackend) {
	const key = "actor:checkout:stale-fence";
	const state = backend.actorHost.state(key, {
		initialState: { value: 0 },
		fold: (
			current: { value: number },
			event: { type: string; amount?: number },
		) =>
			event.type === "counter.Added"
				? { value: current.value + (event.amount ?? 0) }
				: current,
	});
	const firstLease = backend.actorHost.acquire(key, { holderId: "worker-a" });
	state.append(firstLease, { type: "counter.Added", amount: 1 });
	firstLease.release();
	const secondLease = backend.actorHost.acquire(key, { holderId: "worker-b" });

	try {
		state.append(firstLease, { type: "counter.Added", amount: 100 });
		return false;
	} catch {
		state.append(secondLease, { type: "counter.Added", amount: 2 });
		return state.read().state.value === 3;
	}
}

async function provesCheckoutReplayEqualsLive(
	backend: RuntimeDurabilityBackend,
) {
	const proof = await proveCheckoutDurability(backend);
	return (
		stableStringify(proof.liveState) === stableStringify(proof.replayState)
	);
}

function appendOptions(expectedSeq: number, correlationId: string) {
	return {
		expectedSeq,
		actor: { kind: "system" as const, id: "runtime-port-conformance" },
		tenant: "conformance-tenant",
		correlationId,
	};
}

function stableStringify(value: JsonValue) {
	return JSON.stringify(stableValue(value));
}

function stableValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return value.map(stableValue);
	}
	if (value && isJsonObject(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, stableValue(entry)]),
		);
	}
	return value;
}
