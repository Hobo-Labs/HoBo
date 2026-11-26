import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
	createGithubOAuthSession,
	type GithubOAuthSessionStore,
} from "../src/github-oauth-session.js";

class MemoryStore implements GithubOAuthSessionStore {
	states = new Map<
		string,
		{
			browserDigest: string;
			accountId: string;
			verifier: string;
			controlToken: string;
			expiresAt: number;
		}
	>();
	sessions = new Map<
		string,
		{
			accountId: string;
			githubId: number;
			githubToken: string;
			controlToken: string;
			expiresAt: number;
		}
	>();
	async issueState(
		digest: string,
		browserDigest: string,
		accountId: string,
		verifier: string,
		controlToken: string,
		expiresAt: number,
	) {
		this.states.set(digest, {
			browserDigest,
			accountId,
			verifier,
			controlToken,
			expiresAt,
		});
	}
	async consumeState(digest: string, browserDigest: string, now: number) {
		const found = this.states.get(digest);
		if (
			!found ||
			found.browserDigest !== browserDigest ||
			found.expiresAt <= now
		)
			return;
		this.states.delete(digest);
		return found;
	}
	async issueSession(
		digest: string,
		accountId: string,
		githubId: number,
		githubToken: string,
		controlToken: string,
		expiresAt: number,
	) {
		this.sessions.set(digest, {
			accountId,
			githubId,
			githubToken,
			controlToken,
			expiresAt,
		});
	}
	async session(digest: string, now: number) {
		const found = this.sessions.get(digest);
		return found && found.expiresAt > now ? found : undefined;
	}
}
const bearer = "a".repeat(40);
function setup(
	trustedBootstrapControl?: (request: Request) => Promise<string | undefined>,
) {
	let current = 1_000_000,
		enabled = true;
	const requests: { url: string; init?: RequestInit }[] = [];
	const store = new MemoryStore();
	const oauthOptions: Parameters<typeof createGithubOAuthSession>[0] = {
		publicOrigin: "https://ci.hobo.test",
		clientId: "Iv1.client_1",
		clientSecret: "client-secret",
		store,
		now: () => current,
		authenticateControl: async (auth) =>
			enabled && auth === `Bearer ${bearer}`
				? {
						accountId: "tenant-a",
						installationIds: [],
						scopes: ["repositories:write"],
					}
				: undefined,
		fetch: async (url, init) => {
			if (init) requests.push({ url: String(url), init });
			else requests.push({ url: String(url) });
			if (String(url).includes("access_token"))
				return Response.json({
					access_token: "github-secret",
					token_type: "bearer",
				});
			return Response.json({ id: 42 });
		},
	};
	if (trustedBootstrapControl)
		oauthOptions.trustedBootstrapControl = trustedBootstrapControl;
	const oauth = createGithubOAuthSession(oauthOptions);
	return {
		oauth,
		store,
		requests,
		advance: (ms: number) => {
			current += ms;
		},
		revoke: () => {
			enabled = false;
		},
	};
}

it("uses a verified bootstrap session without exposing the scoped control token", async () => {
	let calls = 0;
	const f = setup(async (request) => {
		calls++;
		return request.headers.get("cookie") === "verified-owner=yes"
			? bearer
			: undefined;
	});
	const page = await f.oauth.handle(
		new Request("https://ci.hobo.test/v1/app-registration/setup", {
			headers: { cookie: "verified-owner=yes" },
		}),
	);
	const html = await page?.text();
	expect(html).not.toContain('id="account-token"');
	expect(html).not.toContain(bearer);
	const beforeInvalidRequests = calls;
	for (const headers of [
		{ cookie: "verified-owner=yes" },
		{ cookie: "verified-owner=yes", origin: "https://evil.test" },
		{
			cookie: "verified-owner=yes",
			origin: "https://ci.hobo.test",
			authorization: "Basic invalid",
		},
	]) {
		const denied = await f.oauth.handle(
			new Request("https://ci.hobo.test/v1/app-registration/oauth/start", {
				method: "POST",
				headers,
			}),
		);
		expect([401, 403]).toContain(denied?.status);
	}
	expect(calls).toBe(beforeInvalidRequests);
	const started = await f.oauth.handle(
		new Request("https://ci.hobo.test/v1/app-registration/oauth/start", {
			method: "POST",
			headers: {
				cookie: "verified-owner=yes",
				origin: "https://ci.hobo.test",
			},
		}),
	);
	expect(started?.status).toBe(200);
	const output = await started?.text();
	expect(output).not.toContain(bearer);
	expect(f.store.states.size).toBe(1);
	expect([...f.store.states.values()][0]?.controlToken).toBe(bearer);
	const target = new URL(JSON.parse(output ?? "{}").authorizeUrl);
	const browser = started?.headers.getSetCookie()[0]?.split(";")[0];
	if (!browser) throw new Error("missing OAuth browser cookie");
	const callback = await f.oauth.handle(
		new Request(
			`https://ci.hobo.test/v1/app-registration/oauth/callback?state=${target.searchParams.get("state")}&code=owner-code`,
			{ headers: { cookie: browser } },
		),
	);
	expect(callback?.status).toBe(200);
	const session = callback?.headers
		.getSetCookie()
		.find((c) => c.startsWith("__Host-hobo_ci_session="))
		?.split(";")[0];
	if (!session) throw new Error("missing verified GitHub session");
	expect(
		await f.oauth.authenticate(
			new Request("https://ci.hobo.test/", { headers: { cookie: session } }),
		),
	).toMatchObject({
		accountId: "tenant-a",
		subject: expect.stringMatching(/^github:42:/),
	});
	f.revoke();
	const rejected = await f.oauth.handle(
		new Request("https://ci.hobo.test/v1/app-registration/oauth/start", {
			method: "POST",
			headers: {
				cookie: "verified-owner=yes",
				origin: "https://ci.hobo.test",
			},
		}),
	);
	expect(rejected?.status).toBe(403);
});
async function start(f: ReturnType<typeof setup>) {
	const result = await f.oauth.handle(
		new Request("https://ci.hobo.test/v1/app-registration/oauth/start", {
			method: "POST",
			headers: {
				authorization: `Bearer ${bearer}`,
				origin: "https://ci.hobo.test",
			},
		}),
	);
	if (!result) throw new Error("missing start");
	const target = new URL((await result.json()).authorizeUrl);
	const browser = result.headers.getSetCookie()[0]?.split(";")[0];
	if (!browser) throw new Error("missing browser cookie");
	return { target, browser };
}
it("binds a PKCE OAuth exchange, verified GitHub identity and encrypted-store session to a scoped HoBo account", async () => {
	const f = setup(),
		{ target, browser } = await start(f);
	expect(target.origin).toBe("https://github.com");
	expect(target.searchParams.get("code_challenge_method")).toBe("S256");
	const state = target.searchParams.get("state");
	const callback = `https://ci.hobo.test/v1/app-registration/oauth/callback?state=${state}&code=oauthcode`;
	const result = await f.oauth.handle(
		new Request(callback, { headers: { cookie: browser } }),
	);
	expect(result?.status).toBe(200);
	const body = JSON.parse(String(f.requests[0]?.init?.body));
	expect(
		createHash("sha256").update(body.code_verifier).digest("base64url"),
	).toBe(target.searchParams.get("code_challenge"));
	expect(f.requests.map((r) => r.url)).toEqual([
		"https://github.com/login/oauth/access_token",
		"https://api.github.com/user",
	]);
	expect(f.requests.every((r) => r.init?.redirect === "error")).toBe(true);
	const session = result?.headers
		.getSetCookie()
		.find((c) => c.startsWith("__Host-hobo_ci_session="))
		?.split(";")[0];
	if (!session) throw new Error("missing session cookie");
	const actor = await f.oauth.authenticate(
		new Request("https://ci.hobo.test/v1/app-registration/state", {
			headers: { cookie: session },
		}),
	);
	expect(actor).toMatchObject({
		accountId: "tenant-a",
		subject: expect.stringMatching(/^github:42:/),
	});
	if (!actor) throw new Error("missing actor");
	expect(await f.oauth.githubToken(actor)).toBe("github-secret");
	expect(
		(
			await f.oauth.handle(
				new Request(callback, { headers: { cookie: browser } }),
			)
		)?.status,
	).toBe(403);
	f.revoke();
	expect(
		await f.oauth.authenticate(
			new Request("https://ci.hobo.test/", { headers: { cookie: session } }),
		),
	).toBeUndefined();
	expect(await f.oauth.githubToken(actor)).toBeUndefined();
});
it("rejects cross-origin and unscoped starts, a different browser, duplicate state, and expired state", async () => {
	const f = setup();
	expect(
		(
			await f.oauth.handle(
				new Request("https://ci.hobo.test/v1/app-registration/oauth/start", {
					method: "POST",
					headers: {
						authorization: `Bearer ${bearer}`,
						origin: "https://evil.test",
					},
				}),
			)
		)?.status,
	).toBe(403);
	expect(
		(
			await f.oauth.handle(
				new Request("https://ci.hobo.test/v1/app-registration/oauth/start", {
					method: "POST",
				}),
			)
		)?.status,
	).toBe(401);
	const { target, browser } = await start(f);
	const state = target.searchParams.get("state");
	const callback = `https://ci.hobo.test/v1/app-registration/oauth/callback?state=${state}&code=c`;
	expect(
		(
			await f.oauth.handle(
				new Request(callback, {
					headers: { cookie: `__Host-hobo_ci_oauth=${"b".repeat(43)}` },
				}),
			)
		)?.status,
	).toBe(403);
	expect(
		(
			await f.oauth.handle(
				new Request(`${callback}&state=${state}`, {
					headers: { cookie: browser },
				}),
			)
		)?.status,
	).toBe(400);
	f.advance(600_001);
	expect(
		(
			await f.oauth.handle(
				new Request(callback, { headers: { cookie: browser } }),
			)
		)?.status,
	).toBe(403);
	expect(f.requests).toHaveLength(0);
});
it("does not persist a session on failed authorization or token identity lookup", async () => {
	const f = setup(),
		{ target, browser } = await start(f);
	f.revoke();
	const callback = `https://ci.hobo.test/v1/app-registration/oauth/callback?state=${target.searchParams.get("state")}&code=c`;
	expect(
		(
			await f.oauth.handle(
				new Request(callback, { headers: { cookie: browser } }),
			)
		)?.status,
	).toBe(403);
	expect(f.store.sessions.size).toBe(0);
});
