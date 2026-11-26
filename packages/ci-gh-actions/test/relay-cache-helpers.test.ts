/**
 * The relay's helpers on the cache (ADR-0179 phase 5): repair-scanner claims,
 * cursors and rate windows; OAuth and App `state`; sealed sessions; verified
 * installations; the owner's invitation; and the stateless onboarding routes
 * composed from them. All on the in-memory engine with an injected clock.
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	ConfigurationSchema,
	ConfigurationStateSchema,
	ConnectionSchema,
} from "@hobo/ci";
import type { EphemeralStatePort } from "@hobo/core";
import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
	meterExecutor,
} from "@hobo/kv-redis-compatible";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createControlAuthenticator } from "../src/control-auth.js";
import { createQueuedJobRepair } from "../src/queued-job-repair.js";
import {
	CacheAppRegistrationStates,
	CacheGithubOAuthSessionStore,
	CacheOwnerBootstrap,
	CacheQueuedJobRepairClaims,
	CacheVerifiedInstallations,
	CacheWebhookRepairClaims,
	parseRelaySessionKey,
	RelayConfigReadOnlyError,
	relayCacheKeys,
} from "../src/relay-cache/index.js";
import { createStatelessAppOnboarding } from "../src/stateless-app-onboarding.js";
import { createWebhookRepair } from "../src/webhook-repair.js";

const ENV = "test";
const APP = "12345";
const START = Date.parse("2026-11-11T12:00:30.000Z");

function cache() {
	let nowMs = START;
	const engine = createMemoryRedisExecutor({ now: () => nowMs });
	const meter = meterExecutor(engine);
	const state: EphemeralStatePort = createRedisEphemeralState({
		executor: meter,
	});
	return {
		state,
		meter,
		engine,
		now: () => nowMs,
		advance(ms: number) {
			nowMs += ms;
		},
	};
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("webhook repair claims on the cache", () => {
	it("claims a delivery once per 15-minute cooldown", async () => {
		const c = cache();
		const claims = new CacheWebhookRepairClaims({
			state: c.state,
			environment: ENV,
			now: c.now,
		});
		expect(await claims.claim(APP, "guid-1", c.now())).toBe(true);
		expect(await claims.claim(APP, "guid-1", c.now())).toBe(false);
		c.advance(14 * 60_000);
		expect(await claims.claim(APP, "guid-1", c.now())).toBe(false);
		c.advance(2 * 60_000);
		expect(await claims.claim(APP, "guid-1", c.now())).toBe(true);
	});

	it("allows 20 redeliveries a minute per App and gives the 21st claim back", async () => {
		const c = cache();
		const claims = new CacheWebhookRepairClaims({
			state: c.state,
			environment: ENV,
			now: c.now,
		});
		for (let i = 0; i < 20; i++)
			expect(await claims.claim(APP, `guid-${i}`, c.now())).toBe(true);
		expect(await claims.limited(APP, c.now())).toBe(true);
		expect(await claims.claim(APP, "guid-20", c.now())).toBe(false);
		// The refused claim was given back: the next window may take it.
		c.advance(60_000);
		expect(await claims.limited(APP, c.now())).toBe(false);
		expect(await claims.claim(APP, "guid-20", c.now())).toBe(true);
	});

	it("remembers deliveries GitHub reported delivered, writing only new ones", async () => {
		const c = cache();
		const claims = new CacheWebhookRepairClaims({
			state: c.state,
			environment: ENV,
			now: c.now,
		});
		await claims.recordSuccesses(APP, ["a", "b", "a"], c.now());
		const before = c.meter.usage().total;
		await claims.recordSuccesses(APP, ["a", "b"], c.now());
		// Known already: one read, no writes.
		expect(c.meter.usage().total - before).toBe(1);
		expect(await claims.wasSuccessful(APP, "a")).toBe(true);
		expect(await claims.wasSuccessful(APP, "c")).toBe(false);
		c.advance(4 * 24 * 3_600_000 + 1000);
		expect(await claims.wasSuccessful(APP, "a")).toBe(false);
	});

	it("serializes scans with a lock and keeps the cursor between them", async () => {
		const c = cache();
		const one = new CacheWebhookRepairClaims({
			state: c.state,
			environment: ENV,
			now: c.now,
		});
		const two = new CacheWebhookRepairClaims({
			state: c.state,
			environment: ENV,
			now: c.now,
		});
		const scan = await one.startScan(APP);
		if (!scan) throw new Error("no scan");
		expect(scan.cursor).toBeUndefined();
		expect(await two.startScan(APP)).toBeUndefined();
		const next =
			"https://api.github.com/app/hook/deliveries?per_page=100&cursor=abc";
		await scan.checkpoint(next);
		await scan.close();
		const again = await two.startScan(APP);
		expect(again?.cursor).toBe(next);
		await again?.checkpoint(undefined);
		await again?.close();
		expect((await one.startScan(APP))?.cursor).toBeUndefined();
	});

	it("throws at checkpoint once its lock lapsed and another scanner holds it", async () => {
		const c = cache();
		const one = new CacheWebhookRepairClaims({
			state: c.state,
			environment: ENV,
			now: c.now,
		});
		const two = new CacheWebhookRepairClaims({
			state: c.state,
			environment: ENV,
			now: c.now,
		});
		const stalled = await one.startScan(APP);
		c.advance(5 * 60_000 + 1000);
		const fresh = await two.startScan(APP);
		expect(fresh).toBeDefined();
		await expect(
			stalled?.checkpoint(
				"https://api.github.com/app/hook/deliveries?per_page=100&cursor=old",
			),
		).rejects.toThrow("repair scan lock lost");
		// The stalled scanner's close does not free the new holder's lock.
		await stalled?.close();
		expect(await one.startScan(APP)).toBeUndefined();
	});

	it("drives createWebhookRepair: one redelivery per failed delivery, skipping accepted ones", async () => {
		const c = cache();
		const claims = new CacheWebhookRepairClaims({
			state: c.state,
			environment: ENV,
			now: c.now,
		});
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const delivered = new Date(c.now() - 5 * 60_000).toISOString();
		const posts: string[] = [];
		const fetch: typeof globalThis.fetch = async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.includes("/attempts")) {
				posts.push(url);
				return new Response(null, { status: 202 });
			}
			return Response.json([
				{
					id: 1,
					guid: "ok",
					event: "workflow_job",
					status_code: 200,
					delivered_at: delivered,
				},
				{
					id: 2,
					guid: "lost",
					event: "workflow_job",
					status_code: 502,
					delivered_at: delivered,
				},
				{
					id: 3,
					guid: "seen",
					event: "workflow_job",
					status_code: 503,
					delivered_at: delivered,
				},
			]);
		};
		const repair = createWebhookRepair({
			appId: APP,
			privateKey: pem,
			claims,
			isAccepted: async (guid) => guid === "seen",
			fetch,
			now: c.now,
		});
		expect(await repair()).toMatchObject({ scanned: 3, requested: 1 });
		expect(posts).toEqual([
			"https://api.github.com/app/hook/deliveries/2/attempts",
		]);
		// Again within the cooldown: nothing is redelivered twice.
		expect(await repair()).toMatchObject({ requested: 0 });
		expect(posts).toHaveLength(1);
	});
});

type QueuedStart = Awaited<ReturnType<CacheQueuedJobRepairClaims["start"]>>;
/** The scan a start opened; any other answer fails the test. */
function opened(start: QueuedStart) {
	if (start === undefined || start === "busy" || start === "deferred")
		throw new Error(`no scan: ${start}`);
	return start;
}

describe("queued-job repair claims on the cache", () => {
	const keys = ["acct:10:101:queued", "acct:10:101:in_progress"];

	it("is busy while another instance scans, and deferred while nothing is due", async () => {
		const c = cache();
		const options = {
			state: c.state,
			environment: ENV,
			appId: APP,
			now: c.now,
		};
		const one = new CacheQueuedJobRepairClaims(options);
		const two = new CacheQueuedJobRepairClaims(options);
		const scan = opened(await one.start(keys));
		expect(scan.key).toBe(keys[1]);
		expect(await two.start(keys)).toBe("busy");
		await scan.checkpoint(scan.cursor, 600_000);
		await scan.close();
		const next = opened(await two.start(keys));
		// The untouched key comes first.
		expect(next.key).toBe(keys[0]);
		await next.checkpoint(next.cursor, 30_000);
		expect(await next.more()).toBe(true);
		await next.close();
		expect(await one.start(keys)).toBe("deferred");
		c.advance(30_000);
		expect(opened(await one.start(keys)).key).toBe(keys[0]);
	});

	it("spends at most ten GitHub calls a minute per App", async () => {
		const c = cache();
		const claims = new CacheQueuedJobRepairClaims({
			state: c.state,
			environment: ENV,
			appId: APP,
			now: c.now,
		});
		const scan = opened(await claims.start(keys));
		expect(await scan.take(8)).toBe(true);
		expect(await scan.take(3)).toBe(false);
		expect(await scan.take(2)).toBe(true);
		expect(await scan.take(1)).toBe(false);
		c.advance(60_000);
		expect(await scan.take(10)).toBe(true);
	});

	it("drives createQueuedJobRepair: a queued job whose delivery never came is admitted", async () => {
		const c = cache();
		const config = create(ConfigurationSchema, {
			connections: [
				create(ConnectionSchema, {
					accountId: "acct",
					repository: "Org/Repo",
					repositoryId: 101,
					installationId: 10,
				}),
			],
		});
		const processed: unknown[] = [];
		const github = {
			async request(_installation: number, path: string) {
				if (path.includes("/actions/runs?status=queued"))
					return Response.json({ workflow_runs: [{ id: 900 }] });
				if (path.includes("/actions/runs?status="))
					return Response.json({ workflow_runs: [] });
				if (path.includes("/actions/runs/900/jobs"))
					return Response.json({
						jobs: [
							{
								id: 4001,
								run_id: 900,
								run_attempt: 1,
								status: "queued",
								labels: ["hobo"],
							},
						],
					});
				return new Response(null, { status: 404 });
			},
			appRequest: async () => new Response(null, { status: 404 }),
		};
		const repair = createQueuedJobRepair({
			store: {
				configuration: async () =>
					create(ConfigurationStateSchema, {
						revision: 1,
						configuration: config,
					}),
			},
			github,
			claims: new CacheQueuedJobRepairClaims({
				state: c.state,
				environment: ENV,
				appId: APP,
				now: c.now,
			}),
			relay: async () => ({
				processWebhook: async (body: Uint8Array) => {
					processed.push(JSON.parse(Buffer.from(body).toString("utf8")));
					return "queued";
				},
			}),
		});
		// The run list, then its jobs; each tick advances one cursor.
		for (let tick = 0; tick < 4; tick++) await repair();
		expect(processed).toEqual([
			expect.objectContaining({
				action: "queued",
				workflow_job: expect.objectContaining({ id: 4001 }),
			}),
		]);
	});
});

describe("sessions and state on the cache", () => {
	const key = parseRelaySessionKey(randomBytes(32));

	it("consumes an OAuth state once, only from the browser that started it", async () => {
		const c = cache();
		const store = new CacheGithubOAuthSessionStore({
			state: c.state,
			environment: ENV,
			sessionKey: key,
			now: c.now,
		});
		await store.issueState(
			sha("state"),
			sha("browser"),
			"acct",
			"verifier",
			"control-token-value",
			c.now() + 600_000,
		);
		expect(await store.consumeState(sha("state"), sha("other"), c.now())).toBe(
			undefined,
		);
		// A wrong browser consumed it: the state is gone, as in Postgres.
		expect(
			await store.consumeState(sha("state"), sha("browser"), c.now()),
		).toBeUndefined();
		await store.issueState(
			sha("state-2"),
			sha("browser"),
			"acct",
			"verifier",
			"control-token-value",
			c.now() + 600_000,
		);
		expect(
			await store.consumeState(sha("state-2"), sha("browser"), c.now()),
		).toEqual({
			accountId: "acct",
			verifier: "verifier",
			controlToken: "control-token-value",
		});
		expect(
			await store.consumeState(sha("state-2"), sha("browser"), c.now()),
		).toBeUndefined();
	});

	it("seals sessions: no token or digest in any key or value, and a new session key reads nothing", async () => {
		const c = cache();
		const options = {
			state: c.state,
			environment: ENV,
			sessionKey: key,
			now: c.now,
		};
		const store = new CacheGithubOAuthSessionStore(options);
		await store.issueSession(
			sha("cookie"),
			"acct",
			42,
			"gho_user_token_value",
			"control-token-value",
			c.now() + 900_000,
		);
		expect(await store.session(sha("cookie"), c.now())).toMatchObject({
			accountId: "acct",
			githubId: 42,
			githubToken: "gho_user_token_value",
		});
		const keys = relayCacheKeys(ENV);
		// Look the record up through every name it could have: none of them is the digest.
		expect(
			await c.state.get(keys.sealed("oauth-session", sha("cookie"))),
		).toBeUndefined();
		const rotated = new CacheGithubOAuthSessionStore({
			...options,
			sessionKey: parseRelaySessionKey(randomBytes(32)),
		});
		expect(await rotated.session(sha("cookie"), c.now())).toBeUndefined();
		c.advance(900_000);
		expect(await store.session(sha("cookie"), c.now())).toBeUndefined();
	});

	it("never stores a credential in the clear", async () => {
		const c = cache();
		const writes: string[] = [];
		const state: EphemeralStatePort = {
			...c.state,
			get: (k) => c.state.get(k),
			getMany: (k) => c.state.getMany(k),
			delete: (k, v) => c.state.delete(k, v),
			increment: (k, b, t, m) => c.state.increment(k, b, t, m),
			expire: (k, t) => c.state.expire(k, t),
			compareAndSet: (k, v, value, t) => {
				writes.push(k, value);
				return c.state.compareAndSet(k, v, value, t);
			},
			putIfAbsent: (k, value, t) => {
				writes.push(k, value);
				return c.state.putIfAbsent(k, value, t);
			},
		};
		const store = new CacheGithubOAuthSessionStore({
			state,
			environment: ENV,
			sessionKey: key,
			now: c.now,
		});
		await store.issueState(
			sha("state"),
			sha("browser"),
			"acct",
			"pkce-verifier-value",
			"control-token-value",
			c.now() + 600_000,
		);
		await store.issueSession(
			sha("cookie"),
			"acct",
			42,
			"gho_user_token_value",
			"control-token-value",
			c.now() + 900_000,
		);
		const all = writes.join("\n");
		for (const secret of [
			"control-token-value",
			"gho_user_token_value",
			"pkce-verifier-value",
			sha("state"),
			sha("cookie"),
			sha("browser"),
		])
			expect(all).not.toContain(secret);
	});

	it("consumes an App-installation state once, for the same actor and purpose", async () => {
		const c = cache();
		const states = new CacheAppRegistrationStates({
			state: c.state,
			environment: ENV,
			sessionKey: key,
			now: c.now,
		});
		const actor = { accountId: "acct", subject: "github:42:abc" };
		await states.issue(sha("s1"), "install", actor, c.now() + 600_000);
		expect(await states.consume(sha("s1"), "register", actor, c.now())).toBe(
			false,
		);
		await states.issue(sha("s2"), "install", actor, c.now() + 600_000);
		expect(await states.consume(sha("s2"), "install", actor, c.now())).toBe(
			true,
		);
		expect(await states.consume(sha("s2"), "install", actor, c.now())).toBe(
			false,
		);
	});

	it("keeps verified installations a day, one account per installation, and refuses App registration", async () => {
		const c = cache();
		const verified: [string, number][] = [];
		const vault = new CacheVerifiedInstallations({
			state: c.state,
			environment: ENV,
			now: c.now,
			onVerified: (account, id) => verified.push([account, id]),
		});
		await vault.bindInstallation(7, 10, "acct");
		await vault.bindInstallation(7, 11, "acct");
		await vault.bindInstallation(7, 10, "acct");
		expect(await vault.ownedInstallations(7, "acct")).toEqual([10, 11]);
		expect(await vault.ownedInstallations(8, "acct")).toEqual([]);
		await expect(vault.bindInstallation(7, 10, "other")).rejects.toThrow(
			"another account",
		);
		expect(verified).toEqual([
			["acct", 10],
			["acct", 11],
			["acct", 10],
		]);
		await expect(vault.saveApp()).rejects.toBeInstanceOf(
			RelayConfigReadOnlyError,
		);
		c.advance(24 * 3_600_000 + 1000);
		expect(await vault.ownedInstallations(7, "acct")).toEqual([]);
	});

	it("redeems the owner's invitation once", async () => {
		const c = cache();
		const owners = new CacheOwnerBootstrap({
			state: c.state,
			environment: ENV,
			sessionKey: key,
			now: c.now,
		});
		const expires = c.now() + 3_600_000;
		expect(await owners.redeem(sha("invite"), expires)).toBe(true);
		expect(await owners.redeem(sha("invite"), expires)).toBe(false);
		expect(await owners.redeem(sha("expired"), c.now())).toBe(false);
		await owners.issueSession(sha("owner-cookie"), "acct", c.now() + 600_000);
		expect(await owners.session(sha("owner-cookie"))).toBe("acct");
		c.advance(600_000);
		expect(await owners.session(sha("owner-cookie"))).toBeUndefined();
	});
});

describe("stateless onboarding routes", () => {
	const ORIGIN = "https://ci.example.test";
	const control = randomBytes(32).toString("base64url");
	const invitation = randomBytes(32).toString("base64url");

	function compose(c: ReturnType<typeof cache>) {
		const authenticate = createControlAuthenticator(
			JSON.stringify({
				tokens: [
					{
						accountId: "acct",
						installationIds: [],
						tokenSha256: sha(control),
						scopes: ["policy:read", "policy:write", "repositories:write"],
					},
				],
			}),
		);
		const fetch: typeof globalThis.fetch = async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === "https://github.com/login/oauth/access_token")
				return Response.json({
					access_token: "gho_user",
					token_type: "bearer",
				});
			if (url === "https://api.github.com/user")
				return Response.json({ id: 42 });
			return new Response(null, { status: 404 });
		};
		const github = {
			request: async () => new Response(null, { status: 404 }),
			async appRequest(path: string) {
				if (path === "/app") return Response.json({ id: 7, slug: "hobo-ci" });
				if (path === "/app/installations/10")
					return Response.json({
						id: 10,
						app_id: 7,
						suspended_at: null,
						account: { id: 42, login: "owner", type: "User" },
					});
				return new Response(null, { status: 404 });
			},
		};
		const verified: number[] = [];
		const onboarding = createStatelessAppOnboarding({
			state: c.state,
			environment: ENV,
			sessionKey: parseRelaySessionKey(randomBytes(32)),
			publicOrigin: ORIGIN,
			appId: 7,
			clientId: "Iv1.test",
			clientSecret: "s".repeat(30),
			github,
			authenticate,
			owner: {
				accountId: "acct",
				tokenSha256: sha(invitation),
				expiresAt: c.now() + 3_600_000,
				controlToken: control,
			},
			onVerified: (_account, id) => verified.push(id),
			fetch,
			now: c.now,
		});
		return { onboarding, verified };
	}

	/** The response a route gave; a route that answered nothing fails the test. */
	const answered = (response: Response | undefined): Response => {
		if (!response) throw new Error("route not served");
		return response;
	};
	const cookieOf = (response: Response | undefined, name: string) =>
		answered(response)
			.headers.getSetCookie()
			.find((entry) => entry.startsWith(`${name}=`))
			?.split(";")[0]
			?.slice(name.length + 1) ?? "";

	it("redeems the invitation once, opens an owner session, then signs in and verifies an installation", async () => {
		const c = cache();
		const { onboarding, verified } = compose(c);
		const start = () =>
			onboarding.handle(
				new Request(`${ORIGIN}/v1/app-bootstrap/start`, {
					method: "POST",
					headers: { authorization: `Bearer ${invitation}`, origin: ORIGIN },
				}),
			);
		const first = await start();
		expect(first?.status).toBe(200);
		const owner = cookieOf(first, "__Host-hobo_ci_bootstrap");
		expect(owner).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect((await start())?.status).toBe(403);
		const setup = await onboarding.handle(
			new Request(`${ORIGIN}/v1/app-bootstrap/setup`, {
				headers: { cookie: `__Host-hobo_ci_bootstrap=${owner}` },
			}),
		);
		expect(setup?.status).toBe(303);

		// The owner session stands for the onboarding control token.
		const oauthStart = await onboarding.handle(
			new Request(`${ORIGIN}/v1/app-registration/oauth/start`, {
				method: "POST",
				headers: {
					origin: ORIGIN,
					cookie: `__Host-hobo_ci_bootstrap=${owner}`,
				},
			}),
		);
		expect(oauthStart?.status).toBe(200);
		const { authorizeUrl } = z
			.object({ authorizeUrl: z.string().url() })
			.parse(await answered(oauthStart).json());
		const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
		const browser = cookieOf(oauthStart, "__Host-hobo_ci_oauth");
		const callback = await onboarding.handle(
			new Request(
				`${ORIGIN}/v1/app-registration/oauth/callback?state=${state}&code=abc`,
				{ headers: { cookie: `__Host-hobo_ci_oauth=${browser}` } },
			),
		);
		expect(callback?.status).toBe(200);
		const session = cookieOf(callback, "__Host-hobo_ci_session");

		// Begin and complete an installation; the result lives in the cache for a day.
		const begun = await onboarding.handle(
			new Request(`${ORIGIN}/v1/app-registration/state`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: `__Host-hobo_ci_session=${session}`,
				},
				body: JSON.stringify({ purpose: "install" }),
			}),
		);
		expect(begun?.status).toBe(200);
		const { state: installState } = z
			.object({ state: z.string() })
			.parse(await answered(begun).json());
		const installed = await onboarding.handle(
			new Request(
				`${ORIGIN}/v1/app-registration/install-callback?state=${installState}&installation_id=10&setup_action=install`,
				{ headers: { cookie: `__Host-hobo_ci_session=${session}` } },
			),
		);
		expect(installed?.status).toBe(200);
		expect(verified).toEqual([10]);
		const principal = await onboarding.authenticate(`Bearer ${control}`);
		expect(principal?.installationIds).toEqual([10]);
	});

	it("answers 410 for the routes that created an App in the relay", async () => {
		const c = cache();
		const { onboarding } = compose(c);
		for (const path of [
			"/v1/app-bootstrap/callback",
			"/v1/app-bootstrap/verify-callback",
			"/v1/app-registration/manifest-callback?state=x&code=y",
		]) {
			const response = await onboarding.handle(new Request(`${ORIGIN}${path}`));
			expect(response?.status).toBe(410);
		}
		// A registration state cannot be begun either.
		expect(
			await onboarding.handle(new Request(`${ORIGIN}/v1/other`)),
		).toBeUndefined();
	});

	it("refuses a wrong or expired invitation", async () => {
		const c = cache();
		const { onboarding } = compose(c);
		const wrong = await onboarding.handle(
			new Request(`${ORIGIN}/v1/app-bootstrap/start`, {
				method: "POST",
				headers: { authorization: `Bearer ${"x".repeat(43)}` },
			}),
		);
		expect(wrong?.status).toBe(403);
		c.advance(3_600_000);
		const late = await onboarding.handle(
			new Request(`${ORIGIN}/v1/app-bootstrap/start`, {
				method: "POST",
				headers: { authorization: `Bearer ${invitation}` },
			}),
		);
		expect(late?.status).toBe(403);
	});
});
