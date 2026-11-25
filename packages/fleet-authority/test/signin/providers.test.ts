import { generateKeyPairSync, sign } from "node:crypto";
import type { JsonObject } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createAtprotoSignInProvider } from "../../src/signin/atproto.js";
import { createGithubSignInProvider } from "../../src/signin/github.js";
import { createOidcSignInProvider, nonceOf } from "../../src/signin/oidc.js";

const NOW = Date.parse("2026-11-13T10:00:00Z");
const REDIRECT = "https://authority.example/v1/fleet/signin/callback";
const begin = {
	state: "state-1",
	redirectUri: REDIRECT,
	codeChallenge: "c".repeat(43),
};
const complete = {
	code: "code-1",
	state: "state-1",
	redirectUri: REDIRECT,
	codeVerifier: "v".repeat(43),
};

type Seen = { url: string; method: string; body: string; headers: Headers };

function fakeFetch(routes: Readonly<Record<string, (seen: Seen) => Response>>) {
	const seen: Seen[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input);
		const entry: Seen = {
			url,
			method: init?.method ?? "GET",
			body: String(init?.body ?? ""),
			headers: new Headers(init?.headers),
		};
		seen.push(entry);
		const path = url.split("?")[0] ?? url;
		const route = routes[path];
		return route === undefined
			? new Response("missing", { status: 404 })
			: route(entry);
	};
	return { fetcher, seen };
}

describe("the oidc provider", () => {
	const issuer = "https://login.example";
	const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const idToken = (claims: JsonObject) => {
		const head = Buffer.from(
			JSON.stringify({ alg: "RS256", kid: "k1" }),
		).toString("base64url");
		const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
		return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
	};
	const routes = (claims: JsonObject) => ({
		[`${issuer}/.well-known/openid-configuration`]: () =>
			Response.json({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				jwks_uri: `${issuer}/jwks`,
			}),
		[`${issuer}/jwks`]: () =>
			Response.json({
				keys: [{ ...key.publicKey.export({ format: "jwk" }), kid: "k1" }],
			}),
		[`${issuer}/token`]: () =>
			Response.json({ id_token: idToken(claims), access_token: "unused" }),
	});
	const good = {
		iss: issuer,
		aud: "fleet-client",
		sub: "alice-123",
		email: "alice@example.com",
		nonce: nonceOf("state-1"),
		exp: NOW / 1000 + 300,
		iat: NOW / 1000,
	};

	it("starts with PKCE and a nonce, and completes with a verified ID token", async () => {
		const { fetcher, seen } = fakeFetch(routes(good));
		const provider = createOidcSignInProvider({
			issuer,
			clientId: "fleet-client",
			clientSecret: async () => "s3cret",
			principalClaim: "email",
			fetch: fetcher,
			now: () => NOW,
		});
		const { url } = await provider.begin(begin);
		const query = new URL(url).searchParams;
		expect(query.get("code_challenge_method")).toBe("S256");
		expect(query.get("nonce")).toBe(nonceOf("state-1"));
		expect(query.get("scope")).toBe("openid email profile");
		const done = await provider.complete(complete);
		expect(done).toMatchObject({
			ok: true,
			value: {
				principal: { kind: "user", id: "login.example/alice@example.com" },
			},
		});
		const token = seen.find((entry) => entry.url === `${issuer}/token`);
		expect(new URLSearchParams(token?.body).get("code_verifier")).toBe(
			"v".repeat(43),
		);
	});

	it("refuses an ID token for another sign-in or another client", async () => {
		for (const claims of [
			{ ...good, nonce: "other" },
			{ ...good, aud: "someone-else" },
		]) {
			const { fetcher } = fakeFetch(routes(claims));
			const provider = createOidcSignInProvider({
				issuer,
				clientId: "fleet-client",
				fetch: fetcher,
				now: () => NOW,
			});
			expect((await provider.complete(complete)).ok).toBe(false);
		}
	});
});

describe("the github provider", () => {
	it("maps the user and their organisations, using the token once", async () => {
		const { fetcher, seen } = fakeFetch({
			"https://github.com/login/oauth/access_token": () =>
				Response.json({ access_token: "gho_x" }),
			"https://api.github.com/user": () =>
				Response.json({ login: "octo", id: 7 }),
			"https://api.github.com/user/orgs": () =>
				Response.json([{ login: "acme" }, { login: "hobo" }]),
		});
		const provider = createGithubSignInProvider({
			clientId: "Iv1",
			clientSecret: async () => "s",
			fetch: fetcher,
		});
		const { url } = await provider.begin(begin);
		expect(new URL(url).searchParams.get("code_challenge")).toBe(
			"c".repeat(43),
		);
		expect(await provider.complete(complete)).toEqual({
			ok: true,
			value: {
				principal: { kind: "user", id: "github.com/octo" },
				claims: {
					iss: "https://github.com",
					login: "octo",
					id: "7",
					org: "acme,hobo",
				},
			},
		});
		expect(
			seen.filter(
				(entry) => entry.headers.get("authorization") === "Bearer gho_x",
			),
		).toHaveLength(2);
	});

	it("refuses when GitHub refuses the code", async () => {
		const { fetcher } = fakeFetch({
			"https://github.com/login/oauth/access_token": () =>
				Response.json({ error: "bad_verification_code" }),
		});
		const provider = createGithubSignInProvider({
			clientId: "Iv1",
			clientSecret: async () => "s",
			fetch: fetcher,
		});
		expect((await provider.complete(complete)).ok).toBe(false);
	});
});

describe("the atproto provider", () => {
	const server = "https://pds.example";
	it("pushes the request, retries the token request with the server's DPoP nonce, and names the DID", async () => {
		let tokenCalls = 0;
		const { fetcher, seen } = fakeFetch({
			[`${server}/.well-known/oauth-authorization-server`]: () =>
				Response.json({
					issuer: server,
					pushed_authorization_request_endpoint: `${server}/par`,
					authorization_endpoint: `${server}/authorize`,
					token_endpoint: `${server}/token`,
				}),
			[`${server}/par`]: () =>
				Response.json(
					{ request_uri: "urn:ietf:params:oauth:request_uri:abc" },
					{ status: 201 },
				),
			[`${server}/token`]: () => {
				tokenCalls += 1;
				return tokenCalls === 1
					? Response.json(
							{ error: "use_dpop_nonce" },
							{ status: 400, headers: { "dpop-nonce": "n-1" } },
						)
					: Response.json({
							sub: "did:plc:alice",
							access_token: "x",
							token_type: "DPoP",
						});
			},
		});
		const provider = createAtprotoSignInProvider({
			authorizationServer: server,
			clientId: "https://authority.example/client-metadata.json",
			fetch: fetcher,
			now: () => NOW,
		});
		const { url } = await provider.begin(begin);
		expect(new URL(url).searchParams.get("request_uri")).toBe(
			"urn:ietf:params:oauth:request_uri:abc",
		);
		const done = await provider.complete(complete);
		expect(done).toMatchObject({
			ok: true,
			value: { principal: { kind: "user", id: "did:plc:alice" } },
		});
		const retried = seen
			.filter((entry) => entry.url === `${server}/token`)
			.at(-1);
		const dpop = retried?.headers.get("dpop") ?? "";
		const claims = JSON.parse(
			Buffer.from(dpop.split(".")[1] ?? "", "base64url").toString(),
		);
		expect(claims).toMatchObject({
			nonce: "n-1",
			htm: "POST",
			htu: `${server}/token`,
		});
	});
});
