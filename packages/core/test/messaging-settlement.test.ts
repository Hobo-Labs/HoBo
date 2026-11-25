import { describe, expect, it } from "vitest";
import {
	parseMessagingLeaseId,
	parseMessagingMessageId,
} from "../src/ports/messaging.js";
import {
	createMessagingSettlementTracker,
	MESSAGING_SETTLEMENT_LIMIT,
} from "../src/ports/messaging-settlement.js";

const message = parseMessagingMessageId("message");
const lease = parseMessagingLeaseId("lease");

describe("messaging settlement", () => {
	it.each([
		0,
		-1,
		1.5,
		30_001,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects an invalid timeout %s", (timeout) => {
		expect(() => createMessagingSettlementTracker(timeout)).toThrow(RangeError);
	});

	it("rejects overlapping settlements and releases capacity after success", async () => {
		const tracker = createMessagingSettlementTracker();
		tracker.register([
			{ messageId: message, leaseId: lease, scope: "scope", context: "scope" },
		]);
		let finish: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const first = tracker.settle(message, lease, "ack", () => gate);
		await expect(
			tracker.settle(message, lease, "nack", async () => {}),
		).rejects.toMatchObject({ code: "MESSAGING_SETTLEMENT_PENDING" });
		finish();
		await expect(first).resolves.toBe("scope");
		expect(tracker.capacity()).toBe(MESSAGING_SETTLEMENT_LIMIT);
		await expect(
			tracker.settle(message, lease, "ack", async () => {}),
		).rejects.toMatchObject({ code: "MESSAGING_DELIVERY" });
	});

	it("quarantines timeouts and does not dispatch a second settlement", async () => {
		const tracker = createMessagingSettlementTracker(5);
		tracker.register([
			{ messageId: message, leaseId: lease, scope: "scope", context: "scope" },
		]);
		let calls = 0;
		await expect(
			tracker.settle(message, lease, "ack", async () => {
				calls++;
				await new Promise<void>(() => {});
			}),
		).rejects.toMatchObject({
			code: "MESSAGING_SETTLEMENT_UNKNOWN",
			operation: "ack",
		});
		await expect(
			tracker.settle(message, lease, "nack", async () => {
				calls++;
			}),
		).rejects.toMatchObject({
			code: "MESSAGING_SETTLEMENT_UNKNOWN",
			operation: "ack",
		});
		expect(calls).toBe(1);
		expect(tracker.capacity()).toBe(MESSAGING_SETTLEMENT_LIMIT - 1);
	});

	it("atomically refuses duplicate or excessive registrations", () => {
		const tracker = createMessagingSettlementTracker();
		const claim = {
			messageId: message,
			leaseId: lease,
			scope: "scope",
			context: "scope",
		};
		expect(() => tracker.register([claim, claim])).toThrow(/duplicate/);
		expect(tracker.capacity()).toBe(MESSAGING_SETTLEMENT_LIMIT);
		const claims = Array.from(
			{ length: MESSAGING_SETTLEMENT_LIMIT + 1 },
			(_, index) => ({
				messageId: parseMessagingMessageId(`m-${index}`),
				leaseId: lease,
				scope: `scope-${index}`,
				context: "scope",
			}),
		);
		expect(() => tracker.register(claims)).toThrow(/capacity/);
		expect(tracker.capacity()).toBe(MESSAGING_SETTLEMENT_LIMIT);
	});

	it("fences an earlier lease when the same scoped message is redelivered", async () => {
		const tracker = createMessagingSettlementTracker();
		const later = parseMessagingLeaseId("later");
		const other = parseMessagingLeaseId("other");
		tracker.register([
			{
				messageId: message,
				leaseId: lease,
				scope: "group-a",
				context: "first",
			},
			{
				messageId: message,
				leaseId: other,
				scope: "group-b",
				context: "independent",
			},
		]);
		tracker.register([
			{
				messageId: message,
				leaseId: later,
				scope: "group-a",
				context: "second",
			},
		]);
		await expect(
			tracker.settle(message, lease, "ack", async () => {}),
		).rejects.toMatchObject({ code: "MESSAGING_DELIVERY" });
		await expect(
			tracker.settle(message, later, "ack", async () => {}),
		).resolves.toBe("second");
		await expect(
			tracker.settle(message, other, "ack", async () => {}),
		).resolves.toBe("independent");
	});

	it("refuses redelivery while the previous outcome is unresolved", async () => {
		const tracker = createMessagingSettlementTracker(5);
		tracker.register([
			{
				messageId: message,
				leaseId: lease,
				scope: "group-a",
				context: "first",
			},
		]);
		const pending = tracker.settle(
			message,
			lease,
			"ack",
			() => new Promise<void>(() => {}),
		);
		const later = {
			messageId: message,
			leaseId: parseMessagingLeaseId("later"),
			scope: "group-a",
			context: "second",
		};
		expect(() => tracker.register([later])).toThrowError(
			expect.objectContaining({ code: "MESSAGING_SETTLEMENT_PENDING" }),
		);
		await expect(pending).rejects.toMatchObject({
			code: "MESSAGING_SETTLEMENT_UNKNOWN",
		});
		expect(() => tracker.register([later])).toThrowError(
			expect.objectContaining({ code: "MESSAGING_SETTLEMENT_UNKNOWN" }),
		);
	});
});
