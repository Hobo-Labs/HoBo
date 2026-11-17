import {
	DURABLE_MESSAGING_LIMITS,
	type DurableMessaging,
	type DurableMessagingMessage,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	DURABLE_MESSAGING_CONFORMANCE_CASES,
	runDurableMessagingConformance,
} from "../src/durable-messaging-conformance.js";

describe("durable messaging conformance runner", () => {
	it("fails every case when the provider is unavailable and closes each harness", async () => {
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
			"failover",
			"operation-replay",
			"concurrent-operations",
			"concurrent-claims",
			"ack-expiry-race",
			"compact-publish-race",
			"detached-requests",
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
		expect(cases.every((entry) => entry.status === "fail")).toBe(true);
		expect(
			cases.every(
				(entry) => entry.detail === "provider threw or returned malformed data",
			),
		).toBe(true);
		expect(closed).toBe(created);
		expect(created).toBe(cases.length);
		expect(JSON.stringify(report)).not.toContain("private-provider-diagnostic");
	});

	it("never treats a no-op restart over one in-memory map as durability evidence", async () => {
		const report = await runDurableMessagingConformance(async () => {
			let message: DurableMessagingMessage | undefined;
			let acknowledged = false;
			let now = 1_000;
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
