import type {
	HostedRelayApplication,
	VerifiedWebhook,
} from "@hobo/ci-gh-actions";
import { describe, expect, it, vi } from "vitest";
import { withWakeup } from "../src/composition.js";

const delivery: VerifiedWebhook = {
	deliveryId: "1",
	event: "workflow_job",
	rawBody: new TextEncoder().encode("{}"),
	receivedAt: "2026-01-01T00:00:00.000Z",
};

describe("durable wakeup", () => {
	it("commits before notifying and keeps accepted work recoverable when the queue is down", async () => {
		const inbox: string[] = [];
		const base: HostedRelayApplication = {
			ingestWebhook: async (input) => {
				inbox.push(input.deliveryId);
				return "accepted";
			},
			claim: async () => new Response(null, { status: 403 }),
			control: async () => undefined,
			ready: async () => true,
		};
		const notify = vi.fn(async () => {
			expect(inbox).toEqual(["1"]);
			throw new Error("queue unavailable");
		});
		const app = withWakeup(base, notify);
		expect(await app.ingestWebhook(delivery)).toBe("accepted");
		// The independent repair worker scans the durable inbox, not the queue.
		const recovered = inbox.splice(0);
		expect(recovered).toEqual(["1"]);
		expect(notify).toHaveBeenCalledOnce();
	});
	it("never sends a hint when the durable commit fails", async () => {
		const notify = vi.fn();
		const base: HostedRelayApplication = {
			ingestWebhook: async () => {
				throw new Error("database unavailable");
			},
			claim: async () => new Response(),
			control: async () => undefined,
			ready: async () => false,
		};
		await expect(
			withWakeup(base, notify).ingestWebhook(delivery),
		).rejects.toThrow();
		expect(notify).not.toHaveBeenCalled();
	});
});
