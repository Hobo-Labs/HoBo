import {
	DURABLE_MESSAGING_LIMITS,
	type DurableMessaging,
	type DurableMessagingDelivery,
	type DurableMessagingLimits,
	type DurableMessagingOperation,
	type DurableMessagingOutcome,
	durableMessagingOperation,
} from "@hobo/core";

// public-contract: version of the bounded durable-messaging conformance suite.
export const DURABLE_MESSAGING_CONFORMANCE =
	"hobo.durable-messaging-conformance/v1";

export type DurableMessagingConformanceCase = (typeof DURABLE_CASES)[number][0];

/**
 * A harness must exercise the actual provider. `restart` must destroy its live
 * process/client and reopen the same durable state; it cannot just return.
 * Faults lose the response before or after the next provider commit while the
 * client cannot determine which occurred. The test clock is independently
 * controlled and nondecreasing. Connect returns separately authenticated
 * clients; the two tenant labels must have independent scopes.
 */
export interface DurableMessagingConformanceHarness {
	connect(tenant: "tenant-a" | "tenant-b"): Promise<DurableMessaging>;
	restart(): Promise<void>;
	close(): Promise<void>;
	nowMs(): number;
	advanceMs(delta: number): Promise<void>;
	loseNextMutationResponse(
		point: "before-commit" | "after-commit",
	): Promise<void>;
	/** Force a provably rolled-back DLQ write with a capacity refusal. */
	rejectNextDeadLetterWrite(): Promise<void>;
	/** Temporarily prevent resolving a prior receipt for the specified reason. */
	blockNextReceiptLookup(
		reason: "revocation" | "capacity" | "unavailable",
	): Promise<void>;
	/** Switch ownership with either unavailable proof or a fenced shared journal. */
	switchAuthority(mode: "unverified" | "verified-shared"): Promise<void>;
	/** Hold the next mutation at the indicated point until the test releases it. */
	holdNextMutation(point: "before-dispatch" | "before-commit"): Promise<{
		readonly reached: Promise<void>;
		release(): Promise<void>;
	}>;
	/** Independently hold both requests before their transactions may start. */
	holdConcurrentMutations(): Promise<{
		readonly reached: Promise<void>;
		release(): Promise<void>;
	}>;
}

export interface DurableMessagingConformanceReport {
	readonly contract: typeof DURABLE_MESSAGING_CONFORMANCE;
	/** These claims require separate evidence from an independent runner. */
	readonly executionEvidence: {
		readonly processRestart: "unverified";
		readonly persistedStoreIdentity: "unverified";
		readonly faultPlacement: "unverified";
		readonly tenantIdentity: "unverified";
		readonly clock: "unverified";
		readonly concurrencyBarrier: "unverified";
	};
	readonly cases: readonly {
		readonly name: DurableMessagingConformanceCase;
		readonly status: "pass" | "fail";
		readonly detail?: string;
	}[];
}

function sameOperation(
	left: DurableMessagingOperation,
	right: DurableMessagingOperation,
): boolean {
	return left.id === right.id && left.expiresAtMs === right.expiresAtMs;
}

class DurableMessagingConformanceFailure extends Error {}

function requireCondition(value: boolean, message: string): void {
	if (!value) throw new DurableMessagingConformanceFailure(message);
}

async function committed<T>(
	input: Promise<DurableMessagingOutcome<T>>,
): Promise<T> {
	const outcome = await input;
	if (outcome.status !== "committed")
		throw new DurableMessagingConformanceFailure(
			"operation did not return committed",
		);
	return outcome.value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function sameMessage(delivery: DurableMessagingDelivery): boolean {
	return (
		delivery.message.id === "message-1" &&
		delivery.message.subject === "orders.created" &&
		sameBytes(delivery.message.payload, new Uint8Array([0, 1, 255])) &&
		JSON.stringify(delivery.message.attributes) ===
			JSON.stringify([{ key: "content-type", value: "binary" }])
	);
}

function operations(
	harness: DurableMessagingConformanceHarness,
	windowMs: number,
) {
	let sequence = 0;
	return () =>
		durableMessagingOperation(
			harness.nowMs() + windowMs,
			String(++sequence).padStart(16, "0"),
		);
}

async function createFixture(harness: DurableMessagingConformanceHarness) {
	const client = await harness.connect("tenant-a");
	requireCondition(
		client.limits.operationWindowMs >= 1_000 &&
			client.limits.nameBytes >= 16 &&
			client.limits.reasonBytes >= 10 &&
			client.limits.payloadBytes >= 3 &&
			client.limits.attributeCount >= 1 &&
			client.limits.attributeBytes >= 18 &&
			client.limits.batchSize >= 2 &&
			client.limits.deliveryAttempts >= 3 &&
			client.limits.leaseMs >= 100 &&
			client.limits.topics >= 3 &&
			client.limits.subscriptions >= 3 &&
			client.limits.eventPageSize >= 2 &&
			client.limits.retainedEvents >= 5 &&
			client.limits.retainedMessages >= 3 &&
			client.limits.retainedReceipts >= 64,
		"provider limits are below the conformance profile",
	);
	const next = operations(
		harness,
		Math.min(client.limits.operationWindowMs, 10_000),
	);
	for (const topic of ["orders", "orders-dlq", "archive"]) {
		await committed(client.ensureTopic({ operation: next(), topic }));
	}
	const subscribe = async (
		topic: string,
		consumerGroup: string,
		deadLetterTopic: string,
		maxDeliveryAttempts = 3,
	) => {
		return committed(
			client.ensureSubscription({
				operation: next(),
				subscription: {
					topic,
					consumerGroup,
					deadLetterTopic,
					maxDeliveryAttempts,
					startAt: "earliest",
				},
			}),
		);
	};
	const publish = async () =>
		committed(
			client.publish({
				operation: next(),
				topic: "orders",
				message: {
					id: "message-1",
					subject: "orders.created",
					payload: new Uint8Array([0, 1, 255]),
					attributes: [{ key: "content-type", value: "binary" }],
				},
			}),
		);
	const consume = async (
		bus: DurableMessaging,
		topic: string,
		consumerGroup: string,
		visibilityTimeoutMs = 100,
	) =>
		committed(
			bus.consume({
				operation: next(),
				topic,
				consumerGroup,
				maxMessages: 1,
				visibilityTimeoutMs,
			}),
		);
	return { client, next, subscribe, publish, consume };
}

function firstDelivery(
	deliveries: readonly DurableMessagingDelivery[],
): DurableMessagingDelivery {
	if (deliveries.length !== 1 || deliveries[0] === undefined)
		throw new DurableMessagingConformanceFailure(
			"expected exactly one delivery",
		);
	return deliveries[0];
}

function acknowledgement(
	operation: DurableMessagingOperation,
	delivery: DurableMessagingDelivery,
) {
	return {
		operation,
		topic: delivery.topic,
		consumerGroup: delivery.consumerGroup,
		messageId: delivery.message.id,
		sequence: delivery.sequence,
		leaseId: delivery.leaseId,
	};
}

async function groupIsolation(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.subscribe("orders", "group-b", "orders-dlq");
	await f.publish();
	const second = await harness.connect("tenant-a");
	const first = firstDelivery(await f.consume(f.client, "orders", "group-a"));
	const competing = await f.consume(second, "orders", "group-a");
	const independent = firstDelivery(
		await f.consume(second, "orders", "group-b"),
	);
	requireCondition(
		sameMessage(first) &&
			sameMessage(independent) &&
			competing.length === 0 &&
			first.leaseId !== independent.leaseId,
		"groups or concurrent consumers shared a lease",
	);
	await committed(f.client.ack(acknowledgement(f.next(), first)));
	const wrongGroup = await f.client.ack({
		...acknowledgement(f.next(), independent),
		consumerGroup: "group-a",
	});
	requireCondition(
		wrongGroup.status === "rejected" && wrongGroup.code === "lease-lost",
		"a lease was accepted in another group",
	);
	await committed(second.ack(acknowledgement(f.next(), independent)));
}

async function restart(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.subscribe("orders", "group-b", "orders-dlq");
	await f.publish();
	const first = firstDelivery(await f.consume(f.client, "orders", "group-a"));
	await committed(f.client.ack(acknowledgement(f.next(), first)));
	await harness.restart();
	const nextClient = await harness.connect("tenant-a");
	requireCondition(
		(await f.consume(nextClient, "orders", "group-a")).length === 0,
		"acknowledgement was lost on restart",
	);
	requireCondition(
		sameMessage(
			firstDelivery(await f.consume(nextClient, "orders", "group-b")),
		),
		"unacknowledged message was lost on restart",
	);
	const events = await nextClient.events({ afterSequence: 0, limit: 100 });
	requireCondition(
		events.status === "ok" &&
			events.firstAvailableSequence === 1 &&
			events.events.some(
				(event) =>
					event.kind === "acknowledged" && event.messageId === "message-1",
			),
		"durable acknowledgement event was lost on restart",
	);
}

async function uncertainAck(
	harness: DurableMessagingConformanceHarness,
	point: "before-commit" | "after-commit",
) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.publish();
	const delivery = firstDelivery(
		await f.consume(f.client, "orders", "group-a"),
	);
	const request = acknowledgement(f.next(), delivery);
	await harness.loseNextMutationResponse(point);
	const lost = await f.client.ack(request);
	requireCondition(
		lost.status === "unknown" &&
			sameOperation(lost.operation, request.operation),
		"lost acknowledgement was not reported as unknown",
	);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	const receipt = await committed(reopened.ack(request));
	requireCondition(
		receipt.messageId === delivery.message.id &&
			receipt.sequence === delivery.sequence,
		"retry did not resolve the original acknowledgement",
	);
	await harness.advanceMs(101);
	requireCondition(
		(await f.consume(reopened, "orders", "group-a")).length === 0,
		"acknowledged message was redelivered",
	);
}

async function leaseExpiry(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.publish();
	const first = firstDelivery(await f.consume(f.client, "orders", "group-a"));
	await harness.advanceMs(101);
	await harness.restart();
	const secondClient = await harness.connect("tenant-a");
	const staleClient = await harness.connect("tenant-a");
	const second = firstDelivery(
		await f.consume(secondClient, "orders", "group-a"),
	);
	requireCondition(
		first.message.id === second.message.id &&
			first.sequence === second.sequence &&
			first.leaseId !== second.leaseId &&
			second.deliveryAttempt === first.deliveryAttempt + 1,
		"expired lease was not fenced",
	);
	const staleAck = await staleClient.ack(acknowledgement(f.next(), first));
	const staleNack = await staleClient.nack({
		...acknowledgement(f.next(), first),
		reason: "stale",
	});
	requireCondition(
		staleAck.status === "rejected" &&
			staleAck.code === "lease-lost" &&
			staleNack.status === "rejected" &&
			staleNack.code === "lease-lost",
		"expired lease changed the current delivery",
	);
	await committed(secondClient.ack(acknowledgement(f.next(), second)));
}

async function leaseReceiptReplay(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.subscribe("orders", "group-b", "orders-dlq");
	await f.publish();
	const consumeRequest = {
		operation: f.next(),
		topic: "orders",
		consumerGroup: "group-a",
		maxMessages: 1,
		visibilityTimeoutMs: 100,
	};
	const first = firstDelivery(
		await committed(f.client.consume(consumeRequest)),
	);
	await harness.advanceMs(101);
	const replay = firstDelivery(
		await committed(f.client.consume(consumeRequest)),
	);
	requireCondition(
		replay.sequence === first.sequence &&
			replay.leaseId === first.leaseId &&
			replay.leaseExpiresAtMs === first.leaseExpiresAtMs &&
			replay.deliveryAttempt === first.deliveryAttempt &&
			sameMessage(replay),
		"consume retry did not replay the exact expired lease receipt",
	);
	const second = firstDelivery(await f.consume(f.client, "orders", "group-a"));
	const ackRequest = acknowledgement(f.next(), second);
	const acked = await committed(f.client.ack(ackRequest));
	const groupB = firstDelivery(await f.consume(f.client, "orders", "group-b"));
	const nackRequest = { ...acknowledgement(f.next(), groupB), reason: "retry" };
	const nacked = await committed(f.client.nack(nackRequest));
	await harness.advanceMs(101);
	const ackReplay = await committed(f.client.ack(ackRequest));
	const nackReplay = await committed(f.client.nack(nackRequest));
	requireCondition(
		acked.messageId === ackReplay.messageId &&
			acked.sequence === ackReplay.sequence &&
			nacked.messageId === nackReplay.messageId &&
			nacked.sequence === nackReplay.sequence &&
			nacked.disposition === nackReplay.disposition,
		"settlement receipt changed after lease expiry",
	);
}

async function deadLetter(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq", 2);
	await f.subscribe("orders-dlq", "dlq-reader", "archive");
	await f.publish();
	const first = firstDelivery(await f.consume(f.client, "orders", "group-a"));
	const released = await committed(
		f.client.nack({ ...acknowledgement(f.next(), first), reason: "try-again" }),
	);
	requireCondition(
		released.disposition === "released",
		"first failure was not released",
	);
	const second = firstDelivery(await f.consume(f.client, "orders", "group-a"));
	const request = { ...acknowledgement(f.next(), second), reason: "permanent" };
	await harness.loseNextMutationResponse("after-commit");
	const lost = await f.client.nack(request);
	requireCondition(
		lost.status === "unknown" &&
			sameOperation(lost.operation, request.operation),
		"lost dead-letter response was not unknown",
	);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	const receipt = await committed(reopened.nack(request));
	requireCondition(
		receipt.disposition === "dead-lettered",
		"dead-letter receipt was not durable",
	);
	const dead = firstDelivery(
		await f.consume(reopened, "orders-dlq", "dlq-reader"),
	);
	requireCondition(
		receipt.disposition === "dead-lettered" &&
			dead.message.id === receipt.deadLetterMessageId &&
			dead.sequence === receipt.deadLetterSequence &&
			sameBytes(dead.message.payload, new Uint8Array([0, 1, 255])) &&
			dead.message.subject === "orders.created" &&
			JSON.stringify(dead.message.attributes) ===
				JSON.stringify([{ key: "content-type", value: "binary" }]) &&
			dead.deadLetter?.sourceTopic === "orders" &&
			dead.deadLetter.consumerGroup === "group-a" &&
			dead.deadLetter.originalMessageId === "message-1" &&
			dead.deadLetter.originalSequence === second.sequence &&
			dead.deadLetter.deliveryAttempt === 2 &&
			dead.deadLetter.cause.kind === "nack" &&
			dead.deadLetter.cause.reason === "permanent",
		"dead-letter bytes, attributes or provenance were lost",
	);
	await committed(reopened.ack(acknowledgement(f.next(), dead)));
	requireCondition(
		(await f.consume(reopened, "orders-dlq", "dlq-reader")).length === 0 &&
			(await f.consume(reopened, "orders", "group-a")).length === 0,
		"retry duplicated the dead letter or retained source delivery",
	);
}

async function compaction(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.subscribe("orders", "group-b", "orders-dlq");
	const operation = f.next();
	const request = {
		operation,
		topic: "orders",
		message: {
			id: "message-1",
			subject: "orders.created",
			payload: new Uint8Array([0, 1, 255]),
			attributes: [{ key: "content-type", value: "binary" }],
		},
	};
	const published = await committed(f.client.publish(request));
	const first = firstDelivery(await f.consume(f.client, "orders", "group-a"));
	const second = firstDelivery(await f.consume(f.client, "orders", "group-b"));
	await committed(f.client.ack(acknowledgement(f.next(), first)));
	const blocked = await f.client.compact({
		operation: f.next(),
		topic: "orders",
		throughSequence: published.sequence,
	});
	requireCondition(
		blocked.status === "rejected" && blocked.code === "retention-blocked",
		"compaction discarded a leased or unsettled group delivery",
	);
	await committed(f.client.ack(acknowledgement(f.next(), second)));
	const compacted = await committed(
		f.client.compact({
			operation: f.next(),
			topic: "orders",
			throughSequence: published.sequence,
		}),
	);
	requireCondition(
		compacted.removedMessages === 1 &&
			compacted.firstAvailableSequence === published.sequence + 1,
		"compaction did not advance the retained floor",
	);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	const originalReceipt = await committed(reopened.publish(request));
	requireCondition(
		originalReceipt.messageId === published.messageId &&
			originalReceipt.sequence === published.sequence,
		"compaction lost the live operation receipt",
	);
	const nextMessage = await committed(
		reopened.publish({ ...request, operation: f.next() }),
	);
	requireCondition(
		nextMessage.sequence === published.sequence + 1,
		"reclaimed message ID did not receive a new sequence",
	);
	const subscription = await committed(
		reopened.ensureSubscription({
			operation: f.next(),
			subscription: {
				topic: "orders",
				consumerGroup: "late",
				deadLetterTopic: "orders-dlq",
				maxDeliveryAttempts: 3,
				startAt: "earliest",
			},
		}),
	);
	requireCondition(
		subscription.historyTruncated &&
			subscription.firstAvailableSequence === nextMessage.sequence,
		"late earliest subscriber was not told about truncated history",
	);
	const delivery = firstDelivery(await f.consume(reopened, "orders", "late"));
	requireCondition(
		delivery.sequence === nextMessage.sequence && sameMessage(delivery),
		"late subscriber did not start at the retained floor",
	);
	const renewed = firstDelivery(await f.consume(reopened, "orders", "group-a"));
	const stale = await reopened.ack(acknowledgement(f.next(), first));
	const forged = await reopened.ack({
		...acknowledgement(f.next(), first),
		sequence: renewed.sequence,
	});
	requireCondition(
		stale.status === "rejected" &&
			stale.code === "lease-lost" &&
			forged.status === "rejected" &&
			forged.code === "lease-lost",
		"an old lease affected a new message incarnation",
	);
	await committed(reopened.ack(acknowledgement(f.next(), renewed)));
	await committed(reopened.ack(acknowledgement(f.next(), delivery)));
}

async function unavailableReceipt(
	harness: DurableMessagingConformanceHarness,
	reason: "revocation" | "capacity" | "unavailable",
) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	const request = {
		operation: f.next(),
		topic: "orders",
		message: {
			id: "message-1",
			subject: "orders.created",
			payload: new Uint8Array([0, 1, 255]),
			attributes: [{ key: "content-type", value: "binary" }],
		},
	};
	await harness.loseNextMutationResponse("after-commit");
	const lost = await f.client.publish(request);
	requireCondition(
		lost.status === "unknown" &&
			sameOperation(lost.operation, request.operation),
		"lost publish response was not unknown",
	);
	await harness.blockNextReceiptLookup(reason);
	const blocked = await f.client.publish(request);
	requireCondition(
		blocked.status === "unknown" &&
			sameOperation(blocked.operation, request.operation),
		"unresolved prior commit was turned into a rejection",
	);
	const receipt = await committed(f.client.publish(request));
	const delivery = firstDelivery(
		await f.consume(f.client, "orders", "group-a"),
	);
	requireCondition(
		receipt.sequence === delivery.sequence && sameMessage(delivery),
		"receipt recovery lost or duplicated the message",
	);
}

async function failover(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	const request = {
		operation: f.next(),
		topic: "orders",
		message: {
			id: "message-1",
			subject: "orders.created",
			payload: new Uint8Array([0, 1, 255]),
			attributes: [{ key: "content-type", value: "binary" }],
		},
	};
	await harness.loseNextMutationResponse("after-commit");
	const lost = await f.client.publish(request);
	requireCondition(
		lost.status === "unknown" &&
			sameOperation(lost.operation, request.operation),
		"lost publish did not preserve its operation identity",
	);
	await harness.switchAuthority("unverified");
	const unverified = await harness.connect("tenant-a");
	const uncertain = await unverified.publish(request);
	requireCondition(
		uncertain.status === "unknown" &&
			sameOperation(uncertain.operation, request.operation),
		"unverified failover gave a definite answer",
	);
	await harness.switchAuthority("verified-shared");
	const verified = await harness.connect("tenant-a");
	const receipt = await committed(verified.publish(request));
	const delivered = firstDelivery(
		await f.consume(verified, "orders", "group-a"),
	);
	requireCondition(
		receipt.sequence === delivered.sequence && sameMessage(delivered),
		"fenced shared journal did not recover the original receipt",
	);
}

async function expiredLeaseDeadLetter(
	harness: DurableMessagingConformanceHarness,
) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq", 1);
	await f.subscribe("orders-dlq", "dlq-reader", "archive");
	await f.publish();
	await committed(
		f.client.publish({
			operation: f.next(),
			topic: "orders",
			message: {
				id: "message-2",
				subject: "next",
				payload: new Uint8Array([2]),
				attributes: [],
			},
		}),
	);
	const delivery = firstDelivery(
		await f.consume(f.client, "orders", "group-a"),
	);
	await harness.advanceMs(101);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	const request = {
		operation: f.next(),
		topic: "orders",
		consumerGroup: "group-a",
		maxMessages: 2,
		visibilityTimeoutMs: 100,
	};
	await harness.rejectNextDeadLetterWrite();
	const refused = await reopened.consume(request);
	requireCondition(
		refused.status === "rejected" && refused.code === "capacity-exceeded",
		"expired lease transfer failure did not reject atomically",
	);
	const replay = await reopened.consume(request);
	requireCondition(
		replay.status === "rejected" && replay.code === "capacity-exceeded",
		"expired lease refusal was not fenced",
	);
	requireCondition(
		(await f.consume(reopened, "orders-dlq", "dlq-reader")).length === 0,
		"failed expired transfer left a DLQ message",
	);
	const blocked = await reopened.compact({
		operation: f.next(),
		topic: "orders",
		throughSequence: delivery.sequence,
	});
	requireCondition(
		blocked.status === "rejected" && blocked.code === "retention-blocked",
		"pending expired delivery was compacted before DLQ transfer",
	);
	const next = firstDelivery(
		await committed(reopened.consume({ ...request, operation: f.next() })),
	);
	requireCondition(
		next.message.id === "message-2" && next.deliveryAttempt === 1,
		"failed transfer left a partial lease",
	);
	const dead = firstDelivery(
		await f.consume(reopened, "orders-dlq", "dlq-reader"),
	);
	requireCondition(
		sameBytes(dead.message.payload, new Uint8Array([0, 1, 255])) &&
			dead.deadLetter?.originalSequence === delivery.sequence &&
			dead.deadLetter.deliveryAttempt === 1 &&
			dead.deadLetter.cause.kind === "lease-expired",
		"expired lease did not preserve the original message and cause in the DLQ",
	);
	await committed(reopened.ack(acknowledgement(f.next(), dead)));
	requireCondition(
		(await f.consume(reopened, "orders-dlq", "dlq-reader")).length === 0,
		"expired transfer duplicated the DLQ message",
	);
}

async function deadLetterRollback(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq", 1);
	await f.subscribe("orders-dlq", "dlq-reader", "archive");
	await f.publish();
	const delivery = firstDelivery(
		await f.consume(f.client, "orders", "group-a"),
	);
	const request = {
		...acknowledgement(f.next(), delivery),
		reason: "permanent",
	};
	await harness.rejectNextDeadLetterWrite();
	const rejected = await f.client.nack(request);
	requireCondition(
		rejected.status === "rejected" && rejected.code === "capacity-exceeded",
		"DLQ write failure was not rejected",
	);
	requireCondition(
		(await f.consume(f.client, "orders-dlq", "dlq-reader")).length === 0,
		"rolled-back DLQ write left a message",
	);
	const replay = await f.client.nack(request);
	requireCondition(
		replay.status === "rejected" && replay.code === "capacity-exceeded",
		"terminal rejection was not replayed",
	);
	const receipt = await committed(
		f.client.nack({ ...request, operation: f.next() }),
	);
	requireCondition(
		receipt.disposition === "dead-lettered",
		"failed DLQ write lost the source lease",
	);
	const dead = firstDelivery(
		await f.consume(f.client, "orders-dlq", "dlq-reader"),
	);
	requireCondition(
		sameBytes(dead.message.payload, new Uint8Array([0, 1, 255])) &&
			dead.deadLetter?.originalMessageId === "message-1",
		"DLQ retry lost the original payload",
	);
}

async function delayedRejection(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq", 1);
	await f.subscribe("orders-dlq", "dlq-reader", "archive");
	await f.publish();
	const delivery = firstDelivery(
		await f.consume(f.client, "orders", "group-a"),
	);
	const request = {
		...acknowledgement(f.next(), delivery),
		reason: "permanent",
	};
	const barrier = await harness.holdNextMutation("before-dispatch");
	const delayed = f.client.nack(request);
	await barrier.reached;
	await harness.rejectNextDeadLetterWrite();
	const first = await f.client.nack(request);
	requireCondition(
		first.status === "rejected" && first.code === "capacity-exceeded",
		"initial refusal was not definite",
	);
	await barrier.release();
	const later = await delayed;
	requireCondition(
		later.status === "rejected" && later.code === "capacity-exceeded",
		"delayed duplicate escaped the terminal rejection",
	);
	await committed(f.client.nack({ ...request, operation: f.next() }));
	requireCondition(
		(await f.consume(f.client, "orders-dlq", "dlq-reader")).length === 1,
		"new operation did not preserve exactly one dead letter",
	);
}

async function expiryBoundary(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.publish();
	const delivery = firstDelivery(
		await f.consume(f.client, "orders", "group-a"),
	);
	const request = acknowledgement(f.next(), delivery);
	const barrier = await harness.holdNextMutation("before-commit");
	const pending = f.client.ack(request);
	await barrier.reached;
	await harness.advanceMs(request.operation.expiresAtMs - harness.nowMs());
	await barrier.release();
	const first = await committed(pending);
	requireCondition(
		first.messageId === delivery.message.id &&
			first.sequence === delivery.sequence,
		"pre-expiry transaction returned the wrong receipt",
	);
	const retry = await f.client.ack(request);
	requireCondition(
		retry.status === "expired" &&
			sameOperation(retry.operation, request.operation),
		"post-expiry retry was not explicitly uncertain",
	);
}

async function operationReplay(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	const operation = f.next();
	const message = {
		id: "message-1",
		subject: "orders.created",
		payload: new Uint8Array([0, 1, 255]),
		attributes: [{ key: "content-type", value: "binary" }],
	};
	const request = { operation, topic: "orders", message };
	const first = await committed(f.client.publish(request));
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	const again = await committed(reopened.publish(request));
	requireCondition(
		first.messageId === again.messageId && first.sequence === again.sequence,
		"receipt changed across restart",
	);
	const conflict = await reopened.publish({
		...request,
		message: { ...message, payload: new Uint8Array([9]) },
	});
	requireCondition(
		conflict.status === "rejected" && conflict.code === "operation-conflict",
		"operation ID accepted a different request",
	);
	await harness.advanceMs(operation.expiresAtMs - harness.nowMs());
	const expired = await reopened.publish(request);
	requireCondition(
		expired.status === "expired" && sameOperation(expired.operation, operation),
		"expired retry did not remain explicitly uncertain",
	);
	const deliveries = await f.consume(reopened, "orders", "group-a");
	requireCondition(
		deliveries.length === 1 && sameMessage(firstDelivery(deliveries)),
		"retry created a duplicate or lost the original",
	);
}

async function concurrentOperations(
	harness: DurableMessagingConformanceHarness,
) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	const other = await harness.connect("tenant-a");
	const request = {
		operation: f.next(),
		topic: "orders",
		message: {
			id: "message-1",
			subject: "orders.created",
			payload: new Uint8Array([0, 1, 255]),
			attributes: [{ key: "content-type", value: "binary" }],
		},
	};
	const barrier = await harness.holdConcurrentMutations();
	const one = f.client.publish(request);
	const two = other.publish(request);
	await barrier.reached;
	await barrier.release();
	const [first, second] = await Promise.all([one, two]);
	requireCondition(
		first.status === "committed" &&
			second.status === "committed" &&
			JSON.stringify(first.value) === JSON.stringify(second.value),
		"concurrent identical requests did not replay the same receipt",
	);
	const conflictOperation = f.next();
	const conflictBarrier = await harness.holdConcurrentMutations();
	const a = f.client.publish({
		...request,
		operation: conflictOperation,
		message: { ...request.message, id: "other-a" },
	});
	const b = other.publish({
		...request,
		operation: conflictOperation,
		message: { ...request.message, id: "other-b" },
	});
	await conflictBarrier.reached;
	await conflictBarrier.release();
	const pair = await Promise.all([a, b]);
	requireCondition(
		pair.filter((result) => result.status === "committed").length === 1 &&
			pair.filter(
				(result) =>
					result.status === "rejected" && result.code === "operation-conflict",
			).length === 1,
		"conflicting concurrent requests both took effect or neither was fenced",
	);
	const firstDeliveryValue = firstDelivery(
		await f.consume(f.client, "orders", "group-a"),
	);
	requireCondition(
		sameMessage(firstDeliveryValue),
		"concurrent retry lost the original message",
	);
}

async function concurrentClaims(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.publish();
	const other = await harness.connect("tenant-a");
	const barrier = await harness.holdConcurrentMutations();
	const first = f.client.consume({
		operation: f.next(),
		topic: "orders",
		consumerGroup: "group-a",
		maxMessages: 1,
		visibilityTimeoutMs: 100,
	});
	const second = other.consume({
		operation: f.next(),
		topic: "orders",
		consumerGroup: "group-a",
		maxMessages: 1,
		visibilityTimeoutMs: 100,
	});
	await barrier.reached;
	await barrier.release();
	const [one, two] = await Promise.all([committed(first), committed(second)]);
	requireCondition(
		one.length + two.length === 1 &&
			sameMessage(firstDelivery([...one, ...two])),
		"competing consumers received duplicate or missing leases",
	);
}

async function ackExpiryRace(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.publish();
	const old = firstDelivery(await f.consume(f.client, "orders", "group-a"));
	const other = await harness.connect("tenant-a");
	const barrier = await harness.holdConcurrentMutations();
	const ack = f.client.ack(acknowledgement(f.next(), old));
	const consume = other.consume({
		operation: f.next(),
		topic: "orders",
		consumerGroup: "group-a",
		maxMessages: 1,
		visibilityTimeoutMs: 100,
	});
	await barrier.reached;
	await harness.advanceMs(101);
	await barrier.release();
	const [oldAck, next] = await Promise.all([ack, committed(consume)]);
	const renewed = firstDelivery(next);
	requireCondition(
		oldAck.status === "rejected" &&
			oldAck.code === "lease-lost" &&
			renewed.sequence === old.sequence &&
			renewed.leaseId !== old.leaseId &&
			renewed.deliveryAttempt === old.deliveryAttempt + 1,
		"an expired competing acknowledgement settled a renewed lease",
	);
}

async function publishCompactionRace(
	harness: DurableMessagingConformanceHarness,
) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	const published = await f.publish();
	const first = firstDelivery(await f.consume(f.client, "orders", "group-a"));
	await committed(f.client.ack(acknowledgement(f.next(), first)));
	const other = await harness.connect("tenant-a");
	const barrier = await harness.holdConcurrentMutations();
	const compact = f.client.compact({
		operation: f.next(),
		topic: "orders",
		throughSequence: published.sequence,
	});
	const publish = other.publish({
		operation: f.next(),
		topic: "orders",
		message: {
			id: "message-2",
			subject: "next",
			payload: new Uint8Array([2]),
			attributes: [],
		},
	});
	await barrier.reached;
	await barrier.release();
	const [compacted, added] = await Promise.all([
		committed(compact),
		committed(publish),
	]);
	const delivery = firstDelivery(await f.consume(other, "orders", "group-a"));
	requireCondition(
		compacted.firstAvailableSequence === published.sequence + 1 &&
			added.sequence === published.sequence + 1 &&
			delivery.sequence === added.sequence &&
			delivery.message.id === "message-2",
		"concurrent publish was compacted or lost",
	);
}

async function detachedRequests(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	const attribute = { key: "content-type", value: "binary" };
	const message = {
		id: "message-1",
		subject: "orders.created",
		payload: new Uint8Array([0, 1, 255]),
		attributes: [attribute],
	};
	const request = { operation: f.next(), topic: "orders", message };
	const barrier = await harness.holdNextMutation("before-dispatch");
	const pending = f.client.publish(request);
	await barrier.reached;
	message.payload[0] = 9;
	attribute.value = "changed";
	await barrier.release();
	const receipt = await committed(pending);
	const delivery = firstDelivery(
		await f.consume(f.client, "orders", "group-a"),
	);
	requireCondition(
		receipt.messageId === delivery.message.id &&
			receipt.sequence === delivery.sequence &&
			sameMessage(delivery),
		"caller mutation changed an already submitted request",
	);
	const conflict = await f.client.ensureTopic({
		operation: request.operation,
		topic: "another",
	});
	requireCondition(
		conflict.status === "rejected" && conflict.code === "operation-conflict",
		"the operation fingerprint omitted the method or scope",
	);
}

async function subscriptionCompactionRace(
	harness: DurableMessagingConformanceHarness,
	startAt: "earliest" | "latest",
) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	const published = await f.publish();
	const delivery = firstDelivery(
		await f.consume(f.client, "orders", "group-a"),
	);
	await committed(f.client.ack(acknowledgement(f.next(), delivery)));
	const other = await harness.connect("tenant-a");
	const barrier = await harness.holdConcurrentMutations();
	const compact = f.client.compact({
		operation: f.next(),
		topic: "orders",
		throughSequence: published.sequence,
	});
	const subscribe = other.ensureSubscription({
		operation: f.next(),
		subscription: {
			topic: "orders",
			consumerGroup: "racer",
			deadLetterTopic: "orders-dlq",
			maxDeliveryAttempts: 3,
			startAt,
		},
	});
	await barrier.reached;
	await barrier.release();
	const [compacted, subscribed] = await Promise.all([compact, subscribe]);
	if (subscribed.status !== "committed")
		throw new DurableMessagingConformanceFailure(
			"racing subscription was not created",
		);
	const receipt = subscribed.value;
	if (startAt === "earliest" && compacted.status === "rejected") {
		requireCondition(
			compacted.code === "retention-blocked" &&
				receipt.firstAvailableSequence === published.sequence &&
				!receipt.historyTruncated,
			"earliest subscription did not block compaction",
		);
		requireCondition(
			sameMessage(firstDelivery(await f.consume(other, "orders", "racer"))),
			"earliest race lost its retained message",
		);
	} else {
		requireCondition(
			compacted.status === "committed",
			"compaction race did not linearize",
		);
		if (startAt === "earliest")
			requireCondition(
				receipt.firstAvailableSequence === published.sequence + 1 &&
					receipt.historyTruncated,
				"earliest subscription did not report the winning compaction",
			);
		requireCondition(
			(await f.consume(other, "orders", "racer")).length === 0,
			"subscription consumed history outside its linearized start",
		);
	}
}

async function tenantIsolation(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	const other = await harness.connect("tenant-b");
	for (const topic of ["orders", "orders-dlq"])
		await committed(other.ensureTopic({ operation: f.next(), topic }));
	await committed(
		other.ensureSubscription({
			operation: f.next(),
			subscription: {
				topic: "orders",
				consumerGroup: "group-a",
				deadLetterTopic: "orders-dlq",
				maxDeliveryAttempts: 2,
				startAt: "earliest",
			},
		}),
	);
	await f.publish();
	requireCondition(
		(await f.consume(other, "orders", "group-a")).length === 0,
		"a different tenant observed the message",
	);
	requireCondition(
		sameMessage(firstDelivery(await f.consume(f.client, "orders", "group-a"))),
		"original tenant lost its message",
	);
}

async function auditPagination(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.publish();
	const first = await f.client.events({ afterSequence: 0, limit: 2 });
	if (first.status !== "ok")
		throw new DurableMessagingConformanceFailure(
			"first audit page unavailable",
		);
	requireCondition(
		first.firstAvailableSequence === 1 &&
			first.events.length === 2 &&
			first.events[0]?.sequence === 1 &&
			first.events[1]?.sequence === 2 &&
			first.nextAfterSequence === 2 &&
			first.hasMore,
		"first audit page was not ordered or complete",
	);
	const repeated = await f.client.events({ afterSequence: 0, limit: 2 });
	requireCondition(
		repeated.status === "ok" &&
			JSON.stringify(repeated) === JSON.stringify(first),
		"reused audit cursor changed without writes",
	);
	const second = await f.client.events({
		afterSequence: first.nextAfterSequence,
		limit: 2,
	});
	requireCondition(
		second.status === "ok" &&
			second.events[0]?.sequence === 3 &&
			second.events[1]?.sequence === 4 &&
			second.nextAfterSequence === 4,
		"next audit page skipped or reordered events",
	);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	const afterRestart = await reopened.events({ afterSequence: 0, limit: 2 });
	requireCondition(
		afterRestart.status === "ok" &&
			JSON.stringify(afterRestart) === JSON.stringify(first),
		"audit cursor or page changed on restart",
	);
}

async function auditRetention(harness: DurableMessagingConformanceHarness) {
	const client = await harness.connect("tenant-a");
	requireCondition(
		client.limits.retainedEvents >= 2 &&
			client.limits.retainedEvents <= 32 &&
			client.limits.topics >= client.limits.retainedEvents + 2 &&
			client.limits.retainedReceipts >= 64 &&
			client.limits.operationWindowMs >= 1_000,
		"audit retention harness limits are not configured for this case",
	);
	const next = operations(
		harness,
		Math.min(client.limits.operationWindowMs, 10_000),
	);
	const total = client.limits.retainedEvents + 2;
	for (let index = 0; index < total; index++)
		await committed(
			client.ensureTopic({ operation: next(), topic: `audit-${index}` }),
		);
	const gap = await client.events({ afterSequence: 0, limit: 2 });
	requireCondition(
		gap.status === "gap" &&
			gap.firstAvailableSequence === 3 &&
			gap.latestSequence === total,
		"old audit cursor did not report the retention gap",
	);
	const page = await client.events({ afterSequence: 2, limit: 2 });
	requireCondition(
		page.status === "ok" &&
			page.events[0]?.sequence === 3 &&
			page.events[1]?.sequence === 4 &&
			page.nextAfterSequence === 4,
		"audit did not resume at the retained floor",
	);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	await committed(
		reopened.ensureTopic({ operation: next(), topic: "audit-next" }),
	);
	const nextPage = await reopened.events({ afterSequence: total, limit: 2 });
	requireCondition(
		nextPage.status === "ok" &&
			nextPage.events.length === 1 &&
			nextPage.events[0]?.sequence === total + 1 &&
			nextPage.nextAfterSequence === total + 1 &&
			!nextPage.hasMore,
		"audit sequence was reused or reset after retention and restart",
	);
	const future = await reopened.events({ afterSequence: total + 2, limit: 1 });
	requireCondition(
		future.status === "rejected" && future.code === "invalid-argument",
		"future audit cursor was accepted",
	);
}

async function topicCapacity(harness: DurableMessagingConformanceHarness) {
	const client = await harness.connect("tenant-a");
	requireCondition(
		client.limits.topics >= 2 &&
			client.limits.topics <= 32 &&
			client.limits.retainedReceipts >= client.limits.topics + 4 &&
			client.limits.operationWindowMs >= 1_000,
		"topic-capacity harness limits are not configured for this case",
	);
	const next = operations(
		harness,
		Math.min(client.limits.operationWindowMs, 10_000),
	);
	const first = { operation: next(), topic: "topic-0" };
	await committed(client.ensureTopic(first));
	for (let index = 1; index < client.limits.topics; index++)
		await committed(
			client.ensureTopic({ operation: next(), topic: `topic-${index}` }),
		);
	const excess = { operation: next(), topic: "excess" };
	const denied = await client.ensureTopic(excess);
	requireCondition(
		denied.status === "rejected" && denied.code === "capacity-exceeded",
		"topic capacity was not enforced",
	);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	const replay = await reopened.ensureTopic(excess);
	requireCondition(
		replay.status === "rejected" && replay.code === "capacity-exceeded",
		"topic capacity rejection was not durable",
	);
	const original = await committed(reopened.ensureTopic(first));
	requireCondition(
		original.topic === first.topic,
		"topic capacity evicted a live receipt",
	);
	await committed(
		reopened.ensureTopic({ operation: next(), topic: first.topic }),
	);
}

async function bounds(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	// SAFETY: these keys come from the exact frozen limits record.
	const keys = Object.keys(
		DURABLE_MESSAGING_LIMITS,
	) as (keyof DurableMessagingLimits)[];
	for (const key of keys) {
		const declared = f.client.limits[key];
		requireCondition(
			Number.isSafeInteger(declared) &&
				declared > 0 &&
				declared <= DURABLE_MESSAGING_LIMITS[key],
			`invalid provider limit ${key}`,
		);
	}
	await f.subscribe("orders", "group-a", "orders-dlq");
	const invalid: Array<
		readonly [string, () => Promise<DurableMessagingOutcome<unknown>>]
	> = [];
	for (const topic of [
		"",
		"bad\u0000name",
		"bad\ud800",
		"x".repeat(f.client.limits.nameBytes + 1),
		"é".repeat(Math.floor(f.client.limits.nameBytes / 2) + 1),
	]) {
		const input = { operation: f.next(), topic };
		invalid.push(["invalid name", () => f.client.ensureTopic(input)]);
	}
	for (const message of [
		{
			id: "large",
			subject: "orders",
			payload: new Uint8Array(f.client.limits.payloadBytes + 1),
			attributes: [],
		},
		{
			id: "duplicate-attributes",
			subject: "orders",
			payload: new Uint8Array(),
			attributes: [
				{ key: "same", value: "1" },
				{ key: "same", value: "2" },
			],
		},
		{
			id: "large-attributes",
			subject: "orders",
			payload: new Uint8Array(),
			attributes: [
				{ key: "k", value: "x".repeat(f.client.limits.attributeBytes) },
			],
		},
		{
			id: "invalid-attribute",
			subject: "orders",
			payload: new Uint8Array(),
			attributes: [{ key: "k", value: "\ud800" }],
		},
	]) {
		const input = { operation: f.next(), topic: "orders", message };
		invalid.push(["invalid message", () => f.client.publish(input)]);
	}
	for (const maxDeliveryAttempts of [
		0,
		f.client.limits.deliveryAttempts + 1,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		const input = {
			operation: f.next(),
			subscription: {
				topic: "orders",
				consumerGroup: "invalid-attempts",
				deadLetterTopic: "orders-dlq",
				maxDeliveryAttempts,
				startAt: "earliest" as const,
			},
		};
		invalid.push([
			"invalid delivery attempt limit",
			() => f.client.ensureSubscription(input),
		]);
	}
	for (const [maxMessages, visibilityTimeoutMs] of [
		[0, 100],
		[f.client.limits.batchSize + 1, 100],
		[1, 0],
		[1, f.client.limits.leaseMs + 1],
		[1, Number.MAX_SAFE_INTEGER + 1],
	] as const) {
		const input = {
			operation: f.next(),
			topic: "orders",
			consumerGroup: "group-a",
			maxMessages,
			visibilityTimeoutMs,
		};
		invalid.push(["invalid consume limit", () => f.client.consume(input)]);
	}
	for (const [label, run] of invalid) {
		const first = await run();
		const retry = await run();
		requireCondition(
			first.status === "rejected" &&
				first.code === "invalid-argument" &&
				retry.status === "rejected" &&
				retry.code === first.code,
			`${label} was not durably rejected`,
		);
	}
	for (const operation of [
		{ id: "v1.1.too-short", expiresAtMs: 1 },
		{
			id: "v1.9007199254740992.abcdefghijklmnop",
			expiresAtMs: Number.MAX_SAFE_INTEGER + 1,
		},
		{ id: "v1.01.abcdefghijklmnop", expiresAtMs: 1 },
	]) {
		const result = await f.client.ensureTopic({
			operation,
			topic: "invalid-envelope",
		});
		requireCondition(
			result.status === "rejected" && result.code === "invalid-argument",
			"permanently malformed operation envelope was accepted",
		);
	}
	requireCondition(
		(await f.consume(f.client, "orders", "group-a")).length === 0,
		"invalid operations changed durable state",
	);
	await f.publish();
	const delivery = firstDelivery(
		await f.consume(f.client, "orders", "group-a"),
	);
	const nack = {
		...acknowledgement(f.next(), delivery),
		reason: "x".repeat(f.client.limits.reasonBytes + 1),
	};
	const rejected = await f.client.nack(nack);
	const replay = await f.client.nack(nack);
	requireCondition(
		rejected.status === "rejected" &&
			rejected.code === "invalid-argument" &&
			replay.status === "rejected" &&
			replay.code === rejected.code,
		"oversized nack reason was not durably rejected",
	);
	await committed(f.client.ack(acknowledgement(f.next(), delivery)));
}

// The union, execution order and published case names all derive from this
// single registry. Reject accidental duplicates before executing any case.
const DURABLE_CASES = [
	["group-isolation", groupIsolation],
	["restart", restart],
	[
		"ack-before-commit-uncertainty",
		(harness: DurableMessagingConformanceHarness) =>
			uncertainAck(harness, "before-commit"),
	],
	[
		"ack-after-commit-uncertainty",
		(harness: DurableMessagingConformanceHarness) =>
			uncertainAck(harness, "after-commit"),
	],
	["lease-expiry", leaseExpiry],
	["lease-receipt-replay", leaseReceiptReplay],
	["dead-letter", deadLetter],
	["expired-lease-dead-letter", expiredLeaseDeadLetter],
	["dead-letter-rollback", deadLetterRollback],
	["delayed-rejection", delayedRejection],
	["expiry-boundary", expiryBoundary],
	["compaction", compaction],
	[
		"receipt-revocation",
		(harness: DurableMessagingConformanceHarness) =>
			unavailableReceipt(harness, "revocation"),
	],
	[
		"receipt-capacity",
		(harness: DurableMessagingConformanceHarness) =>
			unavailableReceipt(harness, "capacity"),
	],
	[
		"receipt-unavailable",
		(harness: DurableMessagingConformanceHarness) =>
			unavailableReceipt(harness, "unavailable"),
	],
	["failover", failover],
	["operation-replay", operationReplay],
	["concurrent-operations", concurrentOperations],
	["concurrent-claims", concurrentClaims],
	["ack-expiry-race", ackExpiryRace],
	["compact-publish-race", publishCompactionRace],
	["detached-requests", detachedRequests],
	[
		"compact-earliest-race",
		(harness: DurableMessagingConformanceHarness) =>
			subscriptionCompactionRace(harness, "earliest"),
	],
	[
		"compact-latest-race",
		(harness: DurableMessagingConformanceHarness) =>
			subscriptionCompactionRace(harness, "latest"),
	],
	["tenant-isolation", tenantIsolation],
	["audit-pagination", auditPagination],
	["audit-retention", auditRetention],
	["topic-capacity", topicCapacity],
	["bounds", bounds],
] as const satisfies readonly (readonly [
	string,
	(harness: DurableMessagingConformanceHarness) => Promise<void>,
])[];

// public-contract: exact names and execution order of the durable messaging cases.
export const DURABLE_MESSAGING_CONFORMANCE_CASES = Object.freeze(
	DURABLE_CASES.map(([name]) => name),
);
if (new Set(DURABLE_MESSAGING_CONFORMANCE_CASES).size !== DURABLE_CASES.length)
	throw new Error("duplicate durable messaging conformance case");

/** Bounded executable cases; a pass is not proof that the harness uses a live provider. */
export async function runDurableMessagingConformance(
	create: (
		name: DurableMessagingConformanceCase,
	) => Promise<DurableMessagingConformanceHarness>,
): Promise<DurableMessagingConformanceReport> {
	const results: Array<DurableMessagingConformanceReport["cases"][number]> = [];
	for (const [name, run] of DURABLE_CASES) {
		try {
			const harness = await create(name);
			try {
				await run(harness);
			} finally {
				await harness.close();
			}
			results.push({ name, status: "pass" });
		} catch (error) {
			results.push({
				name,
				status: "fail",
				detail:
					error instanceof DurableMessagingConformanceFailure
						? error.message
						: "provider threw or returned malformed data",
			});
		}
	}
	return {
		contract: DURABLE_MESSAGING_CONFORMANCE,
		executionEvidence: {
			processRestart: "unverified",
			persistedStoreIdentity: "unverified",
			faultPlacement: "unverified",
			tenantIdentity: "unverified",
			clock: "unverified",
			concurrencyBarrier: "unverified",
		},
		cases: results,
	};
}
