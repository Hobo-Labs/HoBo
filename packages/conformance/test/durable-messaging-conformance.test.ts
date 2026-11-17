import {
	DURABLE_MESSAGING_LIMITS,
	type DurableMessaging,
	type DurableMessagingDelivery,
	type DurableMessagingEvent,
	type DurableMessagingMessage,
	type DurableMessagingOutcome,
	durableMessagingOperation,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	DURABLE_MESSAGING_CONFORMANCE_CASES,
	type DurableMessagingConformanceHarness,
	matchesDurablePublication,
	matchesDurableSettlement,
	matchesTopicAuditEvents,
	runDurableMessagingConformance,
	sameDurableDelivery,
	validDurableAuditPage,
	validUnknownEnvelope,
} from "../src/durable-messaging-conformance.js";

function inertHarness(
	connect: DurableMessagingConformanceHarness["connect"],
): DurableMessagingConformanceHarness {
	return {
		connect,
		restart: async () => {},
		close: async () => {},
		nowMs: () => 1_000,
		advanceMs: async () => {},
		loseNextMutationResponse: async () => {},
		loseNextMutationTransport: async () => {},
		rejectNextDeadLetterWrite: async () => {},
		blockNextReceiptLookup: async () => {},
		switchAuthority: async () => {},
		holdNextMutation: async () => ({
			reached: Promise.resolve(),
			release: async () => {},
		}),
		holdConcurrentMutations: async () => ({
			reached: Promise.resolve(),
			release: async () => {},
		}),
	};
}

describe("durable messaging conformance runner", () => {
	it("detects a claimed ack that redelivers after the expiry race and restart", async () => {
		let consumes = 0;
		const message = {
			id: "message-1",
			subject: "orders.created",
			payload: new Uint8Array([0, 1, 255]),
			attributes: [{ key: "content-type", value: "binary" }],
		};
		const fail = async () => {
			throw new Error("unexpected operation");
		};
		const client: DurableMessaging = {
			limits: DURABLE_MESSAGING_LIMITS,
			ensureTopic: async ({ topic }) => ({
				status: "committed",
				value: { topic },
			}),
			ensureSubscription: async ({ subscription }) => ({
				status: "committed",
				value: {
					subscription,
					firstAvailableSequence: 1,
					historyTruncated: false,
				},
			}),
			publish: async () => ({
				status: "committed",
				value: { messageId: message.id, sequence: 1 },
			}),
			consume: async ({ topic, consumerGroup }) => {
				consumes++;
				return {
					status: "committed",
					value:
						consumes === 2
							? []
							: [
									{
										topic,
										consumerGroup,
										sequence: 1,
										leaseId: consumes === 1 ? "old" : "new",
										leaseExpiresAtMs: 1_100,
										deliveryAttempt: consumes === 1 ? 1 : 2,
										message,
									},
								],
				};
			},
			ack: async ({ messageId, sequence }) => ({
				status: "committed",
				value: { messageId, sequence },
			}),
			nack: fail,
			compact: fail,
			events: fail,
		};
		const report = await runDurableMessagingConformance(
			async () => inertHarness(async () => client),
			{ case: "ack-expiry-race" },
		);
		expect(report.cases[0]?.status).toBe("fail");
		expect(consumes).toBe(3);
	});
	it.each([
		{ retention: 1, pageSize: 1, oversized: false, expected: "unverified" },
		{ retention: 4, pageSize: 1, oversized: false, expected: "pass" },
		{ retention: 4, pageSize: 4, oversized: true, expected: "fail" },
	] as const)("handles retention and page bounds without assuming full pages: $expected", async ({
		retention,
		pageSize,
		oversized,
		expected,
	}) => {
		let tail = 0;
		let events: DurableMessagingEvent[] = [];
		const unavailable = async () => {
			throw new Error("unexpected operation");
		};
		const client: DurableMessaging = {
			limits: { ...DURABLE_MESSAGING_LIMITS, retainedEvents: retention },
			ensureTopic: async ({ topic }) => {
				events.push({ sequence: ++tail, kind: "topic-created", topic });
				events = events.slice(-retention);
				return { status: "committed", value: { topic } };
			},
			ensureSubscription: unavailable,
			publish: unavailable,
			consume: unavailable,
			ack: unavailable,
			nack: unavailable,
			compact: unavailable,
			events: async ({ afterSequence, limit }) => {
				const floor = events[0]?.sequence ?? tail + 1;
				if (afterSequence < floor - 1)
					return {
						status: "gap",
						firstAvailableSequence: floor,
						latestSequence: tail,
					};
				const page = events
					.filter((event) => event.sequence > afterSequence)
					.slice(0, oversized ? pageSize : Math.min(limit, pageSize));
				const nextAfterSequence =
					page[page.length - 1]?.sequence ?? afterSequence;
				return {
					status: "ok",
					events: page,
					firstAvailableSequence: floor,
					nextAfterSequence,
					hasMore: nextAfterSequence < tail,
				};
			},
		};
		const report = await runDurableMessagingConformance(
			async () => inertHarness(async () => client),
			{ case: "audit-pagination" },
		);
		expect(report.cases[0]?.status).toBe(expected);
		expect(report.executionEvidence.persistedStoreIdentity).toBe("unverified");
	});
	it("rejects oversized audit pages and inconsistent cursors or continuation", () => {
		const event = (sequence: number) => ({
			sequence,
			kind: "topic-created" as const,
			topic: "orders",
		});
		const page = {
			status: "ok" as const,
			firstAvailableSequence: 1,
			nextAfterSequence: 2,
			hasMore: true,
			events: [event(1), event(2)],
		};
		expect(validDurableAuditPage(page, 0, 2, 4)).toBe(true);
		expect(matchesTopicAuditEvents(page.events, ["orders", "orders"])).toBe(
			true,
		);
		expect(
			matchesTopicAuditEvents([{ ...event(1), kind: "published" }], ["orders"]),
		).toBe(false);
		expect(
			matchesTopicAuditEvents([{ ...event(1), topic: "other" }], ["orders"]),
		).toBe(false);
		expect(
			validDurableAuditPage(
				{ ...page, events: [event(1)], nextAfterSequence: 1 },
				0,
				2,
				4,
			),
		).toBe(true);
		expect(
			validDurableAuditPage(
				{ ...page, events: [...page.events, event(3)], nextAfterSequence: 3 },
				0,
				2,
				4,
			),
		).toBe(false);
		expect(
			validDurableAuditPage({ ...page, nextAfterSequence: 1 }, 0, 2, 4),
		).toBe(false);
		expect(validDurableAuditPage({ ...page, hasMore: false }, 0, 2, 4)).toBe(
			false,
		);
		expect(
			validDurableAuditPage({ ...page, events: [event(1), event(3)] }, 0, 2, 4),
		).toBe(false);
	});

	it("checks every delivery and settlement identity field", () => {
		const delivery: DurableMessagingDelivery = {
			topic: "orders",
			consumerGroup: "group",
			sequence: 7,
			leaseId: "lease",
			leaseExpiresAtMs: 50,
			deliveryAttempt: 2,
			message: {
				id: "m",
				subject: "s",
				payload: new Uint8Array([1]),
				attributes: [{ key: "a", value: "b" }],
			},
			deadLetter: {
				sourceTopic: "source",
				consumerGroup: "group",
				originalMessageId: "m0",
				originalSequence: 3,
				deliveryAttempt: 2,
				cause: { kind: "nack", reason: "failed" },
			},
		};
		expect(sameDurableDelivery(delivery, structuredClone(delivery))).toBe(true);
		expect(sameDurableDelivery(delivery, { ...delivery, topic: "other" })).toBe(
			false,
		);
		expect(
			sameDurableDelivery(delivery, { ...delivery, consumerGroup: "other" }),
		).toBe(false);
		const deadLetter = delivery.deadLetter;
		if (deadLetter === undefined) throw new Error("missing test provenance");
		expect(
			sameDurableDelivery(delivery, {
				...delivery,
				deadLetter: { ...deadLetter, originalSequence: 4 },
			}),
		).toBe(false);
		expect(
			matchesDurableSettlement({ messageId: "m", sequence: 7 }, delivery),
		).toBe(true);
		expect(
			matchesDurableSettlement({ messageId: "other", sequence: 7 }, delivery),
		).toBe(false);
		expect(
			matchesDurableSettlement({ messageId: "m", sequence: 8 }, delivery),
		).toBe(false);
		for (const winner of ["other-a", "other-b"]) {
			const loser = winner === "other-a" ? "other-b" : "other-a";
			const delivered = {
				...delivery,
				message: { ...delivery.message, id: winner },
			};
			expect(
				matchesDurablePublication(
					winner,
					{ messageId: winner, sequence: 7 },
					delivered,
				),
			).toBe(true);
			expect(
				matchesDurablePublication(
					winner,
					{ messageId: loser, sequence: 7 },
					{ ...delivered, message: { ...delivered.message, id: loser } },
				),
			).toBe(false);
		}
	});

	it("rejects hidden, symbol, accessor and prototype data in unknown receipts", () => {
		const operation = durableMessagingOperation(1000, "abcdefghijklmnop");
		expect(
			validUnknownEnvelope({ status: "unknown", operation }, operation),
		).toBe(true);
		const hidden = { ...operation };
		Object.defineProperty(hidden, "payload", { value: "secret" });
		expect(
			validUnknownEnvelope({ status: "unknown", operation: hidden }, operation),
		).toBe(false);
		const symbol = { ...operation, [Symbol("payload")]: "secret" };
		expect(
			validUnknownEnvelope({ status: "unknown", operation: symbol }, operation),
		).toBe(false);
		let reads = 0;
		const accessor = {
			...operation,
			get payload() {
				reads++;
				return "secret";
			},
		};
		expect(
			validUnknownEnvelope(
				{ status: "unknown", operation: accessor },
				operation,
			),
		).toBe(false);
		expect(reads).toBe(0);
		const inherited = Object.assign(
			Object.create({ payload: "secret" }),
			operation,
		);
		expect(
			validUnknownEnvelope(
				{ status: "unknown", operation: inherited },
				operation,
			),
		).toBe(false);
	});
	it("stops after a timed-out case without trusting an in-process timer as a fence", async () => {
		let created = 0;
		const report = await runDurableMessagingConformance(
			() => {
				created++;
				return new Promise(() => {});
			},
			{ caseTimeoutMs: 5 },
		);
		expect(created).toBe(1);
		expect(report.cases[0]?.status).toBe("unknown");
		expect(
			report.cases
				.slice(1)
				.every(
					(entry) =>
						entry.status === "unknown" &&
						entry.detail === "not run after an unfenced case",
				),
		).toBe(true);
		expect(report.executionEvidence.caseIsolation).toBe("unverified");
	});

	it("does not connect a factory that resolves after its deadline", async () => {
		let resolveFactory: (value: DurableMessagingConformanceHarness) => void =
			() => {};
		let connects = 0;
		const factory = new Promise<DurableMessagingConformanceHarness>(
			(resolve) => {
				resolveFactory = resolve;
			},
		);
		const report = await runDurableMessagingConformance(() => factory, {
			caseTimeoutMs: 5,
		});
		expect(report.cases[0]?.status).toBe("unknown");
		resolveFactory(
			inertHarness(async () => {
				connects++;
				throw new Error("late connect");
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(connects).toBe(0);
	});

	it("does not dispatch another mutation after a delayed provider response", async () => {
		let resolveCall: (
			value: DurableMessagingOutcome<{ readonly topic: string }>,
		) => void = () => {};
		let calls = 0;
		const pending = new Promise<
			DurableMessagingOutcome<{ readonly topic: string }>
		>((resolve) => {
			resolveCall = resolve;
		});
		const fail = async () => {
			throw new Error("unexpected operation");
		};
		const client: DurableMessaging = {
			limits: DURABLE_MESSAGING_LIMITS,
			ensureTopic: () => {
				calls++;
				return pending;
			},
			ensureSubscription: fail,
			publish: fail,
			consume: fail,
			ack: fail,
			nack: fail,
			compact: fail,
			events: fail,
		};
		const report = await runDurableMessagingConformance(
			async () => inertHarness(async () => client),
			{ caseTimeoutMs: 5 },
		);
		expect(report.cases[0]?.status).toBe("unknown");
		resolveCall({ status: "committed", value: { topic: "orders" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toBe(1);
	});
	it("stops after failed creation because it may have spawned effects", async () => {
		let created = 0;
		const report = await runDurableMessagingConformance(async () => {
			created++;
			throw new Error("spawned then failed");
		});
		expect(created).toBe(1);
		expect(report.cases[0]).toMatchObject({
			status: "unknown",
			detail: "harness creation failed; independent host fencing is required",
		});
		expect(
			report.cases.slice(1).every(({ status }) => status === "unknown"),
		).toBe(true);
	});

	it("does not start another case when teardown fails and an effect can remain pending", async () => {
		let created = 0;
		let effect = false;
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		}).then(() => {
			effect = true;
		});
		const report = await runDurableMessagingConformance(async () => {
			created++;
			return {
				connect: async () => {
					throw new Error("failure after dispatch");
				},
				restart: async () => {},
				close: async () => {
					throw new Error("teardown failed");
				},
				nowMs: () => 1_000,
				advanceMs: async () => {},
				loseNextMutationResponse: async () => {},
				loseNextMutationTransport: async () => {},
				rejectNextDeadLetterWrite: async () => {},
				blockNextReceiptLookup: async () => {},
				switchAuthority: async () => {},
				holdNextMutation: async () => ({
					reached: Promise.resolve(),
					release: async () => {},
				}),
				holdConcurrentMutations: async () => ({
					reached: Promise.resolve(),
					release: async () => {},
				}),
			};
		});
		expect(created).toBe(1);
		expect(report.cases[0]).toMatchObject({
			status: "unknown",
			detail: "harness teardown failed; independent host fencing is required",
		});
		expect(
			report.cases.slice(1).every(({ status }) => status === "unknown"),
		).toBe(true);
		release();
		await pending;
		expect(effect).toBe(true);
	});
	it("stops after a provider failure because cleanup is not independently verified", async () => {
		let created = 0;
		let closed = 0;
		const report = await runDurableMessagingConformance(async () => {
			created++;
			return {
				connect: async () => {
					throw new Error("private-provider-diagnostic");
				},
				restart: async () => {},
				close: async () => {
					closed++;
				},
				nowMs: () => 1000,
				advanceMs: async () => {},
				loseNextMutationResponse: async () => {},
				loseNextMutationTransport: async () => {},
				rejectNextDeadLetterWrite: async () => {},
				blockNextReceiptLookup: async () => {},
				switchAuthority: async () => {},
				holdNextMutation: async () => ({
					reached: Promise.resolve(),
					release: async () => {},
				}),
				holdConcurrentMutations: async () => ({
					reached: Promise.resolve(),
					release: async () => {},
				}),
			};
		});
		const cases = report.cases;
		expect(DURABLE_MESSAGING_CONFORMANCE_CASES).toEqual([
			"group-isolation",
			"restart",
			"ack-before-commit-uncertainty",
			"ack-after-commit-uncertainty",
			"lease-expiry",
			"lease-receipt-replay",
			"dead-letter",
			"expired-lease-dead-letter",
			"dead-letter-rollback",
			"delayed-rejection",
			"expiry-boundary",
			"compaction",
			"receipt-revocation",
			"receipt-capacity",
			"receipt-unavailable",
			"revoked-receipt-privacy",
			"transport-throw-after-commit",
			"transport-disconnect-after-commit",
			"operation-id-limit",
			"failover",
			"operation-replay",
			"concurrent-operations",
			"concurrent-claims",
			"pending-conflict",
			"ack-expiry-race",
			"compact-publish-race",
			"detached-requests",
			"fingerprint-fields",
			"compact-earliest-race",
			"compact-latest-race",
			"tenant-isolation",
			"audit-pagination",
			"audit-retention",
			"topic-capacity",
			"bounds",
		]);
		expect(cases.map(({ name }) => name)).toEqual(
			DURABLE_MESSAGING_CONFORMANCE_CASES,
		);
		expect(new Set(cases.map(({ name }) => name)).size).toBe(cases.length);
		expect(cases[0]).toMatchObject({
			status: "fail",
			detail: "provider threw or returned malformed data",
		});
		expect(cases.slice(1).every((entry) => entry.status === "unknown")).toBe(
			true,
		);
		expect(closed).toBe(created);
		expect(created).toBe(1);
		expect(JSON.stringify(report)).not.toContain("private-provider-diagnostic");
	});

	it("never treats a no-op restart over one in-memory map as durability evidence", async () => {
		const report = await runDurableMessagingConformance(
			async () => {
				let message: DurableMessagingMessage | undefined;
				let acknowledged = false;
				let now = 1_000;
				const client: DurableMessaging = {
					limits: { ...DURABLE_MESSAGING_LIMITS, retainedEvents: 1 },
					ensureTopic: async ({ topic }) => ({
						status: "committed",
						value: { topic },
					}),
					ensureSubscription: async ({ subscription }) => ({
						status: "committed",
						value: {
							subscription,
							firstAvailableSequence: 1,
							historyTruncated: false,
						},
					}),
					publish: async (input) => {
						message = input.message;
						return {
							status: "committed",
							value: { messageId: input.message.id, sequence: 1 },
						};
					},
					consume: async ({ topic, consumerGroup }) => ({
						status: "committed",
						value:
							message === undefined ||
							(consumerGroup === "group-a" && acknowledged)
								? []
								: [
										{
											message,
											sequence: 1,
											topic,
											consumerGroup,
											leaseId: consumerGroup,
											leaseExpiresAtMs: now + 100,
											deliveryAttempt: 1,
										},
									],
					}),
					ack: async ({ messageId, sequence }) => {
						acknowledged = true;
						return { status: "committed", value: { messageId, sequence } };
					},
					nack: async () => ({ status: "rejected", code: "unsupported" }),
					compact: async () => ({ status: "rejected", code: "unsupported" }),
					events: async () => ({
						status: "ok",
						firstAvailableSequence: 1,
						nextAfterSequence: 1,
						hasMore: false,
						events: [
							{
								sequence: 1,
								kind: "acknowledged",
								topic: "orders",
								messageId: "message-1",
							},
						],
					}),
				};
				return {
					connect: async () => client,
					restart: async () => {},
					close: async () => {},
					nowMs: () => now,
					advanceMs: async (delta) => {
						now += delta;
					},
					loseNextMutationResponse: async () => {},
					loseNextMutationTransport: async () => {},
					rejectNextDeadLetterWrite: async () => {},
					blockNextReceiptLookup: async () => {},
					switchAuthority: async () => {},
					holdNextMutation: async () => ({
						reached: Promise.resolve(),
						release: async () => {},
					}),
					holdConcurrentMutations: async () => ({
						reached: Promise.resolve(),
						release: async () => {},
					}),
				};
			},
			{ case: "restart" },
		);
		expect(report.cases.find(({ name }) => name === "restart")?.status).toBe(
			"pass",
		);
		expect(
			Object.values(report.executionEvidence).every(
				(value) => value === "unverified",
			),
		).toBe(true);
	});
});
