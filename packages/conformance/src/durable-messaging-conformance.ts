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

export type DurableMessagingConformanceCase =
	| "group-isolation"
	| "restart"
	| "ack-before-commit-uncertainty"
	| "ack-after-commit-uncertainty"
	| "lease-expiry"
	| "dead-letter"
	| "dead-letter-rollback"
	| "compaction"
	| "receipt-revocation"
	| "receipt-capacity"
	| "receipt-unavailable"
	| "operation-replay"
	| "tenant-isolation"
	| "bounds";

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
}

export interface DurableMessagingConformanceReport {
	readonly contract: typeof DURABLE_MESSAGING_CONFORMANCE;
	readonly cases: Readonly<
		Record<
			DurableMessagingConformanceCase,
			{ readonly status: "pass" | "fail"; readonly detail?: string }
		>
	>;
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
			client.limits.leaseMs >= 100 &&
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
		lost.status === "unknown" && lost.operation.id === request.operation.id,
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
	const secondClient = await harness.connect("tenant-a");
	const second = firstDelivery(
		await f.consume(secondClient, "orders", "group-a"),
	);
	requireCondition(
		first.leaseId !== second.leaseId &&
			second.deliveryAttempt === first.deliveryAttempt + 1,
		"expired lease was not fenced",
	);
	const staleAck = await f.client.ack(acknowledgement(f.next(), first));
	const staleNack = await f.client.nack({
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
		lost.status === "unknown",
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
		sameBytes(dead.message.payload, new Uint8Array([0, 1, 255])) &&
			dead.message.subject === "orders.created" &&
			JSON.stringify(dead.message.attributes) ===
				JSON.stringify([{ key: "content-type", value: "binary" }]) &&
			dead.deadLetter?.sourceTopic === "orders" &&
			dead.deadLetter.consumerGroup === "group-a" &&
			dead.deadLetter.originalMessageId === "message-1" &&
			dead.deadLetter.originalSequence === second.sequence &&
			dead.deadLetter.deliveryAttempt === 2 &&
			dead.deadLetter.reason === "permanent",
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
		lost.status === "unknown",
		"lost publish response was not unknown",
	);
	await harness.blockNextReceiptLookup(reason);
	const blocked = await f.client.publish(request);
	requireCondition(
		blocked.status === "unknown" &&
			blocked.operation.id === request.operation.id,
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
	const receipt = await committed(f.client.nack(request));
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
		first.messageId === again.messageId,
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
		expired.status === "expired" && expired.operation.id === operation.id,
		"expired retry did not remain explicitly uncertain",
	);
	const deliveries = await f.consume(reopened, "orders", "group-a");
	requireCondition(
		deliveries.length === 1 && sameMessage(firstDelivery(deliveries)),
		"retry created a duplicate or lost the original",
	);
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

async function bounds(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	// SAFETY: these keys come from the exact frozen limits record.
	const keys = Object.keys(
		DURABLE_MESSAGING_LIMITS,
	) as (keyof DurableMessagingLimits)[];
	for (const key of keys) {
		const declared = f.client.limits[key];
		const maximum = DURABLE_MESSAGING_LIMITS[key];
		requireCondition(
			Number.isSafeInteger(declared) && declared > 0 && declared <= maximum,
			`invalid provider limit ${key}`,
		);
	}
	await f.subscribe("orders", "group-a", "orders-dlq");
	const invalid = await f.client.publish({
		operation: f.next(),
		topic: "orders",
		message: {
			id: "large",
			subject: "orders",
			payload: new Uint8Array(f.client.limits.payloadBytes + 1),
			attributes: [],
		},
	});
	requireCondition(
		invalid.status === "rejected" && invalid.code === "invalid-argument",
		"oversized payload was not rejected",
	);
	const invalidBatch = await f.client.consume({
		operation: f.next(),
		topic: "orders",
		consumerGroup: "group-a",
		maxMessages: f.client.limits.batchSize + 1,
		visibilityTimeoutMs: 100,
	});
	requireCondition(
		invalidBatch.status === "rejected" &&
			invalidBatch.code === "invalid-argument",
		"oversized batch was not rejected",
	);
	requireCondition(
		(await f.consume(f.client, "orders", "group-a")).length === 0,
		"invalid operations changed durable state",
	);
}

/** Bounded executable cases; a pass is not proof that the harness uses a live provider. */
export async function runDurableMessagingConformance(
	create: () => Promise<DurableMessagingConformanceHarness>,
): Promise<DurableMessagingConformanceReport> {
	const cases: Array<
		[
			DurableMessagingConformanceCase,
			(harness: DurableMessagingConformanceHarness) => Promise<void>,
		]
	> = [
		["group-isolation", groupIsolation],
		["restart", restart],
		[
			"ack-before-commit-uncertainty",
			(harness) => uncertainAck(harness, "before-commit"),
		],
		[
			"ack-after-commit-uncertainty",
			(harness) => uncertainAck(harness, "after-commit"),
		],
		["lease-expiry", leaseExpiry],
		["dead-letter", deadLetter],
		["dead-letter-rollback", deadLetterRollback],
		["compaction", compaction],
		[
			"receipt-revocation",
			(harness) => unavailableReceipt(harness, "revocation"),
		],
		["receipt-capacity", (harness) => unavailableReceipt(harness, "capacity")],
		[
			"receipt-unavailable",
			(harness) => unavailableReceipt(harness, "unavailable"),
		],
		["operation-replay", operationReplay],
		["tenant-isolation", tenantIsolation],
		["bounds", bounds],
	];
	// SAFETY: every declared case is assigned exactly once in the loop below.
	const results = Object.create(null) as Record<
		DurableMessagingConformanceCase,
		{ status: "pass" | "fail"; detail?: string }
	>;
	for (const [name, run] of cases) {
		try {
			const harness = await create();
			try {
				await run(harness);
			} finally {
				await harness.close();
			}
			results[name] = { status: "pass" };
		} catch (error) {
			results[name] = {
				status: "fail",
				detail:
					error instanceof DurableMessagingConformanceFailure
						? error.message
						: "provider threw or returned malformed data",
			};
		}
	}
	return { contract: DURABLE_MESSAGING_CONFORMANCE, cases: results };
}
