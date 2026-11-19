import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";
import {
	DURABLE_MESSAGING_LIMITS,
	type DurableMessaging,
	type DurableMessagingDelivery,
	type DurableMessagingLimits,
	type DurableMessagingMessage,
	type DurableMessagingOperation,
	type DurableMessagingOutcome,
	durableMessagingOperation,
	parseDurableMessagingOperation,
} from "@hobo/core";
import {
	InvalidProviderLimit,
	snapshotAudit,
	snapshotLimits,
	snapshotMutation,
} from "./durable-messaging-shapes.js";

// public-contract: version of the bounded durable-messaging conformance suite.
export const DURABLE_MESSAGING_CONFORMANCE =
	"hobo.durable-messaging-conformance/v1";
const monotonicNow = performance.now.bind(performance);

export type DurableMessagingConformanceCase = (typeof DURABLE_CASES)[number][0];

export interface DurableMessagingConformanceHarness {
	connect(tenant: "tenant-a" | "tenant-b"): Promise<DurableMessaging>;
	restart(): Promise<void>;
	close(): Promise<void>;
	nowMs(): number;
	advanceMs(delta: number): Promise<void>;
	loseNextMutationResponse(
		point: "before-commit" | "after-commit",
	): Promise<void>;
	loseNextMutationTransport(mode: "throw" | "disconnect"): Promise<void>;
	rejectNextDeadLetterWrite(): Promise<void>;
	blockNextReceiptLookup(
		reason: "revocation" | "capacity" | "unavailable",
	): Promise<void>;
	switchAuthority(mode: "unverified" | "verified-shared"): Promise<void>;
	holdNextMutation(point: "before-dispatch" | "before-commit"): Promise<{
		readonly reached: Promise<void>;
		release(): Promise<void>;
	}>;
	holdConcurrentMutations(): Promise<{
		readonly reached: Promise<void>;
		release(): Promise<void>;
	}>;
}

export interface DurableMessagingConformanceReport {
	readonly contract: typeof DURABLE_MESSAGING_CONFORMANCE;
	readonly selection: "all" | DurableMessagingConformanceCase;
	readonly executionEvidence: {
		readonly processRestart: "unverified";
		readonly persistedStoreIdentity: "unverified";
		readonly faultPlacement: "unverified";
		readonly tenantIdentity: "unverified";
		readonly clock: "unverified";
		readonly concurrencyBarrier: "unverified";
		readonly authorityTransition: "unverified";
		readonly oldOwnerFence: "unverified";
		readonly caseIsolation: "unverified";
	};
	readonly cases: readonly {
		readonly name: DurableMessagingConformanceCase;
		readonly status: "pass" | "fail" | "unknown" | "unverified";
		readonly detail?: string;
	}[];
}

function sameOperation(
	left: DurableMessagingOperation,
	right: DurableMessagingOperation,
): boolean {
	try {
		if (utilTypes.isProxy(left)) return false;
		const prototype = Object.getPrototypeOf(left);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const snapshot = parseDurableMessagingOperation(left);
		return (
			snapshot.id === right.id && snapshot.expiresAtMs === right.expiresAtMs
		);
	} catch {
		return false;
	}
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: this validator checks untrusted provider outcomes without invoking accessors. */
export function validUnknownEnvelope(
	value: unknown,
	expected: DurableMessagingOperation,
): boolean {
	try {
		if (
			value === null ||
			typeof value !== "object" ||
			utilTypes.isProxy(value) ||
			Array.isArray(value)
		)
			return false;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const fields = Object.getOwnPropertyDescriptors(value);
		if (
			Object.getOwnPropertySymbols(value).length !== 0 ||
			Object.keys(fields).length !== 2 ||
			!Object.hasOwn(fields, "status") ||
			!Object.hasOwn(fields, "operation") ||
			fields.status === undefined ||
			fields.operation === undefined ||
			!Object.hasOwn(fields.status, "value") ||
			!Object.hasOwn(fields.operation, "value") ||
			!fields.status.enumerable ||
			!fields.operation.enumerable ||
			fields.status.value !== "unknown"
		)
			return false;
		return sameOperation(fields.operation.value, expected);
	} catch {
		return false;
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: this checks untrusted outcome fields without invoking accessors. */
function ensureExpectedUnknown(
	outcome: DurableMessagingOutcome<unknown>,
	expected: DurableMessagingOperation,
	forbidDisclosure = false,
): void {
	if (validUnknownEnvelope(outcome, expected)) return;
	try {
		const status = Object.getOwnPropertyDescriptor(outcome, "status");
		if (status === undefined || !Object.hasOwn(status, "value"))
			throw new Error("missing status");
		if (forbidDisclosure) {
			const value = Object.getOwnPropertyDescriptor(outcome, "value");
			if (
				value !== undefined &&
				Object.hasOwn(value, "value") &&
				value.value !== undefined &&
				value.value !== null
			)
				throw new DurableMessagingConformanceFailure(
					"revoked principal received disclosed data",
				);
			const operation = Object.getOwnPropertyDescriptor(outcome, "operation");
			if (
				operation !== undefined &&
				Object.hasOwn(operation, "value") &&
				operation.value !== null &&
				typeof operation.value === "object"
			) {
				const payload = Object.getOwnPropertyDescriptor(
					operation.value,
					"payload",
				);
				if (
					payload !== undefined &&
					Object.hasOwn(payload, "value") &&
					payload.value !== undefined &&
					payload.value !== null
				)
					throw new DurableMessagingConformanceFailure(
						"revoked principal received disclosed data",
					);
			}
		}
		if (status.value === "committed" || status.value === "rejected") {
			ensureDefiniteOutcome(outcome);
			return;
		}
	} catch (error) {
		if (error instanceof DurableMessagingConformanceFailure) throw error;
	}
	throw new DurableMessagingConformanceUnknown(
		"provider returned malformed or unresolved uncertainty",
	);
}
/* oxlint-enable anti-slop/no-runtime-typeof */

class DurableMessagingConformanceFailure extends Error {}
class DurableMessagingConformanceUnverified extends Error {}
class DurableMessagingConformanceUnknown extends Error {}

const rejectionCodes = [
	"invalid-argument",
	"unauthorized",
	"not-found",
	"unsupported",
	"operation-conflict",
	"message-conflict",
	"subscription-conflict",
	"retention-blocked",
	"lease-lost",
	"capacity-exceeded",
	"unavailable",
] as const;

function ensureDefiniteOutcome(
	outcome: DurableMessagingOutcome<unknown>,
): void {
	try {
		const status = Object.getOwnPropertyDescriptor(outcome, "status");
		if (status === undefined || !Object.hasOwn(status, "value"))
			throw new Error("missing status");
		if (status.value === "committed") {
			const value = Object.getOwnPropertyDescriptor(outcome, "value");
			if (
				value === undefined ||
				!Object.hasOwn(value, "value") ||
				value.value === undefined ||
				value.value === null
			)
				throw new Error("missing value");
			return;
		}
		if (status.value === "rejected") {
			const code = Object.getOwnPropertyDescriptor(outcome, "code");
			if (
				code === undefined ||
				!Object.hasOwn(code, "value") ||
				!rejectionCodes.some((candidate) => candidate === code.value)
			)
				throw new Error("invalid rejection");
			if (
				code.value === "unauthorized" ||
				code.value === "unavailable" ||
				code.value === "unsupported"
			)
				throw new Error("authority or capability unavailable");
			return;
		}
	} catch {}
	throw new DurableMessagingConformanceUnknown(
		"provider outcome is uncertain or malformed",
	);
}

function ensureExpiredOrDefinite(
	outcome: DurableMessagingOutcome<unknown>,
	expected: DurableMessagingOperation,
): void {
	try {
		const status = Object.getOwnPropertyDescriptor(outcome, "status");
		if (
			status !== undefined &&
			Object.hasOwn(status, "value") &&
			status.value === "expired"
		) {
			const operation = Object.getOwnPropertyDescriptor(outcome, "operation");
			if (
				operation === undefined ||
				!Object.hasOwn(operation, "value") ||
				!sameOperation(operation.value, expected)
			)
				throw new DurableMessagingConformanceUnknown(
					"provider returned malformed expired identity",
				);
			return;
		}
	} catch (error) {
		if (error instanceof DurableMessagingConformanceUnknown) throw error;
		throw new DurableMessagingConformanceUnknown(
			"provider returned malformed expiry outcome",
		);
	}
	ensureDefiniteOutcome(outcome);
}

function requireCondition(value: boolean, message: string): void {
	if (!value) throw new DurableMessagingConformanceFailure(message);
}

function validateLimits(limits: DurableMessagingLimits): void {
	// SAFETY: these keys come from the exact frozen limits record.
	const keys = Object.keys(
		DURABLE_MESSAGING_LIMITS,
	) as (keyof DurableMessagingLimits)[];
	for (const key of keys) {
		const declared = limits[key];
		requireCondition(
			Number.isSafeInteger(declared) &&
				declared > 0 &&
				declared <= DURABLE_MESSAGING_LIMITS[key],
			`invalid provider limit ${key}`,
		);
	}
}

function requireProfile(value: boolean, message: string): void {
	if (!value) throw new DurableMessagingConformanceUnverified(message);
}

async function committed<T>(
	input: Promise<DurableMessagingOutcome<T>>,
): Promise<T> {
	const outcome = await input;
	let status: PropertyDescriptor | undefined;
	let value: PropertyDescriptor | undefined;
	try {
		status = Object.getOwnPropertyDescriptor(outcome, "status");
		value = Object.getOwnPropertyDescriptor(outcome, "value");
	} catch {
		throw new DurableMessagingConformanceUnknown(
			"provider returned a malformed outcome",
		);
	}
	if (
		status === undefined ||
		!Object.hasOwn(status, "value") ||
		status.value !== "committed"
	)
		throw new DurableMessagingConformanceUnknown(
			"operation did not establish a committed outcome",
		);
	if (
		value === undefined ||
		!Object.hasOwn(value, "value") ||
		value.value === undefined ||
		value.value === null
	)
		throw new DurableMessagingConformanceUnknown(
			"provider returned a malformed committed receipt",
		);
	return value.value;
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: provider receipts must be validated before they can establish evidence. */
function requireTopicReceipt(
	receipt: { readonly topic: string },
	expected: string,
): void {
	let topic: PropertyDescriptor | undefined;
	try {
		topic = Object.getOwnPropertyDescriptor(receipt, "topic");
	} catch {
		throw new DurableMessagingConformanceUnknown(
			"provider returned a malformed topic receipt",
		);
	}
	if (
		topic === undefined ||
		!Object.hasOwn(topic, "value") ||
		typeof topic.value !== "string"
	)
		throw new DurableMessagingConformanceUnknown(
			"provider returned a malformed topic receipt",
		);
	requireCondition(
		topic.value === expected,
		"topic receipt did not identify its request",
	);
}
/* oxlint-enable anti-slop/no-runtime-typeof */

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
		sameExpectedAttributes(delivery.message.attributes)
	);
}

function sameExpectedAttributes(
	attributes: DurableMessagingDelivery["message"]["attributes"],
): boolean {
	return (
		attributes.length === 1 &&
		attributes[0]?.key === "content-type" &&
		attributes[0]?.value === "binary"
	);
}

export function sameDurableDelivery(
	left: DurableMessagingDelivery,
	right: DurableMessagingDelivery,
): boolean {
	const a = left.deadLetter;
	const b = right.deadLetter;
	const sameDead =
		a === undefined
			? b === undefined
			: b !== undefined &&
				a.sourceTopic === b.sourceTopic &&
				a.consumerGroup === b.consumerGroup &&
				a.originalMessageId === b.originalMessageId &&
				a.originalSequence === b.originalSequence &&
				a.deliveryAttempt === b.deliveryAttempt &&
				(a.cause.kind === "lease-expired"
					? b.cause.kind === "lease-expired"
					: b.cause.kind === "nack" && a.cause.reason === b.cause.reason);
	return (
		left.topic === right.topic &&
		left.consumerGroup === right.consumerGroup &&
		left.sequence === right.sequence &&
		left.leaseId === right.leaseId &&
		left.leaseExpiresAtMs === right.leaseExpiresAtMs &&
		left.deliveryAttempt === right.deliveryAttempt &&
		left.message.id === right.message.id &&
		left.message.subject === right.message.subject &&
		sameBytes(left.message.payload, right.message.payload) &&
		left.message.attributes.length === right.message.attributes.length &&
		left.message.attributes.every(
			(entry, index) =>
				entry.key === right.message.attributes[index]?.key &&
				entry.value === right.message.attributes[index]?.value,
		) &&
		sameDead
	);
}

export function matchesDurableSettlement(
	receipt: { readonly messageId: string; readonly sequence: number },
	delivery: DurableMessagingDelivery,
): boolean {
	return (
		receipt.messageId === delivery.message.id &&
		receipt.sequence === delivery.sequence
	);
}

export function matchesDurablePublication(
	message: DurableMessagingMessage,
	receipt: { readonly messageId: string; readonly sequence: number },
	delivery: DurableMessagingDelivery,
): boolean {
	return (
		receipt.messageId === message.id &&
		matchesDurableSettlement(receipt, delivery) &&
		delivery.message.subject === message.subject &&
		sameBytes(delivery.message.payload, message.payload) &&
		delivery.message.attributes.length === message.attributes.length &&
		delivery.message.attributes.every(
			(attribute, index) =>
				attribute.key === message.attributes[index]?.key &&
				attribute.value === message.attributes[index]?.value,
		)
	);
}

type AuditPage = Extract<
	Awaited<ReturnType<DurableMessaging["events"]>>,
	{ status: "ok" }
>;
export function validDurableAuditPage(
	page: AuditPage,
	after: number,
	limit: number,
	tail: number,
): boolean {
	if (
		!Number.isSafeInteger(after) ||
		!Number.isSafeInteger(limit) ||
		!Number.isSafeInteger(tail) ||
		after < 0 ||
		limit <= 0 ||
		tail < after ||
		!Number.isSafeInteger(page.firstAvailableSequence) ||
		page.firstAvailableSequence < 1 ||
		page.firstAvailableSequence > after + 1 ||
		page.events.length > limit
	)
		return false;
	const expectedCursor = after + page.events.length;
	return (
		expectedCursor <= tail &&
		page.events.every((event, index) => event.sequence === after + index + 1) &&
		page.nextAfterSequence === expectedCursor &&
		page.hasMore === expectedCursor < tail &&
		(expectedCursor === tail || page.events.length > 0)
	);
}
function sameAuditPage(left: AuditPage, right: AuditPage): boolean {
	return (
		left.firstAvailableSequence === right.firstAvailableSequence &&
		left.nextAfterSequence === right.nextAfterSequence &&
		left.hasMore === right.hasMore &&
		left.events.length === right.events.length &&
		left.events.every((event, index) => {
			const other = right.events[index];
			return (
				other !== undefined &&
				event.sequence === other.sequence &&
				event.kind === other.kind &&
				event.topic === other.topic &&
				event.messageId === other.messageId &&
				event.consumerGroup === other.consumerGroup
			);
		})
	);
}

export function matchesTopicAuditEvents(
	events: readonly AuditPage["events"][number][],
	topics: readonly string[],
): boolean {
	return events.every(
		(event) =>
			Number.isSafeInteger(event.sequence) &&
			event.sequence >= 1 &&
			event.sequence <= topics.length &&
			event.kind === "topic-created" &&
			event.topic === topics[event.sequence - 1],
	);
}

function movingAuditGap(
	result: Awaited<ReturnType<DurableMessaging["events"]>>,
	after: number,
	tail: number,
): void {
	if (result.status !== "gap") return;
	if (
		!Number.isSafeInteger(result.firstAvailableSequence) ||
		result.firstAvailableSequence < 1 ||
		!Number.isSafeInteger(result.latestSequence) ||
		result.latestSequence < 0
	)
		throw new DurableMessagingConformanceUnknown(
			"provider returned malformed audit gap metadata",
		);
	if (
		result.latestSequence !== tail ||
		result.firstAvailableSequence <= after + 1 ||
		result.firstAvailableSequence > tail + 1
	)
		throw new DurableMessagingConformanceFailure(
			"audit retention gap was invalid",
		);
	throw new DurableMessagingConformanceUnverified(
		"audit history was reclaimed during pagination",
	);
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: audit responses cross an untrusted provider boundary. */
function ensureAuditOutcome(
	result: Awaited<ReturnType<DurableMessaging["events"]>>,
	expectInvalid = false,
): void {
	try {
		const status = Object.getOwnPropertyDescriptor(result, "status");
		if (status === undefined || !Object.hasOwn(status, "value"))
			throw new Error("missing status");
		const field = (key: string) => {
			const descriptor = Object.getOwnPropertyDescriptor(result, key);
			if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
				throw new Error("missing field");
			return descriptor.value;
		};
		if (status.value === "ok") {
			if (
				!Array.isArray(field("events")) ||
				!Number.isSafeInteger(field("firstAvailableSequence")) ||
				!Number.isSafeInteger(field("nextAfterSequence")) ||
				typeof field("hasMore") !== "boolean"
			)
				throw new Error("invalid page");
			return;
		}
		if (status.value === "gap") {
			if (
				!Number.isSafeInteger(field("firstAvailableSequence")) ||
				!Number.isSafeInteger(field("latestSequence"))
			)
				throw new Error("invalid gap");
			return;
		}
		if (
			status.value === "rejected" &&
			expectInvalid &&
			field("code") === "invalid-argument"
		)
			return;
	} catch {}
	throw new DurableMessagingConformanceUnknown(
		"audit response is unavailable or malformed",
	);
}
/* oxlint-enable anti-slop/no-runtime-typeof */

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
	validateLimits(client.limits);
	requireProfile(
		client.limits.operationWindowMs >= 1_000 &&
			client.limits.nameBytes >= 16 &&
			client.limits.reasonBytes >= 10 &&
			client.limits.payloadBytes >= 3 &&
			client.limits.attributeCount >= 1 &&
			client.limits.attributeBytes >= 18 &&
			client.limits.batchSize >= 2 &&
			client.limits.deliveryAttempts >= 3 &&
			client.limits.leaseMs >= 101 &&
			client.limits.topics >= 4 &&
			client.limits.subscriptions >= 4 &&
			client.limits.eventPageSize >= 2 &&
			client.limits.retainedMessages >= 3 &&
			client.limits.retainedReceipts >= 64,
		"provider limits are below the conformance profile",
	);
	const next = operations(
		harness,
		Math.min(client.limits.operationWindowMs, 10_000),
	);
	for (const topic of ["orders", "orders-dlq", "archive"]) {
		const receipt = await committed(
			client.ensureTopic({ operation: next(), topic }),
		);
		requireTopicReceipt(receipt, topic);
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
	ensureDefiniteOutcome(wrongGroup);
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
	ensureExpectedUnknown(lost, request.operation);
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
	ensureDefiniteOutcome(staleAck);
	ensureDefiniteOutcome(staleNack);
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
		sameDurableDelivery(replay, first) && sameMessage(replay),
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
		matchesDurableSettlement(acked, second) &&
			matchesDurableSettlement(ackReplay, second) &&
			matchesDurableSettlement(nacked, groupB) &&
			matchesDurableSettlement(nackReplay, groupB) &&
			nacked.disposition === "released" &&
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
		released.disposition === "released" &&
			matchesDurableSettlement(released, first),
		"first failure was not released",
	);
	const second = firstDelivery(await f.consume(f.client, "orders", "group-a"));
	const request = { ...acknowledgement(f.next(), second), reason: "permanent" };
	await harness.loseNextMutationResponse("after-commit");
	const lost = await f.client.nack(request);
	ensureExpectedUnknown(lost, request.operation);
	requireCondition(
		lost.status === "unknown" &&
			sameOperation(lost.operation, request.operation),
		"lost dead-letter response was not unknown",
	);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	const receipt = await committed(reopened.nack(request));
	requireCondition(
		receipt.disposition === "dead-lettered" &&
			matchesDurableSettlement(receipt, second),
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
			sameExpectedAttributes(dead.message.attributes) &&
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
	ensureDefiniteOutcome(blocked);
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
	ensureDefiniteOutcome(stale);
	ensureDefiniteOutcome(forged);
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
	ensureExpectedUnknown(lost, request.operation);
	requireCondition(
		lost.status === "unknown" &&
			sameOperation(lost.operation, request.operation),
		"lost publish response was not unknown",
	);
	await harness.blockNextReceiptLookup(reason);
	const blocked = await f.client.publish(request);
	ensureExpectedUnknown(blocked, request.operation);
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

async function revokedReceipt(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.publish();
	const request = {
		operation: f.next(),
		topic: "orders",
		consumerGroup: "group-a",
		maxMessages: 1,
		visibilityTimeoutMs: 100,
	};
	const original = firstDelivery(await committed(f.client.consume(request)));
	await harness.blockNextReceiptLookup("revocation");
	const revoked = await f.client.consume(request);
	ensureExpectedUnknown(revoked, request.operation, true);
	requireCondition(
		validUnknownEnvelope(revoked, request.operation),
		"revoked principal received a cached delivery or a false rejection",
	);
	const replay = firstDelivery(await committed(f.client.consume(request)));
	requireCondition(
		sameDurableDelivery(replay, original) && sameMessage(replay),
		"reauthorized principal could not recover the exact receipt",
	);
}

async function transportFailure(
	harness: DurableMessagingConformanceHarness,
	mode: "throw" | "disconnect",
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
	await harness.loseNextMutationTransport(mode);
	const lost = await f.client.publish(request);
	ensureExpectedUnknown(lost, request.operation);
	requireCondition(
		lost.status === "unknown" &&
			sameOperation(lost.operation, request.operation),
		"post-commit transport failure did not preserve uncertainty",
	);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	const receipt = await committed(reopened.publish(request));
	const delivery = firstDelivery(
		await f.consume(reopened, "orders", "group-a"),
	);
	requireCondition(
		receipt.messageId === delivery.message.id &&
			receipt.sequence === delivery.sequence &&
			sameMessage(delivery),
		"transport failure retry did not recover the committed message",
	);
}

async function independentOperationIdLimit(
	harness: DurableMessagingConformanceHarness,
) {
	const client = await harness.connect("tenant-a");
	validateLimits(client.limits);
	requireProfile(
		client.limits.nameBytes > 0 &&
			client.limits.nameBytes <= 16 &&
			client.limits.operationWindowMs >= 1_000 &&
			client.limits.retainedReceipts >= 2,
		"operation ID case needs a small independent name limit",
	);
	const next = operations(
		harness,
		Math.min(client.limits.operationWindowMs, 10_000),
	);
	const request = { operation: next(), topic: "a" };
	requireCondition(
		request.operation.id.length > client.limits.nameBytes,
		"test operation does not exceed name limit",
	);
	const first = await committed(client.ensureTopic(request));
	const replay = await committed(client.ensureTopic(request));
	requireCondition(
		first.topic === "a" && replay.topic === first.topic,
		"valid operation ID was constrained by the provider name limit",
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
	ensureExpectedUnknown(lost, request.operation);
	requireCondition(
		lost.status === "unknown" &&
			sameOperation(lost.operation, request.operation),
		"lost publish did not preserve its operation identity",
	);
	const delayedRequest = {
		operation: f.next(),
		topic: "orders",
		message: {
			id: "message-2",
			subject: "next",
			payload: new Uint8Array([2]),
			attributes: [],
		},
	};
	const barrier = await harness.holdNextMutation("before-dispatch");
	const delayed = f.client.publish(delayedRequest);
	await barrier.reached;
	await harness.switchAuthority("unverified");
	const unverified = await harness.connect("tenant-a");
	const uncertain = await unverified.publish(request);
	ensureExpectedUnknown(uncertain, request.operation);
	requireCondition(
		uncertain.status === "unknown" &&
			sameOperation(uncertain.operation, request.operation),
		"unverified failover gave a definite answer",
	);
	await harness.switchAuthority("verified-shared");
	await barrier.release();
	const fenced = await delayed;
	ensureExpectedUnknown(fenced, delayedRequest.operation);
	requireCondition(
		fenced.status === "unknown" &&
			sameOperation(fenced.operation, delayedRequest.operation),
		"a held old-owner request was not fenced",
	);
	const verified = await harness.connect("tenant-a");
	const receipt = await committed(verified.publish(request));
	const delivered = firstDelivery(
		await f.consume(verified, "orders", "group-a"),
	);
	requireCondition(
		receipt.sequence === delivered.sequence && sameMessage(delivered),
		"fenced shared journal did not recover the original receipt",
	);
	const acknowledged = await committed(
		verified.ack(acknowledgement(f.next(), delivered)),
	);
	requireCondition(
		acknowledged.messageId === delivered.message.id &&
			acknowledged.sequence === delivered.sequence,
		"failover acknowledgment did not settle the original delivery",
	);
	const delayedReceipt = await committed(verified.publish(delayedRequest));
	const delayedDelivery = firstDelivery(
		await f.consume(verified, "orders", "group-a"),
	);
	requireCondition(
		delayedReceipt.messageId === delayedDelivery.message.id &&
			delayedReceipt.sequence === delayedDelivery.sequence &&
			delayedDelivery.message.id === "message-2",
		"successor did not resolve the fenced operation through its shared journal",
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
	ensureDefiniteOutcome(refused);
	requireCondition(
		refused.status === "rejected" && refused.code === "capacity-exceeded",
		"expired lease transfer failure did not reject atomically",
	);
	const replay = await reopened.consume(request);
	ensureDefiniteOutcome(replay);
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
	ensureDefiniteOutcome(blocked);
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
	ensureDefiniteOutcome(rejected);
	requireCondition(
		rejected.status === "rejected" && rejected.code === "capacity-exceeded",
		"DLQ write failure was not rejected",
	);
	requireCondition(
		(await f.consume(f.client, "orders-dlq", "dlq-reader")).length === 0,
		"rolled-back DLQ write left a message",
	);
	const replay = await f.client.nack(request);
	ensureDefiniteOutcome(replay);
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
	ensureDefiniteOutcome(first);
	requireCondition(
		first.status === "rejected" && first.code === "capacity-exceeded",
		"initial refusal was not definite",
	);
	await barrier.release();
	const later = await delayed;
	ensureDefiniteOutcome(later);
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
	ensureExpiredOrDefinite(retry, request.operation);
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
	ensureDefiniteOutcome(conflict);
	requireCondition(
		conflict.status === "rejected" && conflict.code === "operation-conflict",
		"operation ID accepted a different request",
	);
	const afterConflict = await committed(reopened.publish(request));
	requireCondition(
		afterConflict.messageId === first.messageId &&
			afterConflict.sequence === first.sequence,
		"conflict overwrote the original publish receipt",
	);
	await harness.advanceMs(operation.expiresAtMs - harness.nowMs());
	const expired = await reopened.publish(request);
	ensureExpiredOrDefinite(expired, operation);
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
	ensureDefiniteOutcome(first);
	ensureDefiniteOutcome(second);
	requireCondition(
		first.status === "committed" &&
			second.status === "committed" &&
			first.value.messageId === second.value.messageId &&
			first.value.sequence === second.value.sequence,
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
	for (const outcome of pair) ensureDefiniteOutcome(outcome);
	requireCondition(
		pair.filter((result) => result.status === "committed").length === 1 &&
			pair.filter(
				(result) =>
					result.status === "rejected" && result.code === "operation-conflict",
			).length === 1,
		"conflicting concurrent requests both took effect or neither was fenced",
	);
	const winner = pair.find((outcome) => outcome.status === "committed");
	if (winner?.status !== "committed" || first.status !== "committed")
		throw new DurableMessagingConformanceFailure(
			"conflicting publication has no winner",
		);
	const winningMessageId =
		pair[0]?.status === "committed" ? "other-a" : "other-b";
	const winningMessage = { ...request.message, id: winningMessageId };
	const deliveries: DurableMessagingDelivery[] = [];
	for (let index = 0; index < 2; index++) {
		const delivery = firstDelivery(
			await f.consume(f.client, "orders", "group-a"),
		);
		deliveries.push(delivery);
		await committed(f.client.ack(acknowledgement(f.next(), delivery)));
	}
	const originalDelivery = deliveries.find(
		(delivery) => delivery.message.id === request.message.id,
	);
	const winningDelivery = deliveries.find(
		(delivery) => delivery.message.id === winningMessageId,
	);
	requireCondition(
		originalDelivery !== undefined &&
			winningDelivery !== undefined &&
			matchesDurablePublication(
				request.message,
				first.value,
				originalDelivery,
			) &&
			sameMessage(originalDelivery) &&
			matchesDurablePublication(winningMessage, winner.value, winningDelivery),
		"concurrent publications did not deliver exactly their corresponding receipts",
	);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	requireCondition(
		(await f.consume(reopened, "orders", "group-a")).length === 0,
		"rejected conflicting publication appeared after restart",
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

async function pendingConflict(harness: DurableMessagingConformanceHarness) {
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
	const barrier = await harness.holdNextMutation("before-commit");
	const original = f.client.publish(request);
	await barrier.reached;
	const conflictingRequest = {
		...request,
		message: { ...request.message, id: "other" },
	};
	const conflict = other.publish(conflictingRequest);
	await barrier.release();
	const [first, second] = await Promise.all([original, conflict]);
	ensureDefiniteOutcome(first);
	ensureDefiniteOutcome(second);
	requireCondition(
		(first.status === "committed" &&
			second.status === "rejected" &&
			second.code === "operation-conflict") ||
			(second.status === "committed" &&
				first.status === "rejected" &&
				first.code === "operation-conflict"),
		"conflicting pending requests did not yield exactly one winner",
	);
	const winner =
		first.status === "committed"
			? first.value
			: second.status === "committed"
				? second.value
				: undefined;
	if (winner === undefined)
		throw new DurableMessagingConformanceFailure(
			"pending conflict has no winner",
		);
	const winningRequest =
		first.status === "committed" ? request : conflictingRequest;
	const losingRequest =
		first.status === "committed" ? conflictingRequest : request;
	const replay = await committed(other.publish(winningRequest));
	requireCondition(
		winner.messageId === winningRequest.message.id &&
			replay.messageId === winningRequest.message.id &&
			replay.messageId === winner.messageId &&
			replay.sequence === winner.sequence,
		"conflict overwrote the original operation receipt",
	);
	const losingReplay = await other.publish(losingRequest);
	ensureDefiniteOutcome(losingReplay);
	requireCondition(
		losingReplay.status === "rejected" &&
			losingReplay.code === "operation-conflict",
		"losing fingerprint was not fenced on retry",
	);
	const delivered = firstDelivery(await f.consume(other, "orders", "group-a"));
	requireCondition(
		matchesDurablePublication(winningRequest.message, replay, delivered) &&
			delivered.message.subject === "orders.created" &&
			sameBytes(delivered.message.payload, new Uint8Array([0, 1, 255])) &&
			sameExpectedAttributes(delivered.message.attributes),
		"conflict changed the pending operation's effect",
	);
	await committed(other.ack(acknowledgement(f.next(), delivered)));
	requireCondition(
		(await f.consume(other, "orders", "group-a")).length === 0,
		"conflicting fingerprint created a second message",
	);
}

async function ackExpiryRace(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	await f.publish();
	const old = firstDelivery(await f.consume(f.client, "orders", "group-a"));
	const other = await harness.connect("tenant-a");
	const barrier = await harness.holdConcurrentMutations();
	const ackRequest = acknowledgement(f.next(), old);
	const ack = f.client.ack(ackRequest);
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
	ensureDefiniteOutcome(oldAck);
	if (oldAck.status === "committed") {
		requireCondition(
			oldAck.value.messageId === old.message.id &&
				oldAck.value.sequence === old.sequence &&
				next.length === 0,
			"acknowledged delivery was concurrently re-leased",
		);
		await harness.restart();
		const reopened = await harness.connect("tenant-a");
		const replay = await committed(reopened.ack(ackRequest));
		requireCondition(
			matchesDurableSettlement(replay, old) &&
				(await f.consume(reopened, "orders", "group-a")).length === 0,
			"committed acknowledgment was lost or redelivered after restart",
		);
	} else {
		requireCondition(
			oldAck.status === "rejected" &&
				oldAck.code === "lease-lost" &&
				next.length <= 1,
			"expiry race had an invalid outcome",
		);
		const renewed = firstDelivery(
			next.length === 1 ? next : await f.consume(other, "orders", "group-a"),
		);
		requireCondition(
			renewed.sequence === old.sequence &&
				renewed.message.id === old.message.id &&
				renewed.leaseId !== old.leaseId &&
				renewed.deliveryAttempt === old.deliveryAttempt + 1,
			"expired lease was lost or not fenced on redelivery",
		);
	}
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
	ensureDefiniteOutcome(conflict);
	requireCondition(
		conflict.status === "rejected" && conflict.code === "operation-conflict",
		"the operation fingerprint omitted the method or scope",
	);
}

async function fingerprintFields(harness: DurableMessagingConformanceHarness) {
	const f = await createFixture(harness);
	await f.subscribe("orders", "group-a", "orders-dlq");
	const message = {
		id: "message-1",
		subject: "orders.created",
		payload: new Uint8Array([0, 1, 255]),
		attributes: [{ key: "content-type", value: "binary" }],
	};
	const publish = { operation: f.next(), topic: "orders", message };
	const published = await committed(f.client.publish(publish));
	const expectConflict = async (
		promise: Promise<DurableMessagingOutcome<unknown>>,
	) => {
		const outcome = await promise;
		ensureDefiniteOutcome(outcome);
		requireCondition(
			outcome.status === "rejected" && outcome.code === "operation-conflict",
			"semantic request change was not fenced",
		);
	};
	for (const request of [
		{ ...publish, topic: "archive" },
		{ ...publish, message: { ...message, id: "other" } },
		{ ...publish, message: { ...message, subject: "other" } },
		{ ...publish, message: { ...message, payload: new Uint8Array([9]) } },
		{
			...publish,
			message: { ...message, attributes: [{ key: "other", value: "binary" }] },
		},
		{
			...publish,
			message: {
				...message,
				attributes: [{ key: "content-type", value: "other" }],
			},
		},
	])
		await expectConflict(f.client.publish(request));
	const publishReplay = await committed(f.client.publish(publish));
	requireCondition(
		publishReplay.messageId === published.messageId &&
			publishReplay.sequence === published.sequence,
		"publish conflict overwrote the original receipt",
	);
	const subscription = {
		topic: "orders",
		consumerGroup: "group-b",
		deadLetterTopic: "orders-dlq",
		maxDeliveryAttempts: 2,
		startAt: "earliest" as const,
	};
	const subRequest = { operation: f.next(), subscription };
	const subscribed = await committed(f.client.ensureSubscription(subRequest));
	for (const changed of [
		{ ...subscription, topic: "archive" },
		{ ...subscription, consumerGroup: "group-c" },
		{ ...subscription, deadLetterTopic: "archive" },
		{ ...subscription, maxDeliveryAttempts: 3 },
		{ ...subscription, startAt: "latest" as const },
	])
		await expectConflict(
			f.client.ensureSubscription({ ...subRequest, subscription: changed }),
		);
	const subscriptionReplay = await committed(
		f.client.ensureSubscription(subRequest),
	);
	requireCondition(
		subscriptionReplay.firstAvailableSequence ===
			subscribed.firstAvailableSequence &&
			subscriptionReplay.historyTruncated === subscribed.historyTruncated &&
			subscriptionReplay.subscription.topic === subscribed.subscription.topic &&
			subscriptionReplay.subscription.consumerGroup ===
				subscribed.subscription.consumerGroup &&
			subscriptionReplay.subscription.deadLetterTopic ===
				subscribed.subscription.deadLetterTopic &&
			subscriptionReplay.subscription.maxDeliveryAttempts ===
				subscribed.subscription.maxDeliveryAttempts &&
			subscriptionReplay.subscription.startAt ===
				subscribed.subscription.startAt,
		"subscription conflict overwrote the original receipt",
	);
	const consume = {
		operation: f.next(),
		topic: "orders",
		consumerGroup: "group-a",
		maxMessages: 1,
		visibilityTimeoutMs: 100,
	};
	const delivery = firstDelivery(await committed(f.client.consume(consume)));
	for (const changed of [
		{ ...consume, topic: "archive" },
		{ ...consume, consumerGroup: "group-b" },
		{ ...consume, maxMessages: 2 },
		{ ...consume, visibilityTimeoutMs: 101 },
	])
		await expectConflict(f.client.consume(changed));
	const consumeReplay = firstDelivery(
		await committed(f.client.consume(consume)),
	);
	requireCondition(
		sameDurableDelivery(consumeReplay, delivery),
		"consume conflict overwrote the original receipt",
	);
	const nack = { ...acknowledgement(f.next(), delivery), reason: "retry" };
	const nackReceipt = await committed(f.client.nack(nack));
	for (const changed of [
		{ ...nack, topic: "archive" },
		{ ...nack, consumerGroup: "group-b" },
		{ ...nack, messageId: "other" },
		{ ...nack, sequence: nack.sequence + 1 },
		{ ...nack, leaseId: "other" },
		{ ...nack, reason: "other" },
	])
		await expectConflict(f.client.nack(changed));
	const nackReplay = await committed(f.client.nack(nack));
	requireCondition(
		nackReceipt.disposition === "released" &&
			nackReplay.disposition === "released" &&
			matchesDurableSettlement(nackReceipt, delivery) &&
			matchesDurableSettlement(nackReplay, delivery),
		"nack conflict overwrote the original receipt",
	);
	const topicRequest = { operation: f.next(), topic: "archive" };
	const topicReceipt = await committed(f.client.ensureTopic(topicRequest));
	await expectConflict(
		f.client.ensureTopic({ ...topicRequest, topic: "orders" }),
	);
	requireCondition(
		(await committed(f.client.ensureTopic(topicRequest))).topic ===
			topicReceipt.topic,
		"topic conflict overwrote its receipt",
	);
	const compact = { operation: f.next(), topic: "orders", throughSequence: 0 };
	const compactReceipt = await committed(f.client.compact(compact));
	await expectConflict(
		f.client.compact({ ...compact, throughSequence: delivery.sequence }),
	);
	const compactReplay = await committed(f.client.compact(compact));
	requireCondition(
		compactReplay.topic === compactReceipt.topic &&
			compactReplay.firstAvailableSequence ===
				compactReceipt.firstAvailableSequence &&
			compactReplay.removedMessages === compactReceipt.removedMessages,
		"compaction conflict overwrote its receipt",
	);
	const nextDelivery = firstDelivery(
		await f.consume(f.client, "orders", "group-a"),
	);
	const ack = acknowledgement(f.next(), nextDelivery);
	const ackReceipt = await committed(f.client.ack(ack));
	for (const changed of [
		{ ...ack, sequence: ack.sequence + 1 },
		{ ...ack, leaseId: "other" },
		{ ...ack, topic: "archive" },
		{ ...ack, consumerGroup: "group-b" },
		{ ...ack, messageId: "other" },
	])
		await expectConflict(f.client.ack(changed));
	const ackReplay = await committed(f.client.ack(ack));
	requireCondition(
		matchesDurableSettlement(ackReceipt, nextDelivery) &&
			matchesDurableSettlement(ackReplay, nextDelivery),
		"acknowledgment conflict overwrote its receipt",
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
	ensureDefiniteOutcome(compacted);
	ensureDefiniteOutcome(subscribed);
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
	const topics = ["orders", "orders-dlq", "archive", "audit-extra"];
	await committed(
		f.client.ensureTopic({ operation: f.next(), topic: "audit-extra" }),
	);
	const initial = await f.client.events({ afterSequence: 0, limit: 2 });
	ensureAuditOutcome(initial);
	let cursor = 0;
	if (initial.status === "gap") {
		requireCondition(
			initial.latestSequence === 4 &&
				initial.firstAvailableSequence > 1 &&
				initial.firstAvailableSequence <= 5,
			"invalid initial audit gap",
		);
		cursor = initial.firstAvailableSequence - 1;
	} else if (initial.status !== "ok")
		throw new DurableMessagingConformanceFailure(
			"initial audit page unavailable",
		);
	if (4 - cursor < 3)
		throw new DurableMessagingConformanceUnverified(
			"provider retained too few events to establish pagination",
		);
	const first =
		cursor === 0
			? initial
			: await f.client.events({ afterSequence: cursor, limit: 2 });
	ensureAuditOutcome(first);
	movingAuditGap(first, cursor, 4);
	if (first.status !== "ok")
		throw new DurableMessagingConformanceFailure(
			"first retained audit page unavailable",
		);
	requireCondition(
		validDurableAuditPage(first, cursor, 2, 4) &&
			matchesTopicAuditEvents(first.events, topics) &&
			first.hasMore,
		"first audit page was not ordered or complete",
	);
	const repeated = await f.client.events({ afterSequence: cursor, limit: 2 });
	ensureAuditOutcome(repeated);
	movingAuditGap(repeated, cursor, 4);
	requireCondition(
		repeated.status === "ok" &&
			validDurableAuditPage(repeated, cursor, 2, 4) &&
			sameAuditPage(repeated, first),
		"reused audit cursor changed without writes",
	);
	let after = first.nextAfterSequence;
	while (after < 4) {
		const page = await f.client.events({ afterSequence: after, limit: 2 });
		ensureAuditOutcome(page);
		movingAuditGap(page, after, 4);
		if (page.status !== "ok" || !validDurableAuditPage(page, after, 2, 4))
			throw new DurableMessagingConformanceFailure(
				"next audit page skipped or reordered events",
			);
		if (!matchesTopicAuditEvents(page.events, topics))
			throw new DurableMessagingConformanceFailure(
				"audit page changed topic creation identity",
			);
		after = page.nextAfterSequence;
	}
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	const afterRestart = await reopened.events({
		afterSequence: cursor,
		limit: 2,
	});
	ensureAuditOutcome(afterRestart);
	movingAuditGap(afterRestart, cursor, 4);
	requireCondition(
		afterRestart.status === "ok" &&
			validDurableAuditPage(afterRestart, cursor, 2, 4) &&
			sameAuditPage(afterRestart, first),
		"audit cursor or page changed on restart",
	);
}

async function auditRetention(harness: DurableMessagingConformanceHarness) {
	const client = await harness.connect("tenant-a");
	validateLimits(client.limits);
	requireProfile(
		client.limits.retainedEvents >= 2 &&
			client.limits.retainedEvents <= 32 &&
			client.limits.topics >= client.limits.retainedEvents + 3 &&
			client.limits.retainedReceipts >= 64 &&
			client.limits.operationWindowMs >= 1_000,
		"audit retention harness limits are not configured for this case",
	);
	const next = operations(
		harness,
		Math.min(client.limits.operationWindowMs, 10_000),
	);
	const total = client.limits.retainedEvents + 2;
	const topics = Array.from({ length: total }, (_, index) => `audit-${index}`);
	for (let index = 0; index < total; index++)
		await committed(
			client.ensureTopic({ operation: next(), topic: `audit-${index}` }),
		);
	const gap = await client.events({ afterSequence: 0, limit: 2 });
	ensureAuditOutcome(gap);
	if (gap.status !== "gap")
		throw new DurableMessagingConformanceFailure(
			"old audit cursor did not report the retention gap",
		);
	requireCondition(
		gap.firstAvailableSequence >= 3 &&
			gap.firstAvailableSequence <= total + 1 &&
			gap.latestSequence === total,
		"audit gap gave an invalid floor or tail",
	);
	const floor = gap.firstAvailableSequence;
	const page = await client.events({ afterSequence: floor - 1, limit: 2 });
	ensureAuditOutcome(page);
	movingAuditGap(page, floor - 1, total);
	requireCondition(
		page.status === "ok" &&
			matchesTopicAuditEvents(page.events, topics) &&
			validDurableAuditPage(page, floor - 1, 2, total) &&
			page.firstAvailableSequence === floor &&
			(floor === total + 1
				? page.events.length === 0 &&
					page.nextAfterSequence === total &&
					!page.hasMore
				: page.events.length > 0 &&
					page.events.every(
						(event, index) => event.sequence === floor + index,
					) &&
					page.nextAfterSequence === floor + page.events.length - 1 &&
					page.hasMore === page.nextAfterSequence < total),
		"audit did not resume at the retained floor",
	);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	await committed(
		reopened.ensureTopic({ operation: next(), topic: "audit-next" }),
	);
	const nextPage = await reopened.events({ afterSequence: total, limit: 2 });
	ensureAuditOutcome(nextPage);
	requireCondition(
		(nextPage.status === "ok" &&
			matchesTopicAuditEvents(nextPage.events, [...topics, "audit-next"]) &&
			validDurableAuditPage(nextPage, total, 2, total + 1) &&
			nextPage.events.length === 1 &&
			nextPage.events[0]?.sequence === total + 1 &&
			nextPage.nextAfterSequence === total + 1 &&
			!nextPage.hasMore) ||
			(nextPage.status === "gap" &&
				nextPage.firstAvailableSequence === total + 2 &&
				nextPage.latestSequence === total + 1),
		"audit sequence was reused or reset after retention and restart",
	);
	const future = await reopened.events({ afterSequence: total + 2, limit: 1 });
	ensureAuditOutcome(future, true);
	requireCondition(
		future.status === "rejected" && future.code === "invalid-argument",
		"future audit cursor was accepted",
	);
}

async function topicCapacity(harness: DurableMessagingConformanceHarness) {
	const client = await harness.connect("tenant-a");
	validateLimits(client.limits);
	requireProfile(
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
	ensureDefiniteOutcome(denied);
	requireCondition(
		denied.status === "rejected" && denied.code === "capacity-exceeded",
		"topic capacity was not enforced",
	);
	await harness.restart();
	const reopened = await harness.connect("tenant-a");
	const replay = await reopened.ensureTopic(excess);
	ensureDefiniteOutcome(replay);
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
	validateLimits(f.client.limits);
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
		{
			id: "too-many-attributes",
			subject: "orders",
			payload: new Uint8Array(),
			attributes: Array.from(
				{ length: f.client.limits.attributeCount + 1 },
				(_, index) => ({ key: `k${index}`, value: "v" }),
			),
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
		ensureDefiniteOutcome(first);
		ensureDefiniteOutcome(retry);
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
		ensureDefiniteOutcome(result);
		requireCondition(
			result.status === "rejected" && result.code === "invalid-argument",
			"permanently malformed operation envelope was accepted",
		);
	}
	requireCondition(
		(await f.consume(f.client, "orders", "group-a")).length === 0,
		"invalid operations changed durable state",
	);
	const boundaryName = "x".repeat(f.client.limits.nameBytes);
	await committed(
		f.client.ensureTopic({ operation: f.next(), topic: boundaryName }),
	);
	await committed(
		f.client.ensureSubscription({
			operation: f.next(),
			subscription: {
				topic: "orders",
				consumerGroup: "boundary",
				deadLetterTopic: "orders-dlq",
				maxDeliveryAttempts: f.client.limits.deliveryAttempts,
				startAt: "latest",
			},
		}),
	);
	const maximumPayload = new Uint8Array(f.client.limits.payloadBytes);
	await committed(
		f.client.publish({
			operation: f.next(),
			topic: "orders",
			message: {
				id: "boundary",
				subject: "orders",
				payload: maximumPayload,
				attributes: [],
			},
		}),
	);
	const boundaryDelivery = firstDelivery(
		await committed(
			f.client.consume({
				operation: f.next(),
				topic: "orders",
				consumerGroup: "group-a",
				maxMessages: f.client.limits.batchSize,
				visibilityTimeoutMs: 1,
			}),
		),
	);
	requireCondition(
		sameBytes(boundaryDelivery.message.payload, maximumPayload),
		"payload at the limit changed",
	);
	await committed(f.client.ack(acknowledgement(f.next(), boundaryDelivery)));
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
	ensureDefiniteOutcome(rejected);
	ensureDefiniteOutcome(replay);
	requireCondition(
		rejected.status === "rejected" &&
			rejected.code === "invalid-argument" &&
			replay.status === "rejected" &&
			replay.code === rejected.code,
		"oversized nack reason was not durably rejected",
	);
	await committed(
		f.client.nack({
			...acknowledgement(f.next(), delivery),
			reason: "x".repeat(f.client.limits.reasonBytes),
		}),
	);
	const retried = firstDelivery(
		await committed(
			f.client.consume({
				operation: f.next(),
				topic: "orders",
				consumerGroup: "group-a",
				maxMessages: 1,
				visibilityTimeoutMs: f.client.limits.leaseMs,
			}),
		),
	);
	await committed(f.client.ack(acknowledgement(f.next(), retried)));
}

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
	["revoked-receipt-privacy", revokedReceipt],
	[
		"transport-throw-after-commit",
		(harness: DurableMessagingConformanceHarness) =>
			transportFailure(harness, "throw"),
	],
	[
		"transport-disconnect-after-commit",
		(harness: DurableMessagingConformanceHarness) =>
			transportFailure(harness, "disconnect"),
	],
	["operation-id-limit", independentOperationIdLimit],
	["failover", failover],
	["operation-replay", operationReplay],
	["concurrent-operations", concurrentOperations],
	["concurrent-claims", concurrentClaims],
	["pending-conflict", pendingConflict],
	["ack-expiry-race", ackExpiryRace],
	["compact-publish-race", publishCompactionRace],
	["detached-requests", detachedRequests],
	["fingerprint-fields", fingerprintFields],
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

function guardConformanceHarness(
	source: DurableMessagingConformanceHarness,
	cancelled: () => boolean,
): DurableMessagingConformanceHarness {
	const check = () => {
		if (cancelled()) throw new Error("conformance case cancelled");
	};
	const call = async <T>(fn: () => Promise<T>): Promise<T> => {
		check();
		const result = await fn();
		check();
		return result;
	};
	const guardedBarrier = async (
		fn: () => ReturnType<
			DurableMessagingConformanceHarness["holdConcurrentMutations"]
		>,
	) => {
		const barrier = await call(fn);
		return {
			reached: call(() => barrier.reached),
			release: () => call(() => barrier.release()),
		};
	};
	return {
		connect: async (tenant) => {
			const client = await call(() => source.connect(tenant));
			if (utilTypes.isProxy(client)) throw new Error("proxied provider client");
			check();
			const advertised = client.limits;
			check();
			let limits: DurableMessagingLimits;
			try {
				limits = snapshotLimits(advertised);
			} catch (error) {
				if (error instanceof InvalidProviderLimit)
					throw new DurableMessagingConformanceFailure(
						`invalid provider limit ${error.key}`,
					);
				throw error;
			}
			check();
			const mutate = async <T>(
				kind: Parameters<typeof snapshotMutation>[0],
				read: () => Promise<DurableMessagingOutcome<T>>,
			) => {
				const outcome = await call(read);
				const snapshot = snapshotMutation(kind, outcome, limits);
				check();
				return snapshot;
			};
			return {
				get limits() {
					check();
					return limits;
				},
				ensureTopic: (input) =>
					mutate("topic", () => client.ensureTopic(input)),
				ensureSubscription: (input) =>
					mutate("subscription", () => client.ensureSubscription(input)),
				publish: (input) => mutate("publish", () => client.publish(input)),
				consume: (input) => mutate("consume", () => client.consume(input)),
				ack: (input) => mutate("ack", () => client.ack(input)),
				nack: (input) => mutate("nack", () => client.nack(input)),
				compact: (input) => mutate("compact", () => client.compact(input)),
				events: async (input) => {
					const outcome = await call(() => client.events(input));
					const snapshot = snapshotAudit(outcome, limits);
					check();
					return snapshot;
				},
			};
		},
		restart: () => call(() => source.restart()),
		close: () => call(() => source.close()),
		nowMs: () => {
			check();
			const value = source.nowMs();
			check();
			return value;
		},
		advanceMs: (delta) => call(() => source.advanceMs(delta)),
		loseNextMutationResponse: (point) =>
			call(() => source.loseNextMutationResponse(point)),
		loseNextMutationTransport: (mode) =>
			call(() => source.loseNextMutationTransport(mode)),
		rejectNextDeadLetterWrite: () =>
			call(() => source.rejectNextDeadLetterWrite()),
		blockNextReceiptLookup: (reason) =>
			call(() => source.blockNextReceiptLookup(reason)),
		switchAuthority: (mode) => call(() => source.switchAuthority(mode)),
		holdNextMutation: (point) =>
			guardedBarrier(() => source.holdNextMutation(point)),
		holdConcurrentMutations: () =>
			guardedBarrier(() => source.holdConcurrentMutations()),
	};
}

export async function runDurableMessagingConformance(
	create: (
		name: DurableMessagingConformanceCase,
	) => Promise<DurableMessagingConformanceHarness>,
	options: {
		readonly caseTimeoutMs?: number;
		readonly case?: DurableMessagingConformanceCase;
	} = {},
): Promise<DurableMessagingConformanceReport> {
	const timeoutMs = options.caseTimeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
		throw new TypeError("invalid conformance case timeout");
	if (
		options.case !== undefined &&
		!DURABLE_MESSAGING_CONFORMANCE_CASES.some((name) => name === options.case)
	)
		throw new TypeError("invalid conformance case");
	const results: Array<DurableMessagingConformanceReport["cases"][number]> = [];
	let stopped = false;
	for (const [name, run] of DURABLE_CASES) {
		if (options.case !== undefined && name !== options.case) continue;
		if (stopped) {
			results.push({
				name,
				status: "unknown",
				detail: "not run after an unfenced case",
			});
			continue;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancelled = false;
		let expired = false;
		const deadline = monotonicNow() + timeoutMs;
		const deadlinePassed = () => {
			if (monotonicNow() >= deadline) expired = true;
			return expired;
		};
		const timeout = new Promise<
			DurableMessagingConformanceReport["cases"][number]
		>((resolve) => {
			timer = setTimeout(() => {
				expired = true;
				cancelled = true;
				resolve({
					name,
					status: "unknown",
					detail: "case timed out; independent host fencing is required",
				});
			}, timeoutMs);
		});
		const task = (async (): Promise<
			DurableMessagingConformanceReport["cases"][number]
		> => {
			let harness: DurableMessagingConformanceHarness;
			try {
				harness = await create(name);
			} catch {
				cancelled = true;
				return {
					name,
					status: "unknown",
					detail:
						"harness creation failed; independent host fencing is required",
				};
			}
			if (cancelled || deadlinePassed())
				return {
					name,
					status: "unknown",
					detail: "late harness requires independent host fencing",
				};
			const guarded = guardConformanceHarness(
				harness,
				() => cancelled || deadlinePassed(),
			);
			let failure: unknown;
			let failed = false;
			try {
				await run(guarded);
			} catch (error) {
				failed = true;
				failure = error;
			}
			if (cancelled || deadlinePassed())
				return {
					name,
					status: "unknown",
					detail: "timed-out harness requires independent host fencing",
				};
			cancelled = true;
			if (deadlinePassed())
				return {
					name,
					status: "unknown",
					detail: "case timed out; independent host fencing is required",
				};
			try {
				await harness.close();
			} catch {
				return {
					name,
					status: "unknown",
					detail:
						"harness teardown failed; independent host fencing is required",
				};
			}
			if (deadlinePassed())
				return {
					name,
					status: "unknown",
					detail: "case timed out; independent host fencing is required",
				};
			if (failed) {
				if (failure instanceof DurableMessagingConformanceUnverified)
					return { name, status: "unverified", detail: failure.message };
				if (!(failure instanceof DurableMessagingConformanceFailure))
					return {
						name,
						status: "unknown",
						detail:
							failure instanceof DurableMessagingConformanceUnknown
								? failure.message
								: "provider threw or returned malformed data; independent reconciliation is required",
					};
				return {
					name,
					status: "fail",
					detail: failure.message,
				};
			}
			return { name, status: "pass" };
		})();
		const result = await Promise.race([task, timeout]);
		if (timer !== undefined) clearTimeout(timer);
		results.push(result);
		if (result.status === "unknown" || result.status === "fail") stopped = true;
	}
	return {
		contract: DURABLE_MESSAGING_CONFORMANCE,
		selection: options.case ?? "all",
		executionEvidence: {
			processRestart: "unverified",
			persistedStoreIdentity: "unverified",
			faultPlacement: "unverified",
			tenantIdentity: "unverified",
			clock: "unverified",
			concurrencyBarrier: "unverified",
			authorityTransition: "unverified",
			oldOwnerFence: "unverified",
			caseIsolation: "unverified",
		},
		cases: results,
	};
}
