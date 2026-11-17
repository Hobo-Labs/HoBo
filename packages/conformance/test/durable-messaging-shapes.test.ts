import { runInNewContext } from "node:vm";
import {
	DURABLE_MESSAGING_LIMITS,
	durableMessagingOperation,
	type DurableMessagingOutcome,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	snapshotAudit,
	snapshotLimits,
	snapshotMutation,
} from "../src/durable-messaging-shapes.js";
import { validUnknownEnvelope } from "../src/durable-messaging-conformance.js";

const limits = snapshotLimits(DURABLE_MESSAGING_LIMITS);
const message = () => ({
	id: "message",
	subject: "orders",
	payload: new Uint8Array([0, 1, 255]),
	attributes: [{ key: "content-type", value: "binary" }],
});
const delivery = () => ({
	message: message(),
	sequence: 1,
	topic: "orders",
	consumerGroup: "group",
	leaseId: "lease",
	leaseExpiresAtMs: 100,
	deliveryAttempt: 1,
});
const subscription = {
	topic: "orders",
	consumerGroup: "group",
	deadLetterTopic: "dead",
	maxDeliveryAttempts: 3,
	startAt: "earliest" as const,
};
// SAFETY: test fixtures deliberately include unparsed provider values.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: this constructs malformed boundary fixtures.
const input = (value: unknown): DurableMessagingOutcome<unknown> => ({
	status: "committed",
	value,
});

describe("durable messaging conformance response snapshots", () => {
	it.each([
		["topic", { topic: "orders" }],
		[
			"subscription",
			{ subscription, firstAvailableSequence: 1, historyTruncated: false },
		],
		["publish", { messageId: "message", sequence: 1 }],
		["consume", [delivery()]],
		["ack", { messageId: "message", sequence: 1 }],
		["nack", { messageId: "message", sequence: 1, disposition: "released" }],
		[
			"nack",
			{
				messageId: "message",
				sequence: 1,
				disposition: "dead-lettered",
				deadLetterMessageId: "dead-message",
				deadLetterSequence: 2,
			},
		],
		[
			"compact",
			{ topic: "orders", firstAvailableSequence: 2, removedMessages: 1 },
		],
	] as const)("preserves a well-formed %s receipt", (kind, value) => {
		expect(snapshotMutation(kind, input(value), limits)).toEqual(input(value));
	});

	it.each([
		["topic", { topic: 3 }],
		[
			"subscription",
			{ subscription, firstAvailableSequence: "1", historyTruncated: false },
		],
		["publish", { messageId: "message", sequence: "1" }],
		["consume", [{ ...delivery(), leaseExpiresAtMs: "100" }]],
		["ack", { messageId: "message", sequence: Number.NaN }],
		["nack", { messageId: "message", sequence: 1, disposition: "other" }],
		["compact", { topic: "orders", firstAvailableSequence: 2 }],
	] as const)("rejects a malformed %s receipt", (kind, value) => {
		expect(snapshotMutation(kind, input(value), limits)).toEqual({
			status: "unknown",
			value: true,
		});
	});

	it("detaches nested messages, attributes and bytes", () => {
		const original = delivery();
		const result = snapshotMutation("consume", input([original]), limits);
		original.message.payload[0] = 9;
		original.message.attributes[0]!.value = "changed";
		expect(result).toMatchObject({
			status: "committed",
			value: [
				{
					message: {
						payload: new Uint8Array([0, 1, 255]),
						attributes: [{ value: "binary" }],
					},
				},
			],
		});
	});

	it("bounds arrays before reading entries and does not execute accessors", () => {
		let reads = 0;
		const oversized: unknown[] = [];
		oversized.length = limits.batchSize + 1;
		Object.defineProperty(oversized, "0", {
			get() {
				reads++;
				return delivery();
			},
		});
		expect(() =>
			snapshotMutation("consume", input(oversized), limits),
		).toThrow();
		const sparse: unknown[] = [];
		sparse.length = 1;
		expect(() => snapshotMutation("consume", input(sparse), limits)).toThrow();
		const malformed = { ...delivery() };
		Object.defineProperty(malformed, "sequence", {
			get() {
				reads++;
				return 1;
			},
		});
		expect(snapshotMutation("consume", input([malformed]), limits)).toEqual({
			status: "unknown",
			value: true,
		});
		expect(reads).toBe(0);
	});

	it("uses the provider's actual payload, attribute and lease bounds", () => {
		const small = snapshotLimits({
			...limits,
			nameBytes: 7,
			payloadBytes: 2,
			attributeBytes: 8,
		});
		const tooLarge = {
			...delivery(),
			message: {
				...message(),
				id: "m",
				payload: new Uint8Array(3),
				attributes: [],
			},
		};
		expect(snapshotMutation("consume", input([tooLarge]), small)).toEqual({
			status: "unknown",
			value: true,
		});
		const longLease = {
			...delivery(),
			leaseId: "😀😀",
			message: {
				...message(),
				id: "m",
				payload: new Uint8Array(2),
				attributes: [],
			},
		};
		expect(snapshotMutation("consume", input([longLease]), small)).toEqual({
			status: "unknown",
			value: true,
		});
		const validLease = { ...longLease, leaseId: "éé" };
		expect(
			snapshotMutation("consume", input([validLease]), small),
		).toMatchObject({ status: "committed" });
	});

	it("detaches unknown and expired identities before later checks", () => {
		for (const status of ["unknown", "expired"] as const) {
			const operation = {
				...durableMessagingOperation(1_000, "abcdefghijklmnop"),
			};
			const outcome = { status, operation };
			const snapshot = snapshotMutation("publish", outcome, limits);
			operation.expiresAtMs = 5;
			expect(snapshot).toEqual({
				status,
				operation: durableMessagingOperation(1_000, "abcdefghijklmnop"),
			});
			expect(snapshot).not.toBe(outcome);
		}
	});

	it("retains disclosure evidence on a rejected receipt", () => {
		const disclosed = {
			status: "rejected" as const,
			code: "unauthorized" as const,
			value: { payload: "secret" },
		};
		expect(snapshotMutation("consume", disclosed, limits)).toMatchObject({
			status: "unknown",
			value: true,
		});
	});

	it("preserves nested disclosure evidence without retaining the source object", () => {
		const operation = {
			...durableMessagingOperation(1_000, "abcdefghijklmnop"),
			payload: { secret: "original" },
		};
		const snapshot = snapshotMutation(
			"consume",
			{ status: "unknown", operation },
			limits,
		);
		operation.payload.secret = "changed";
		expect(snapshot).toEqual({ status: "unknown", value: true });
	});

	it("rejects proxies without invoking their reflection traps", () => {
		let traps = 0;
		const handler = {
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("trap");
			},
			getPrototypeOf() {
				traps++;
				throw new Error("trap");
			},
			ownKeys() {
				traps++;
				throw new Error("trap");
			},
			get() {
				traps++;
				throw new Error("trap");
			},
		};
		const operation = {
			...durableMessagingOperation(1_000, "abcdefghijklmnop"),
		};
		const outcome = { status: "unknown" as const, operation };
		const proxyOutcome = new Proxy(outcome, handler);
		expect(() => snapshotMutation("publish", proxyOutcome, limits)).toThrow();
		expect(validUnknownEnvelope(proxyOutcome, operation)).toBe(false);
		const proxyOperation = {
			status: "unknown" as const,
			operation: new Proxy(operation, handler),
		};
		expect(() => snapshotMutation("publish", proxyOperation, limits)).toThrow();
		expect(validUnknownEnvelope(proxyOperation, operation)).toBe(false);
		const proxyExpiry = {
			status: "expired" as const,
			operation: new Proxy(operation, handler),
		};
		expect(() => snapshotMutation("publish", proxyExpiry, limits)).toThrow();
		const revoked = Proxy.revocable(outcome, handler);
		revoked.revoke();
		expect(() => snapshotMutation("publish", revoked.proxy, limits)).toThrow();
		expect(validUnknownEnvelope(revoked.proxy, operation)).toBe(false);
		expect(() =>
			snapshotLimits(new Proxy(DURABLE_MESSAGING_LIMITS, handler)),
		).toThrow();
		expect(() =>
			snapshotMutation(
				"consume",
				input(new Proxy([delivery()], handler)),
				limits,
			),
		).toThrow();
		expect(() =>
			snapshotMutation(
				"consume",
				input([new Proxy(delivery(), handler)]),
				limits,
			),
		).toThrow();
		const proxyPayload = {
			...delivery(),
			message: { ...message(), payload: new Proxy(new Uint8Array(1), handler) },
		};
		expect(() =>
			snapshotMutation("consume", input([proxyPayload]), limits),
		).toThrow();
		const page = {
			status: "ok" as const,
			events: [
				new Proxy(
					{ sequence: 1, kind: "topic-created" as const, topic: "orders" },
					handler,
				),
			],
			firstAvailableSequence: 1,
			nextAfterSequence: 1,
			hasMore: false,
		};
		expect(() => snapshotAudit(page, limits)).toThrow();
		expect(traps).toBe(0);
	});

	it("refuses shared payloads that cannot be snapshotted atomically", () => {
		const shared = new Uint8Array(new SharedArrayBuffer(2));
		const source = {
			...delivery(),
			message: { ...message(), payload: shared },
		};
		expect(snapshotMutation("consume", input([source]), limits)).toEqual({
			status: "unknown",
			value: true,
		});
		const otherRealm: unknown = runInNewContext(
			"new Uint8Array(new SharedArrayBuffer(2))",
		);
		const sharedElsewhere = {
			...delivery(),
			message: { ...message(), payload: otherRealm },
		};
		expect(
			snapshotMutation("consume", input([sharedElsewhere]), limits),
		).toEqual({ status: "unknown", value: true });
		const ordinary: unknown = runInNewContext("new Uint8Array([0, 1, 255])");
		const ordinaryElsewhere = {
			...delivery(),
			message: { ...message(), payload: ordinary },
		};
		expect(
			snapshotMutation("consume", input([ordinaryElsewhere]), limits),
		).toMatchObject({ status: "committed" });
	});

	it("validates and detaches dead-letter provenance and causes", () => {
		const source = {
			...delivery(),
			deadLetter: {
				sourceTopic: "orders",
				consumerGroup: "group",
				originalMessageId: "original",
				originalSequence: 4,
				deliveryAttempt: 3,
				cause: { kind: "nack", reason: "retry" },
			},
		};
		const snapshot = snapshotMutation("consume", input([source]), limits);
		source.deadLetter.cause.reason = "changed";
		expect(snapshot).toMatchObject({
			status: "committed",
			value: [{ deadLetter: { cause: { kind: "nack", reason: "retry" } } }],
		});
		const malformed = {
			...source,
			deadLetter: { ...source.deadLetter, cause: { kind: "nack" } },
		};
		expect(snapshotMutation("consume", input([malformed]), limits)).toEqual({
			status: "unknown",
			value: true,
		});
	});

	it("rejects malformed nested audit events while preserving valid pages", () => {
		const page = {
			status: "ok" as const,
			events: [
				{ sequence: 1, kind: "topic-created" as const, topic: "orders" },
			],
			firstAvailableSequence: 1,
			nextAfterSequence: 1,
			hasMore: false,
		};
		expect(snapshotAudit(page, limits)).toEqual(page);
		for (const changed of [
			{ ...page.events[0], sequence: "1" },
			{ ...page.events[0], kind: "unrecognized" },
			{ ...page.events[0], topic: 1 },
		]) {
			const malformed = { ...page, events: [changed] };
			// SAFETY: these values deliberately cross the untyped provider boundary.
			expect(() => snapshotAudit(malformed as never, limits)).toThrow();
		}
	});

	it("requires finite, advertised limits before processing a response", () => {
		for (const invalid of [0, 129, Number.NaN, Number.MAX_SAFE_INTEGER]) {
			expect(() => snapshotLimits({ ...limits, nameBytes: invalid })).toThrow();
		}
	});
});
