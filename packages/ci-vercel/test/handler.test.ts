import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createVercelRelayHandler,
	type HostedRelayApplication,
} from "../src/handler.js";
import { createNodeRelayHandler } from "../src/node-handler.js";

const secret = "a-webhook-test-secret-with-32-bytes";
const payload = '{ "action": "queued", "workflow_job": {}, "message": "é" }\n';
const lease = "01234567-89ab-4cde-8fab-0123456789ab";
const signature = (body: string) =>
	`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const webhook = (body = payload, headers: Record<string, string> = {}) =>
	new Request("https://ci.example.test/github/webhooks", {
		method: "POST",
		headers: {
			"x-hub-signature-256": signature(body),
			"x-github-event": "workflow_job",
			"x-github-delivery": "delivery-1",
			...headers,
		},
		body,
	});
function application(
	overrides: Partial<HostedRelayApplication> = {},
): HostedRelayApplication {
	return {
		ingestWebhook: async () => "accepted",
		claim: async () => Response.json({ encodedJitConfig: "dGVzdA==" }),
		control: async () => undefined,
		ready: async () => true,
		...overrides,
	};
}
const create = (app: HostedRelayApplication) =>
	createVercelRelayHandler({
		application: app,
		webhookSecret: secret,
		now: () => "2026-10-27T00:00:00Z",
	});

describe("Vercel HTTP boundary", () => {
	it("rejects mismatched and ambiguous event headers before admission", async () => {
		let admitted = 0;
		const handle = create(
			application({
				ingestWebhook: async () => {
					admitted++;
					return "accepted";
				},
			}),
		);
		const ambiguous = '{"workflow_job":{},"workflow_run":{}}';
		expect(
			(await handle(webhook(payload, { "x-github-event": "workflow_run" })))
				.status,
		).toBe(400);
		expect((await handle(webhook(ambiguous))).status).toBe(400);
		expect((await handle(webhook(payload))).status).toBe(202);
		expect(admitted).toBe(1);
	});
	it("authenticates the exact raw bytes and acknowledges only after durable commit", async () => {
		let resolve = () => {};
		const commit = new Promise<void>((done) => {
			resolve = done;
		});
		let entered = false;
		const handle = create(
			application({
				ingestWebhook: async (input) => {
					entered = true;
					expect(Buffer.from(input.rawBody).toString()).toBe(payload);
					expect(input).toMatchObject({
						deliveryId: "delivery-1",
						event: "workflow_job",
						receivedAt: "2026-10-27T00:00:00Z",
					});
					await commit;
					return "accepted";
				},
			}),
		);
		let settled = false;
		const pending = handle(webhook()).then((result) => {
			settled = true;
			return result;
		});
		await new Promise((done) => setImmediate(done));
		expect(entered).toBe(true);
		expect(settled).toBe(false);
		resolve();
		const result = await pending;
		expect(result.status).toBe(202);
		expect(await result.json()).toEqual({ status: "accepted" });
		expect(result.headers.get("cache-control")).toBe("no-store");
	});
	it("rejects invalid signatures before any application side effect", async () => {
		let calls = 0;
		const handle = create(
			application({
				ingestWebhook: async () => {
					calls++;
					return "accepted";
				},
			}),
		);
		expect(
			(
				await handle(
					webhook(payload, { "x-hub-signature-256": signature(`${payload} `) }),
				)
			).status,
		).toBe(401);
		expect(
			(
				await handle(
					webhook(payload, { "x-hub-signature-256": "sha256=broken" }),
				)
			).status,
		).toBe(401);
		expect(calls).toBe(0);
	});
	it("refuses missing delivery IDs, malformed payload size and failed storage without exposing failures", async () => {
		const handle = create(
			application({
				ingestWebhook: async () => {
					throw new Error("secret database detail");
				},
			}),
		);
		expect(
			(await handle(webhook(payload, { "x-github-delivery": "" }))).status,
		).toBe(400);
		expect(
			(await handle(webhook(payload, { "content-length": "1048577" }))).status,
		).toBe(413);
		const failure = await handle(webhook());
		expect(failure.status).toBe(503);
		expect(await failure.text()).not.toContain("secret");
	});
	it("does not treat a valid duplicate as a failed delivery", async () => {
		const result = await create(
			application({ ingestWebhook: async () => "duplicate" }),
		)(webhook());
		expect(result.status).toBe(202);
		expect(await result.json()).toEqual({ status: "duplicate" });
	});
	it("acknowledges a requeued delivery", async () => {
		const result = await create(
			application({ ingestWebhook: async () => "requeued" }),
		)(webhook());
		expect(result.status).toBe(202);
		expect(await result.json()).toEqual({ status: "requeued" });
	});
	it("ignores signed unrelated GitHub events without enqueueing them", async () => {
		let calls = 0;
		const handle = create(
			application({
				ingestWebhook: async () => {
					calls++;
					return "accepted";
				},
			}),
		);
		const result = await handle(webhook(payload, { "x-github-event": "ping" }));
		expect(result.status).toBe(202);
		expect(await result.json()).toEqual({ status: "ignored" });
		expect(calls).toBe(0);
	});
	it("requires a bearer token and returns a non-cacheable JIT response", async () => {
		const handle = create(
			application({
				claim: async (id, token) => {
					expect(id).toBe(lease);
					expect(token).toBe("identity-token");
					return Response.json({ encodedJitConfig: "dGVzdA==" });
				},
			}),
		);
		const url = `https://ci.example.test/v1/leases/${lease}/jit`;
		expect((await handle(new Request(url, { method: "POST" }))).status).toBe(
			403,
		);
		const success = await handle(
			new Request(url, {
				method: "POST",
				headers: { authorization: "Bearer identity-token" },
			}),
		);
		expect(success.headers.get("cache-control")).toBe("no-store");
		expect(await success.json()).toEqual({ encodedJitConfig: "dGVzdA==" });
	});
	it("delegates account authorization, blocks encoded separators and fails closed when unready", async () => {
		let calls = 0;
		const handle = create(
			application({
				ready: async () => false,
				control: async () => {
					calls++;
					return Response.json({ error: "unauthorized" }, { status: 401 });
				},
			}),
		);
		expect(
			(await handle(new Request("https://ci.example.test/readyz"))).status,
		).toBe(503);
		expect(
			(
				await handle(
					new Request("https://ci.example.test/v1/accounts/self/policy"),
				)
			).status,
		).toBe(401);
		expect(
			(
				await handle(
					new Request("https://ci.example.test/v2/accounts/self/policy"),
				)
			).status,
		).toBe(401);
		expect(
			(
				await handle(
					new Request("https://ci.example.test/v1/accounts/self/%2fother"),
				)
			).status,
		).toBe(404);
		expect(calls).toBe(2);
	});
	it("runs the real Node HTTP adapter without changing signature bytes", async () => {
		const observed: string[] = [];
		const handle = create(
			application({
				ingestWebhook: async ({ rawBody }) => {
					observed.push(Buffer.from(rawBody).toString());
					return "accepted";
				},
			}),
		);
		const server = createServer(
			createNodeRelayHandler({ origin: "https://ci.example.test", handle }),
		);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const { port } = z
				.object({ port: z.number().int().positive() })
				.parse(server.address());
			const result = await fetch(`http://127.0.0.1:${port}/github/webhooks`, {
				method: "POST",
				headers: {
					"x-hub-signature-256": signature(payload),
					"x-github-event": "workflow_job",
					"x-github-delivery": "delivery-1",
				},
				body: payload,
			});
			expect(result.status).toBe(202);
			expect(observed).toEqual([payload]);
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});
