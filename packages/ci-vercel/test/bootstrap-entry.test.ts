import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createBootstrapEntry,
	StoreUnavailable,
} from "../src/bootstrap-entry.js";
import { createHttpEntry } from "../src/entry.js";

const env = {
	HOBO_CI_PUBLIC_URL: "https://ci.hobo.test",
	HOBO_CI_SESSION_KEY: Buffer.alloc(32, 3).toString("base64url"),
};
const credentials = {
	appId: 42,
	pem: "private-key",
	webhookSecret: "webhook-secret",
	clientId: "Iv1.app",
	clientSecret: "client-secret",
};
const notify = async () => {},
	continueRepair = async () => {},
	scheduledRepair = async () => {};

describe("bootstrap entry", () => {
	it("serves bootstrap before an App exists and atomically switches to a single live runtime", async () => {
		let ready = false;
		const bootstrap = {
			async load() {
				return ready ? credentials : undefined;
			},
			async handle(request: Request) {
				if (new URL(request.url).pathname.endsWith("/callback")) {
					ready = true;
					return Response.json({ appId: 42 });
				}
				return Response.json({ step: "start" });
			},
		};
		const app = {
			origin: env.HOBO_CI_PUBLIC_URL,
			handle: vi.fn(async (request: Request) =>
				Response.json({ path: new URL(request.url).pathname }),
			),
			tick: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};
		const create = vi.fn(async () => app);
		const entry = createBootstrapEntry({
			env,
			notify,
			continueRepair,
			scheduledRepair,
			bootstrap,
			createApplication: create,
		});
		expect(
			(await entry.handle(new Request(`${env.HOBO_CI_PUBLIC_URL}/healthz`)))
				.status,
		).toBe(200);
		expect(
			(await entry.handle(new Request(`${env.HOBO_CI_PUBLIC_URL}/readyz`)))
				.status,
		).toBe(503);
		expect(
			(
				await entry.handle(
					new Request(`${env.HOBO_CI_PUBLIC_URL}/github/webhooks`, {
						method: "POST",
					}),
				)
			).status,
		).toBe(503);
		expect(
			(
				await entry.handle(
					new Request(`${env.HOBO_CI_PUBLIC_URL}/v1/app-bootstrap/start`, {
						method: "POST",
					}),
				)
			).status,
		).toBe(200);
		expect(
			(
				await entry.handle(
					new Request(`${env.HOBO_CI_PUBLIC_URL}/v1/app-bootstrap/callback`),
				)
			).status,
		).toBe(200);
		const requests = Array.from({ length: 10 }, () =>
			entry.handle(
				new Request(`${env.HOBO_CI_PUBLIC_URL}/v1/accounts/self/policy`),
			),
		);
		const replies = await Promise.all(requests);
		expect(replies.every((reply) => reply.status === 200)).toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0]?.[0].env).toMatchObject({
			HOBO_CI_GITHUB_APP_ID: "42",
			HOBO_CI_GITHUB_APP_PRIVATE_KEY: credentials.pem,
			HOBO_CI_WEBHOOK_SECRET: credentials.webhookSecret,
			HOBO_CI_GITHUB_APP_CLIENT_ID: credentials.clientId,
			HOBO_CI_GITHUB_APP_CLIENT_SECRET: credentials.clientSecret,
		});
		await entry.tick({ source: "static" });
		expect(app.tick).toHaveBeenCalledWith({ source: "static" });
		await entry.close();
		expect(app.close).toHaveBeenCalledOnce();
		expect(
			(await entry.handle(new Request(`${env.HOBO_CI_PUBLIC_URL}/healthz`)))
				.status,
		).toBe(503);
	});
	it("retries failed runtime startup and rejects conflicting static App credentials", async () => {
		const bootstrap = {
			async load() {
				return credentials;
			},
			async handle() {
				return undefined;
			},
		};
		const app = {
			origin: env.HOBO_CI_PUBLIC_URL,
			handle: async () => new Response(null, { status: 204 }),
			tick: async () => {},
			close: async () => {},
		};
		const create = vi
			.fn()
			.mockRejectedValueOnce(new Error("transient"))
			.mockResolvedValue(app);
		let clock = 1_000_000;
		const entry = createBootstrapEntry({
			env,
			notify,
			continueRepair,
			scheduledRepair,
			bootstrap,
			createApplication: create,
			now: () => clock,
		});
		const get = (path: string) =>
			entry.handle(new Request(`${env.HOBO_CI_PUBLIC_URL}${path}`));
		// Readiness names the reason and says when to come back.
		const unready = await get("/readyz");
		expect(unready.status).toBe(503);
		expect(await unready.json()).toEqual({
			ready: false,
			reason: "store-unavailable",
		});
		expect(unready.headers.get("retry-after")).toBe("5");
		// Liveness is about the process: it stays up while the store is down.
		expect((await get("/healthz")).status).toBe(200);
		// Any other request fails, and the store is not dialled again yet.
		await expect(get("/v1/accounts/self/policy")).rejects.toThrow(
			"store unavailable; not retried yet",
		);
		expect((await get("/readyz")).status).toBe(503);
		expect(create).toHaveBeenCalledTimes(1);
		// After the back-off it is tried again and recovers.
		clock += 5_000;
		expect((await get("/readyz")).status).toBe(204);
		expect(create).toHaveBeenCalledTimes(2);
		await entry.close();
		expect(() =>
			createBootstrapEntry({
				env: { ...env, HOBO_CI_GITHUB_APP_ID: "42" },
				notify,
				continueRepair,
				scheduledRepair,
				bootstrap,
				createApplication: create,
			}),
		).toThrow("mutually exclusive");
	});
	it("hands the control credential only to a verified owner session", async () => {
		const controlToken = "a".repeat(43);
		const bootstrap = {
			async load() {
				return credentials;
			},
			async handle() {
				return undefined;
			},
			async isVerifiedOwner(request: Request) {
				return request.headers.get("cookie") === "owner=verified";
			},
		};
		const app = {
			origin: env.HOBO_CI_PUBLIC_URL,
			handle: async () => new Response(null, { status: 204 }),
			tick: async () => {},
			close: async () => {},
		};
		const create = vi.fn(async () => app);
		const entry = createBootstrapEntry({
			env: {
				...env,
				HOBO_CI_ONBOARDING_CONTROL_TOKEN: controlToken,
				HOBO_CI_INVITATION_EXPIRES_AT: "1793118000000",
			},
			notify,
			continueRepair,
			scheduledRepair,
			bootstrap,
			expectedGithubOwnerId: 145080887,
			createApplication: create,
		});
		await entry.handle(new Request(`${env.HOBO_CI_PUBLIC_URL}/readyz`));
		const trusted = create.mock.calls[0]?.[0].trustedBootstrapControl;
		expect(trusted).toBeDefined();
		if (!trusted) throw new Error("owner control bridge unavailable");
		await expect(
			trusted(new Request(env.HOBO_CI_PUBLIC_URL)),
		).resolves.toBeUndefined();
		await expect(
			trusted(
				new Request(env.HOBO_CI_PUBLIC_URL, {
					headers: { cookie: "owner=verified" },
				}),
			),
		).resolves.toBe(controlToken);
		await entry.close();
	});
	it("answers queue wakeups itself while the store is down: ticks are dropped, deliveries held", async () => {
		const secret = "c".repeat(40);
		const create = vi
			.fn()
			.mockRejectedValue(new Error("bootstrap store initialization failed"));
		let clock = 1_000_000;
		const entry = createBootstrapEntry({
			env: { ...env, CRON_SECRET: secret },
			notify,
			continueRepair,
			scheduledRepair,
			bootstrap: {
				async load() {
					return credentials;
				},
				async handle() {
					return undefined;
				},
			},
			createApplication: create,
			now: () => clock,
		});
		const wakeup = (body: string) =>
			entry.handle(
				new Request(`${env.HOBO_CI_PUBLIC_URL}/internal/queue-wakeup`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${secret}`,
						"content-type": "application/json",
					},
					body,
				}),
			);
		const tick = '{"source":"static","name":"hobo-ci-repair"}';
		// The store's own error on the first attempt, then the back-off.
		expect((await wakeup(tick)).status).toBe(204);
		expect((await wakeup(tick)).status).toBe(204);
		expect(create).toHaveBeenCalledTimes(1);
		clock += 1_000;
		const delivery = await wakeup('{"deliveryId":"one"}');
		expect(delivery.status).toBe(503);
		expect(delivery.headers.get("retry-after")).toBe("4");
		// Still authenticated before anything else.
		const forged = await entry.handle(
			new Request(`${env.HOBO_CI_PUBLIC_URL}/internal/queue-wakeup`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: tick,
			}),
		);
		expect(forged.status).toBe(403);
		expect(create).toHaveBeenCalledTimes(1);
		await entry.close();
	});
	it("states the remaining store back-off in Retry-After on the wire", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const bootstrap = {
			async load() {
				return credentials;
			},
			async handle() {
				return undefined;
			},
		};
		const create = vi.fn().mockRejectedValue(new Error("store down"));
		let clock = 1_000_000;
		const entry = createBootstrapEntry({
			env,
			notify,
			continueRepair,
			scheduledRepair,
			bootstrap,
			createApplication: create,
			now: () => clock,
		});
		// The thrown back-off carries the wait; the HTTP adapter states it.
		await entry.tick(null).catch(() => {});
		const backingOff = await entry.tick(null).then(
			() => undefined,
			(error: Error) => error,
		);
		expect(backingOff).toBeInstanceOf(StoreUnavailable);
		expect(backingOff).toMatchObject({ retryAfterMs: 5_000 });

		const server = createServer(createHttpEntry(async () => entry));
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const { port } = z.object({ port: z.number() }).parse(server.address());
			const wakeup = async () => {
				const response = await fetch(
					`http://127.0.0.1:${port}/internal/queue-wakeup`,
					{ method: "POST", body: "{}" },
				);
				await response.arrayBuffer();
				return [response.status, response.headers.get("retry-after")];
			};
			// 1 s into the first 5 s back-off: four seconds left, store not dialled.
			clock += 1_000;
			expect(await wakeup()).toEqual([503, "4"]);
			expect(create).toHaveBeenCalledTimes(1);
			// Past it: the store is dialled, fails again, and the back-off doubles.
			clock += 4_000;
			expect((await wakeup())[0]).toBe(503);
			expect(create).toHaveBeenCalledTimes(2);
			expect(await wakeup()).toEqual([503, "10"]);
			clock += 9_500;
			expect(await wakeup()).toEqual([503, "1"]);
			expect(create).toHaveBeenCalledTimes(2);
		} finally {
			server.close();
			await once(server, "close");
			log.mockRestore();
			await entry.close();
		}
	});
});
