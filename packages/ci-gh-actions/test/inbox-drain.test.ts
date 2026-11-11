import { describe, expect, it, vi } from "vitest";
import {
	drainWebhookInbox,
	type InboxDrainOptions,
} from "../src/inbox-drain.js";

function makeStore(sequence: readonly string[]) {
	let index = 0;
	return {
		async claimWebhook() {
			const deliveryId = sequence[index];
			index += 1;
			if (!deliveryId) return undefined;
			return {
				deliveryId,
				event: "workflow_job",
				rawBody: Buffer.from("{}"),
				token: `token-${deliveryId}`,
			};
		},
		async ackWebhook() {
			return true;
		},
		async failWebhook() {
			return "retry" as const;
		},
	};
}

describe("drainWebhookInbox", () => {
	it("times out a hung delivery and continues within budget", async () => {
		const failed: string[] = [];
		let calls = 0;
		const options: InboxDrainOptions = {
			store: makeStore(["hang", "ok"]),
			now: () => "2026-11-11T00:00:00.000Z",
			processWebhook: async () => {
				calls += 1;
				if (calls === 1) await new Promise(() => {});
				return "ignored";
			},
			deliveryTimeoutMs: 500,
			budgetMs: 2_000,
			onDeliveryEvent: (event, fields) => {
				if (event === "hobo_ci_inbox_delivery_timed_out")
					failed.push(fields.deliveryId);
			},
		};
		const startedAt = Date.now();
		const result = await drainWebhookInbox(options);
		const elapsed = Date.now() - startedAt;
		expect(elapsed).toBeLessThan(1_000);
		expect(result.timedOut).toBeGreaterThanOrEqual(1);
		expect(failed).toContain("hang");
		expect(result.processed).toBeGreaterThanOrEqual(1);
	});

	it("stops when the per-pass budget is exhausted", async () => {
		const processWebhook = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			return "ignored";
		});
		const result = await drainWebhookInbox({
			store: makeStore(["a", "b", "c", "d", "e", "f"]),
			now: () => "2026-11-11T00:00:00.000Z",
			processWebhook,
			deliveryTimeoutMs: 500,
			budgetMs: 1_000,
			maxDeliveries: 10,
		});
		expect(result.budgetExhausted).toBe(true);
		expect(result.deliveriesMs).toBeLessThanOrEqual(1_500);
		expect(processWebhook.mock.calls.length).toBeLessThan(6);
	});
});
