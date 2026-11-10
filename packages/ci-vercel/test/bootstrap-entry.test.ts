import { describe, expect, it, vi } from "vitest";
import { createBootstrapEntry } from "../src/bootstrap-entry.js";

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
});
