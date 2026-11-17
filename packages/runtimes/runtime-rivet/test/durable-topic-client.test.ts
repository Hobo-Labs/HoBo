/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening -- SAFETY: these fixtures deliberately encode malformed external JSON in tests. */
import { DURABLE_MESSAGING_LIMITS } from "@hobo/core";
import { describe, expect, it, vi } from "vitest";
import {
	createRivetDurableTopicClient,
	createRivetDurableTopicMetadataGrant,
	type RivetDurableTopicClientOptions,
} from "../src/durable-topic-client.js";

const operation = Object.freeze({
	id: "v1.2000000000000.abcdefghijklmnop",
	expiresAtMs: 2_000_000_000_000,
});
const profile = Object.freeze({
	...DURABLE_MESSAGING_LIMITS,
	payloadBytes: 8192,
	attributeBytes: 2048,
	batchSize: 4,
	retainedMessages: 128,
	retainedEvents: 128,
	topics: 32,
	subscriptions: 16,
});
const actorCapabilities = Object.freeze({
	topicCreation: true,
	publish: true,
	readRetainedLog: true,
	compaction: true,
	auditEvents: true,
	consumerGroups: false,
	leases: false,
	acknowledgement: false,
	deadLetter: false,
	legacyWit: false,
});
const binding = Object.freeze({
	actorName: "hoboMessaging",
	actorKey: Object.freeze(["tenant", "orders"]),
	tenant: "tenant",
	instance: "orders",
	semanticDigest: `sha256:${"a".repeat(64)}`,
	limits: profile,
	actorCapabilities,
});
const canonical = (value: object) =>
	JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
				)
			: item,
	);

function fixture(send: (path: string, init: RequestInit) => Promise<Response>) {
	const authorize = vi.fn<RivetDurableTopicClientOptions["authorize"]>(
		async () => ({ "x-hobo-proof": "signed" }),
	);
	const revalidate = vi.fn(async () => true);
	const fetch = vi.fn(send);
	const client = createRivetDurableTopicClient({
		binding,
		metadataGrant: createRivetDurableTopicMetadataGrant(),
		verifyTransport: () => true,
		authorize,
		revalidate,
		fetch,
		timeoutMs: 500,
	});
	return { client, authorize, revalidate, fetch };
}

describe("Rivet durable topic HTTP client", () => {
	it("snapshots and signs exact canonical bytes; a lost committed acknowledgement remains unknown and retry is identical", async () => {
		const message = {
			id: "m1",
			subject: "new",
			payload: new Uint8Array([0, 1, 254, 255]),
			attributes: [{ key: "k", value: "v" }],
		};
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let attempts = 0;
		const requests: string[] = [];
		const { client, fetch, authorize } = fixture(async (path, init) => {
			expect(path).toBe("/publish");
			expect(init.method).toBe("POST");
			requests.push(String(init.body));
			if (++attempts === 1) throw new Error("reply lost after commit");
			return new Response(
				canonical({
					status: "committed",
					value: { messageId: "m1", sequence: 1 },
				}),
				{ status: 200 },
			);
		});
		authorize.mockImplementationOnce(async () => {
			await gate;
			return { "x-hobo-proof": "signed" };
		});
		const pending = client.publish({ operation, topic: "orders", message });
		message.payload[0] = 9;
		const attribute = message.attributes[0];
		if (attribute === undefined) throw new Error("missing test attribute");
		attribute.value = "changed";
		release();
		expect(await pending).toEqual({ status: "unknown", operation });
		const original = {
			id: "m1",
			subject: "new",
			payload: new Uint8Array([0, 1, 254, 255]),
			attributes: [{ key: "k", value: "v" }],
		};
		expect(
			await client.publish({ operation, topic: "orders", message: original }),
		).toEqual({ status: "committed", value: { messageId: "m1", sequence: 1 } });
		expect(requests[0]).toBe(requests[1]);
		expect(requests[0]).toContain('"payload":"AAH+/w=="');
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(authorize.mock.calls[0]?.[0]).toMatchObject({
			actorName: binding.actorName,
			actorKey: binding.actorKey,
			tenant: binding.tenant,
			instance: binding.instance,
			method: "publish",
			operation,
		});
	});

	it("fails closed on scope or receipt mismatches and never synthesizes durable rejections", async () => {
		let result: object = {
			status: "committed",
			value: { messageId: "other", sequence: 1 },
		};
		const { client, fetch } = fixture(
			async () => new Response(canonical(result), { status: 200 }),
		);
		const input = {
			operation,
			topic: "orders",
			message: {
				id: "m1",
				subject: "new",
				payload: new Uint8Array(),
				attributes: [],
			},
		};
		expect(await client.publish(input)).toEqual({
			status: "unknown",
			operation,
		});
		result = {
			status: "unknown",
			operation: { ...operation, id: "v1.2000000000000.differentnonce12" },
		};
		expect(await client.publish(input)).toEqual({
			status: "unknown",
			operation,
		});
		result = { status: "rejected", code: "unsupported" };
		expect(await client.publish(input)).toEqual({
			status: "rejected",
			code: "unsupported",
		});
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("does not disclose receipts after revocation and refuses noncanonical or oversized replies", async () => {
		let response = canonical({
			status: "committed",
			value: { topic: "orders" },
		});
		const { client, revalidate } = fixture(
			async () => new Response(response, { status: 200 }),
		);
		revalidate.mockResolvedValueOnce(false);
		expect(await client.ensureTopic({ operation, topic: "orders" })).toEqual({
			status: "unknown",
			operation,
		});
		response =
			'{"status":"committed","status":"committed","value":{"topic":"orders"}}';
		expect(await client.ensureTopic({ operation, topic: "orders" })).toEqual({
			status: "unknown",
			operation,
		});
		response = " ".repeat(262_145);
		expect(await client.ensureTopic({ operation, topic: "orders" })).toEqual({
			status: "unknown",
			operation,
		});
	});

	it("retains exact operation on invalid post-envelope input and rejects invalid envelopes", async () => {
		const { client, fetch } = fixture(async () => {
			throw new Error("must not dispatch");
		});
		expect(await client.ensureTopic({ operation, topic: "bad\nname" })).toEqual(
			{ status: "unknown", operation },
		);
		await expect(
			client.ensureTopic({
				operation: { ...operation, id: "bad" },
				topic: "orders",
			}),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("returns unavailable for failed event reads and validates cursor continuity", async () => {
		let response: object = {
			status: "ok",
			events: [],
			firstAvailableSequence: 1,
			nextAfterSequence: 1,
			hasMore: false,
		};
		const { client } = fixture(
			async () => new Response(canonical(response), { status: 200 }),
		);
		expect(await client.events({ afterSequence: 0, limit: 1 })).toEqual({
			status: "rejected",
			code: "unavailable",
		});
		response = {
			status: "ok",
			events: [{ sequence: 1, kind: "topic-created", topic: "orders" }],
			firstAvailableSequence: 1,
			nextAfterSequence: 1,
			hasMore: false,
		};
		expect(await client.events({ afterSequence: 0, limit: 1 })).toEqual(
			response,
		);
	});
	it("does not reread a mutable topic after an authorization await", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { client, authorize } = fixture(
			async () =>
				new Response(
					canonical({ status: "committed", value: { topic: "orders" } }),
					{ status: 200 },
				),
		);
		authorize.mockImplementationOnce(async () => {
			await gate;
			return { "x-hobo-proof": "signed" };
		});
		const input = { operation, topic: "orders" };
		const pending = client.ensureTopic(input);
		input.topic = "other";
		release();
		expect(await pending).toEqual({
			status: "committed",
			value: { topic: "orders" },
		});
	});

	it("refuses an unsafe limit tuple and carries maximum escaped requests and batches within the wire caps", async () => {
		const authorize = async () => ({ "x-hobo-proof": "signed" });
		const revalidate = async () => true;
		expect(() =>
			createRivetDurableTopicClient({
				binding: { ...binding, limits: DURABLE_MESSAGING_LIMITS },
				metadataGrant: createRivetDurableTopicMetadataGrant(),
				verifyTransport: () => true,
				authorize,
				revalidate,
				fetch: async () => new Response(),
			}),
		).toThrow();
		const keys = Array.from(
			{ length: profile.attributeCount },
			(_, index) => `key${index}`,
		);
		const totalKeys = keys.reduce(
			(sum, key) => sum + Buffer.byteLength(key),
			0,
		);
		const attributes = keys.map((key, index) => ({
			key,
			value:
				index === 0 ? "\u0000".repeat(profile.attributeBytes - totalKeys) : "",
		}));
		const payload = new Uint8Array(profile.payloadBytes).fill(255);
		const encodedPayload = Buffer.from(payload).toString("base64");
		const topic = "orders";
		const reason = "\u0000".repeat(profile.reasonBytes);
		const entries = Array.from({ length: profile.batchSize }, (_, index) => ({
			message: {
				id: `id${index}`,
				subject: "created",
				payload: encodedPayload,
				attributes,
			},
			sequence: index + 1,
			topic,
			consumerGroup: "workers",
			leaseId: `lease${index}`,
			leaseExpiresAtMs: 2_000_000_000_001,
			deliveryAttempt: 1,
			deadLetter: {
				sourceTopic: "source",
				consumerGroup: "workers",
				originalMessageId: `original${index}`,
				originalSequence: index + 1,
				deliveryAttempt: 1,
				cause: { kind: "nack", reason },
			},
		}));
		const response = canonical({ status: "committed", value: entries });
		expect(Buffer.byteLength(response)).toBeLessThanOrEqual(262_144);
		let requestLength = 0;
		const { client } = fixture(async (path, init) => {
			requestLength = Buffer.byteLength(String(init.body));
			return new Response(
				path === "/consume"
					? response
					: canonical({
							status: "committed",
							value: { messageId: "id0", sequence: 1 },
						}),
				{ status: 200 },
			);
		});
		expect(
			await client.publish({
				operation,
				topic,
				message: { id: "id0", subject: "created", payload, attributes },
			}),
		).toMatchObject({ status: "committed" });
		expect(requestLength).toBeLessThanOrEqual(131_072);
		const consumed = await client.consume({
			operation,
			topic,
			consumerGroup: "workers",
			maxMessages: profile.batchSize,
			visibilityTimeoutMs: 1,
		});
		if (consumed.status !== "committed")
			throw new Error("missing delivery receipt");
		expect(consumed.value).toHaveLength(profile.batchSize);
		expect(consumed.value[0]?.deadLetter?.cause).toEqual({
			kind: "nack",
			reason,
		});
		expect(
			Buffer.compare(
				consumed.value[0]?.message.payload ?? new Uint8Array(),
				payload,
			),
		).toBe(0);
	});

	it("retains capacity for timed-out calls and prevents late authorization from dispatching", async () => {
		vi.useFakeTimers();
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetch = vi.fn(
			async () =>
				new Response(
					canonical({ status: "committed", value: { topic: "orders" } }),
					{ status: 200 },
				),
		);
		const client = createRivetDurableTopicClient({
			binding,
			metadataGrant: createRivetDurableTopicMetadataGrant(),
			verifyTransport: () => true,
			authorize: async () => {
				await gate;
				return { "x-hobo-proof": "signed" };
			},
			revalidate: () => true,
			fetch,
			timeoutMs: 10,
			maxInFlight: 1,
		});
		try {
			const pending = client.ensureTopic({ operation, topic: "orders" });
			await vi.advanceTimersByTimeAsync(10);
			expect(await pending).toEqual({ status: "unknown", operation });
			expect(await client.ensureTopic({ operation, topic: "orders" })).toEqual({
				status: "unknown",
				operation,
			});
			release();
			await vi.runAllTimersAsync();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			release();
			vi.useRealTimers();
		}
	});

	it("rejects noncanonical payloads, duplicate leases and contradictory event pages", async () => {
		let value: object = {
			status: "committed",
			value: [
				{
					message: {
						id: "m1",
						subject: "new",
						payload: "AB==",
						attributes: [],
					},
					sequence: 1,
					topic: "orders",
					consumerGroup: "workers",
					leaseId: "lease",
					leaseExpiresAtMs: 2_000_000_000_001,
					deliveryAttempt: 1,
				},
			],
		};
		const { client } = fixture(
			async () => new Response(canonical(value), { status: 200 }),
		);
		const input = {
			operation,
			topic: "orders",
			consumerGroup: "workers",
			maxMessages: 2,
			visibilityTimeoutMs: 1,
		};
		expect(await client.consume(input)).toEqual({
			status: "unknown",
			operation,
		});
		const delivery = {
			message: { id: "m1", subject: "new", payload: "AA==", attributes: [] },
			sequence: 1,
			topic: "orders",
			consumerGroup: "workers",
			leaseId: "lease",
			leaseExpiresAtMs: 2_000_000_000_001,
			deliveryAttempt: 1,
		};
		value = {
			status: "committed",
			value: [
				delivery,
				{
					...delivery,
					message: { ...delivery.message, id: "m2" },
					sequence: 2,
				},
			],
		};
		expect(await client.consume(input)).toEqual({
			status: "unknown",
			operation,
		});
		value = { status: "gap", firstAvailableSequence: 2, latestSequence: 1 };
		expect(await client.events({ afterSequence: 1, limit: 1 })).toEqual({
			status: "rejected",
			code: "unavailable",
		});
	});
	it("permanently revokes metadata on old clients across fresh A-to-B-to-A grants", async () => {
		const oldGrant = createRivetDurableTopicMetadataGrant();
		const newGrant = createRivetDurableTopicMetadataGrant();
		const finalGrant = createRivetDurableTopicMetadataGrant();
		const fetch = vi.fn(async () => new Response());
		const make = (metadataGrant: typeof oldGrant, eventPageSize: number) =>
			createRivetDurableTopicClient({
				binding: { ...binding, limits: { ...profile, eventPageSize } },
				metadataGrant,
				verifyTransport: () => true,
				authorize: () => {
					throw new Error("revoked");
				},
				revalidate: () => false,
				fetch,
			});
		const oldA = make(oldGrant, 1);
		expect(oldA.limits.eventPageSize).toBe(1);
		expect(oldA.actorCapabilities.consumerGroups).toBe(false);
		expect(oldA.actorCapabilities.leases).toBe(false);
		oldGrant.revoke();
		const b = make(newGrant, 2);
		expect(b.limits.eventPageSize).toBe(2);
		newGrant.revoke();
		const freshA = make(finalGrant, 1);
		expect(freshA.limits.eventPageSize).toBe(1);
		expect(() => oldA.limits).toThrow("rivet_topic.metadata_revoked");
		expect(() => oldA.actorCapabilities).toThrow(
			"rivet_topic.metadata_revoked",
		);
		expect(() => b.limits).toThrow("rivet_topic.metadata_revoked");
		for (const client of [oldA, b, freshA])
			for (const limit of [1, 2])
				expect(await client.events({ afterSequence: 0, limit })).toEqual({
					status: "rejected",
					code: "unavailable",
				});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("cancels a stalled response when its monotonic deadline expires", async () => {
		vi.useFakeTimers();
		let cancellations = 0;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				cancellations++;
			},
		});
		const client = createRivetDurableTopicClient({
			binding,
			metadataGrant: createRivetDurableTopicMetadataGrant(),
			verifyTransport: () => true,
			authorize: () => ({ "x-hobo-proof": "signed" }),
			revalidate: () => true,
			fetch: async () => new Response(stream),
			timeoutMs: 10,
			maxInFlight: 1,
		});
		try {
			const pending = client.ensureTopic({ operation, topic: "orders" });
			await vi.advanceTimersByTimeAsync(10);
			expect(await pending).toEqual({ status: "unknown", operation });
			await vi.runAllTimersAsync();
			expect(cancellations).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels oversized chunks and a bounded flood of empty chunks", async () => {
		for (const flood of [false, true]) {
			let pulls = 0;
			let cancellations = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls++;
					controller.enqueue(new Uint8Array(flood ? 0 : 262_145));
				},
				cancel() {
					cancellations++;
				},
			});
			const { client } = fixture(async () => new Response(stream));
			expect(await client.ensureTopic({ operation, topic: "orders" })).toEqual({
				status: "unknown",
				operation,
			});
			expect(cancellations).toBe(1);
			expect(pulls).toBeLessThanOrEqual(4098);
		}
	});

	it("cancels a response that arrives after timeout and retains the slot until it drains", async () => {
		vi.useFakeTimers();
		let release: (value: Response) => void = () => {};
		let cancellations = 0;
		const delayed = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const fetch = vi.fn(() => delayed);
		const client = createRivetDurableTopicClient({
			binding,
			metadataGrant: createRivetDurableTopicMetadataGrant(),
			verifyTransport: () => true,
			authorize: () => ({ "x-hobo-proof": "signed" }),
			revalidate: () => true,
			fetch,
			timeoutMs: 10,
			maxInFlight: 1,
		});
		try {
			const pending = client.ensureTopic({ operation, topic: "orders" });
			await vi.advanceTimersByTimeAsync(10);
			expect(await pending).toEqual({ status: "unknown", operation });
			expect(await client.ensureTopic({ operation, topic: "orders" })).toEqual({
				status: "unknown",
				operation,
			});
			release(
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancellations++;
						},
					}),
				),
			);
			await vi.runAllTimersAsync();
			expect(cancellations).toBe(1);
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
	it("rechecks metadata revocation after response authorization before returning audit data", async () => {
		const grant = createRivetDurableTopicMetadataGrant();
		const client = createRivetDurableTopicClient({
			binding,
			metadataGrant: grant,
			verifyTransport: () => true,
			authorize: () => ({ "x-hobo-proof": "signed" }),
			revalidate: () => {
				queueMicrotask(() => queueMicrotask(() => grant.revoke()));
				return true;
			},
			fetch: async () =>
				new Response(
					canonical({
						status: "ok",
						events: [],
						firstAvailableSequence: 1,
						nextAfterSequence: 0,
						hasMore: false,
					}),
				),
		});
		expect(await client.events({ afterSequence: 0, limit: 1 })).toEqual({
			status: "rejected",
			code: "unavailable",
		});
	});
	it("round-trips subscription, settlement and compaction receipts against their exact requests", async () => {
		const subscription = {
			topic: "orders",
			consumerGroup: "workers",
			deadLetterTopic: "orders-dlq",
			maxDeliveryAttempts: 3,
			startAt: "earliest" as const,
		};
		const seen: string[] = [];
		const { client, authorize } = fixture(async (path, init) => {
			seen.push(path);
			const header = new Headers(init.headers);
			expect(header.get("content-type")).toBe("application/json");
			expect(header.get("x-hobo-proof")).toBe("signed");
			expect(init.redirect).toBe("error");
			let value: object;
			if (path === "/ensure-subscription")
				value = {
					subscription,
					firstAvailableSequence: 1,
					historyTruncated: false,
				};
			else if (path === "/ack") value = { messageId: "m1", sequence: 1 };
			else if (path === "/nack")
				value = {
					messageId: "m1",
					sequence: 1,
					disposition: "dead-lettered",
					deadLetterMessageId: "d1",
					deadLetterSequence: 2,
				};
			else
				value = {
					topic: "orders",
					firstAvailableSequence: 2,
					removedMessages: 1,
				};
			return new Response(canonical({ status: "committed", value }), {
				status: 200,
			});
		});
		expect(
			await client.ensureSubscription({ operation, subscription }),
		).toMatchObject({ status: "committed", value: { subscription } });
		const lease = {
			operation,
			topic: "orders",
			consumerGroup: "workers",
			messageId: "m1",
			sequence: 1,
			leaseId: "lease",
		};
		expect(await client.ack(lease)).toEqual({
			status: "committed",
			value: { messageId: "m1", sequence: 1 },
		});
		expect(await client.nack({ ...lease, reason: "two\nlines" })).toMatchObject(
			{
				status: "committed",
				value: { disposition: "dead-lettered", deadLetterMessageId: "d1" },
			},
		);
		expect(
			await client.compact({ operation, topic: "orders", throughSequence: 1 }),
		).toEqual({
			status: "committed",
			value: { topic: "orders", firstAvailableSequence: 2, removedMessages: 1 },
		});
		expect(seen).toEqual(["/ensure-subscription", "/ack", "/nack", "/compact"]);
		expect(authorize).toHaveBeenCalledTimes(4);
		const claim = authorize.mock.calls[0]?.[0];
		expect(claim?.limits).toEqual(profile);
		expect(Object.isFrozen(claim?.limits)).toBe(true);
	});
	it("rejects invalid or oversized lease identifiers in both requests and receipts", async () => {
		let id = "lease";
		const { client, fetch } = fixture(
			async () =>
				new Response(
					canonical({
						status: "committed",
						value: [
							{
								message: {
									id: "m1",
									subject: "new",
									payload: "AA==",
									attributes: [],
								},
								sequence: 1,
								topic: "orders",
								consumerGroup: "workers",
								leaseId: id,
								leaseExpiresAtMs: 2_000_000_000_001,
								deliveryAttempt: 1,
							},
						],
					}),
					{ status: 200 },
				),
		);
		const consume = {
			operation,
			topic: "orders",
			consumerGroup: "workers",
			maxMessages: 1,
			visibilityTimeoutMs: 1,
		};
		const settlement = {
			operation,
			topic: "orders",
			consumerGroup: "workers",
			messageId: "m1",
			sequence: 1,
			leaseId: "",
		};
		for (const invalidId of [
			"",
			"bad\nlease",
			"x".repeat(profile.nameBytes + 1),
			"\ud800",
		]) {
			id = invalidId;
			expect(await client.consume(consume)).toEqual({
				status: "unknown",
				operation,
			});
			expect(await client.ack({ ...settlement, leaseId: invalidId })).toEqual({
				status: "unknown",
				operation,
			});
		}
		expect(fetch).toHaveBeenCalledTimes(4);
	});
	it("accepts exactly the documented maximum number of response chunks", async () => {
		let index = 0;
		const body = new TextEncoder().encode(
			canonical({ status: "committed", value: { topic: "orders" } }),
		);
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (index++ < 4095) controller.enqueue(new Uint8Array());
				else if (index === 4096) controller.enqueue(body);
				else controller.close();
			},
		});
		const { client } = fixture(async () => new Response(stream));
		expect(await client.ensureTopic({ operation, topic: "orders" })).toEqual({
			status: "committed",
			value: { topic: "orders" },
		});
	});
	it("requires verified ingress and exact actor transport before dispatch and disclosure", async () => {
		let deniedPhase: "dispatch" | "disclose" = "dispatch";
		const fetch = vi.fn(
			async () =>
				new Response(
					canonical({ status: "committed", value: { topic: "orders" } }),
					{ status: 200 },
				),
		);
		const authorize = vi.fn(() => ({ "x-hobo-proof": "signed" }));
		const verifyTransport = vi.fn<
			RivetDurableTopicClientOptions["verifyTransport"]
		>(
			(claim) =>
				claim.phase !== deniedPhase &&
				claim.fetch === fetch &&
				claim.maxChunkBytes === 262_144 &&
				claim.maxResponseBytes === 262_144 &&
				claim.maxRequestBytes === 131_072 &&
				claim.maxResponseChunks === 4096 &&
				claim.binding.actorKey[0] === "tenant",
		);
		const client = createRivetDurableTopicClient({
			binding,
			metadataGrant: createRivetDurableTopicMetadataGrant(),
			verifyTransport,
			authorize,
			revalidate: () => true,
			fetch,
		});
		expect(await client.ensureTopic({ operation, topic: "orders" })).toEqual({
			status: "unknown",
			operation,
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(authorize).not.toHaveBeenCalled();
		deniedPhase = "disclose";
		expect(await client.ensureTopic({ operation, topic: "orders" })).toEqual({
			status: "unknown",
			operation,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(verifyTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "disclose",
				responseBase64: expect.any(String),
			}),
		);
	});
	it("uses UTF-8 byte limits for multibyte and astral lease IDs", async () => {
		const { client, fetch } = fixture(
			async () =>
				new Response(
					canonical({
						status: "committed",
						value: { messageId: "m1", sequence: 1 },
					}),
					{ status: 200 },
				),
		);
		const request = {
			operation,
			topic: "orders",
			consumerGroup: "workers",
			messageId: "m1",
			sequence: 1,
		};
		for (const leaseId of ["é".repeat(64), "😀".repeat(32)])
			expect(await client.ack({ ...request, leaseId })).toEqual({
				status: "committed",
				value: { messageId: "m1", sequence: 1 },
			});
		for (const leaseId of ["é".repeat(65), "😀".repeat(33)])
			expect(await client.ack({ ...request, leaseId })).toEqual({
				status: "unknown",
				operation,
			});
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
