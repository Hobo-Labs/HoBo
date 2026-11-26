import { createHmac } from "node:crypto";
import { bindle } from "@hobo/bindles";
import { createRelayHandler } from "@hobo/ci-gh-actions";
import { runMessagingConformance } from "@hobo/conformance";
import { parseIdempotencyKey, parseQueueName, type Queue } from "@hobo/core";
import { createTestHarness, createTopicEmulator } from "@hobo/testing";
import { describe, expect, it } from "vitest";

describe("application service emulators", () => {
	it("runs the CI relay HTTP service against a queue-backed test application", async () => {
		let queue: Queue | undefined;
		const inbox = parseQueueName("inbox");
		const secret = "a-webhook-test-secret-with-32-bytes";
		const relay = createRelayHandler({
			webhookSecret: secret,
			application: {
				async ingestWebhook(delivery) {
					if (queue === undefined) throw new Error("queue unavailable");
					const result = await queue.enqueue(
						inbox,
						{
							event: delivery.event,
							body: Buffer.from(delivery.rawBody).toString("utf8"),
						},
						{ idempotencyKey: parseIdempotencyKey(delivery.deliveryId) },
					);
					return result.deduped ? "duplicate" : "accepted";
				},
				claim: async () => new Response(null, { status: 403 }),
				control: async () => undefined,
				ready: async () => true,
			},
		});
		const definition = bindle("service-emulation-test", (b) => {
			const jobs = b.queue();
			const api = b.api(() => relay).dependsOn(jobs);
			return { jobs, api };
		});
		const harness = createTestHarness();
		const graph = await harness.deploy(definition)();
		try {
			queue = graph.queue("jobs");
			const body = '{"workflow_job":{}}';
			const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
			const request = (sig: string) =>
				fetch(`${graph.http("api").baseUrl}/github/webhooks`, {
					method: "POST",
					body,
					headers: {
						"x-hub-signature-256": sig,
						"x-github-event": "workflow_job",
						"x-github-delivery": "delivery-42",
					},
				});
			expect((await request("invalid")).status).toBe(401);
			const accepted = await request(signature);
			expect(accepted.status).toBe(202);
			expect(await accepted.json()).toEqual({ status: "accepted" });
			expect(await (await request(signature)).json()).toEqual({
				status: "duplicate",
			});
			expect(queue.dequeue(inbox).map((entry) => entry.body)).toEqual([
				{ event: "workflow_job", body },
			]);
		} finally {
			await harness.destroy(definition)();
		}
	});

	it("runs the existing Messaging conformance suite against graph-supplied ports", async () => {
		const harness = createTestHarness({
			emulators: { topic: () => createTopicEmulator({ tenantId: "conf" }) },
		});
		const definitions: ReturnType<typeof bindle>[] = [];
		try {
			const report = await runMessagingConformance(async () => {
				const definition = bindle("conformance", (b) => ({
					events: b.topic(),
				}));
				definitions.push(definition);
				return (await harness.deploy(definition)()).topic("events");
			});
			expect(report.assertions).toEqual({
				publishConsumeAck: "pass",
				consumerGroupIsolation: "pass",
				deadLetterMaxAttempts: "unsupported",
				exactlyOnceCapabilityGate: "pass",
			});
		} finally {
			await Promise.all(
				definitions.map((definition) => harness.destroy(definition)()),
			);
		}
	});
});
