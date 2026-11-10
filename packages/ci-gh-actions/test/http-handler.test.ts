import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createRelayHandler,
	type HostedRelayApplication,
} from "../src/http-handler.js";
import { signIngressForward } from "../src/ingress-forward.js";
import { createNodeRelayHandler } from "../src/node-http.js";
import {
	signWebhookBody,
	verifyWebhookSignature,
} from "../src/webhook-signature.js";

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
	createRelayHandler({
		application: app,
		webhookSecret: secret,
		now: () => "2026-10-27T00:00:00Z",
	});

describe("relay HTTP boundary", () => {
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
	it("serves the same routes under the engine mount and reports every engine's health", async () => {
		const seen: string[] = [];
		let vercelReady = false;
		const handle = createRelayHandler({
			application: application({
				control: async (request) => {
					seen.push(
						`${request.method} ${new URL(request.url).pathname} ${await request.text()}`,
					);
					return new Response(null, { status: 204 });
				},
			}),
			webhookSecret: secret,
			stubEngines: { vercel: { ready: () => vercelReady } },
		});
		const get = (path: string) =>
			handle(new Request(`https://ci.example.test${path}`));
		for (const path of ["/healthz", "/engines/gh-actions/healthz"]) {
			const health = await get(path);
			expect(health.status).toBe(200);
			expect(await health.json()).toEqual({
				ok: true,
				engines: { "gh-actions": { ok: true }, vercel: { ok: true } },
			});
		}
		for (const path of ["/readyz", "/engines/gh-actions/readyz"]) {
			const unready = await get(path);
			expect(unready.status).toBe(503);
			expect(await unready.json()).toEqual({
				ready: false,
				engines: { "gh-actions": { ready: true }, vercel: { ready: false } },
			});
		}
		const stub = await get("/engines/vercel/readyz");
		expect(stub.status).toBe(503);
		expect(await stub.json()).toEqual({ ready: false, engine: "vercel" });
		vercelReady = true;
		expect((await get("/readyz")).status).toBe(200);
		expect(await (await get("/engines/vercel/readyz")).json()).toEqual({
			ready: true,
			engine: "vercel",
		});
		expect(await (await get("/engines/vercel/healthz")).json()).toEqual({
			ok: true,
			engine: "vercel",
		});
		// A stub engine serves health only; an unknown engine serves nothing.
		expect((await get("/engines/vercel/github/webhooks")).status).toBe(404);
		expect((await get("/engines/other/healthz")).status).toBe(404);
		const mounted = await handle(
			new Request(
				"https://ci.example.test/engines/gh-actions/github/webhooks",
				{
					method: "POST",
					headers: {
						"x-hub-signature-256": signature(payload),
						"x-github-event": "workflow_job",
						"x-github-delivery": "delivery-1",
					},
					body: payload,
				},
			),
		);
		expect(mounted.status).toBe(202);
		expect(
			(
				await handle(
					new Request(
						`https://ci.example.test/engines/gh-actions/v1/leases/${lease}/jit`,
						{
							method: "POST",
							headers: { authorization: "Bearer identity-token" },
						},
					),
				)
			).status,
		).toBe(200);
		// The control plane routes on the URL, so it is handed the unmounted one.
		expect(
			(
				await handle(
					new Request(
						"https://ci.example.test/engines/gh-actions/v2/accounts/self/policy",
						{ method: "PUT", body: '{"budgetMicros":"1"}' },
					),
				)
			).status,
		).toBe(204);
		expect(
			(await get("/engines/gh-actions/v1/accounts/self/policy")).status,
		).toBe(204);
		expect(seen).toEqual([
			'PUT /v2/accounts/self/policy {"budgetMicros":"1"}',
			"GET /v1/accounts/self/policy ",
		]);
	});
	it("accepts an ingress forward in place of GitHub's signature only with the forward secret", async () => {
		const forwardSecret = "ingress-forward-secret-32-characters!!";
		const admitted: string[] = [];
		const app = application({
			ingestWebhook: async (input) => {
				admitted.push(input.deliveryId);
				return "accepted";
			},
		});
		const forwarded = (headers: Record<string, string>) =>
			new Request("https://ci.example.test/github/webhooks", {
				method: "POST",
				headers: {
					"x-github-event": "workflow_job",
					"x-github-delivery": "delivery-2",
					...headers,
				},
				body: payload,
			});
		const forward = signIngressForward(forwardSecret, Buffer.from(payload));
		const withForward = createRelayHandler({
			application: app,
			webhookSecret: secret,
			ingressForwardSecret: forwardSecret,
		});
		expect(
			(await withForward(forwarded({ "x-hobo-ingress-forward": forward })))
				.status,
		).toBe(202);
		// A forward made with another secret is not a signature at all.
		const wrong = await withForward(
			forwarded({
				"x-hobo-ingress-forward": signIngressForward(
					"another-forward-secret-32-characters!!",
					Buffer.from(payload),
				),
			}),
		);
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toEqual({ error: "signature required" });
		// GitHub's own signature is still accepted on the same relay.
		expect((await withForward(webhook())).status).toBe(202);
		// Without the forward secret the header authenticates nothing.
		expect(
			(await create(app)(forwarded({ "x-hobo-ingress-forward": forward })))
				.status,
		).toBe(401);
		expect(admitted).toEqual(["delivery-2", "delivery-1"]);
		expect(() =>
			createRelayHandler({
				application: app,
				webhookSecret: secret,
				ingressForwardSecret: "too-short",
			}),
		).toThrow("ingress forward secret must have at least 32 bytes");
	});
	it("refuses a request a trusted proxy received over plain HTTP", async () => {
		const trusting = createRelayHandler({
			application: application(),
			webhookSecret: secret,
			trustProxy: true,
		});
		const health = (proto?: string) =>
			new Request("https://ci.example.test/healthz", {
				headers: proto === undefined ? {} : { "x-forwarded-proto": proto },
			});
		const refused = await trusting(health("http"));
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ error: "insecure proxy forward" });
		expect((await trusting(health("HTTPS, http"))).status).toBe(200);
		expect((await trusting(health())).status).toBe(200);
		// A host that does not trust a proxy does not read the header.
		expect((await create(application())(health("http"))).status).toBe(200);
	});
});

describe("webhook body signature", () => {
	const body = Buffer.from(payload);
	it("tells a missing or malformed signature from one made over other bytes", () => {
		const good = signWebhookBody(secret, body);
		expect(good).toBe(signature(payload));
		expect(verifyWebhookSignature(secret, body, good)).toBe("valid");
		expect(verifyWebhookSignature(secret, body, undefined)).toBe("malformed");
		expect(verifyWebhookSignature(secret, body, "sha256=broken")).toBe(
			"malformed",
		);
		expect(verifyWebhookSignature(secret, body, good.toUpperCase())).toBe(
			"malformed",
		);
		expect(
			verifyWebhookSignature(secret, Buffer.from(`${payload} `), good),
		).toBe("mismatch");
		expect(verifyWebhookSignature(`${secret}x`, body, good)).toBe("mismatch");
	});
});
