import { describe, expect, it, vi } from "vitest";
import { reportQueueBinding } from "../src/entry.js";

describe("queue deployment routing", () => {
	it("logs only safe queue binding metadata, and tolerates a broken logger", () => {
		const log = vi
			.spyOn(console, "info")
			.mockImplementationOnce(() => {
				throw new Error("logging unavailable");
			})
			.mockImplementation(() => {});
		const metadata = {
			messageId: "private-message-id",
			deliveryCount: 1,
			createdAt: new Date(),
			expiresAt: new Date(),
			topicName: "hobo-ci",
			consumerGroup: "api_queue",
			region: "iad1",
		};
		try {
			reportQueueBinding({ ...metadata, consumerGroup: "invalid/path" });
			expect(log).not.toHaveBeenCalled();
			reportQueueBinding(metadata);
			reportQueueBinding(metadata);
			reportQueueBinding(metadata);
			expect(log).toHaveBeenCalledTimes(2);
			expect(log).toHaveBeenLastCalledWith(
				JSON.stringify({
					event: "hobo_ci_queue_binding",
					topic: "hobo-ci",
					consumerGroup: "api_queue",
				}),
			);
			expect(JSON.stringify(log.mock.calls)).not.toContain(
				"private-message-id",
			);
		} finally {
			log.mockRestore();
		}
	});
});
