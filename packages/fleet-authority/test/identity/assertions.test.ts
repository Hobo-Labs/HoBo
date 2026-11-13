import {
	generateKeyPairSync,
	type KeyObject,
	sign,
	X509Certificate,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createIdentityAssertionVerifier } from "../../src/identity/assertions.js";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "https://authority.example";
const NOW = Date.parse("2026-11-13T10:00:00Z");

function jwt(
	header: JsonObject,
	claims: JsonObject,
	key: KeyObject,
	es256 = false,
): string {
	const head = Buffer.from(JSON.stringify(header)).toString("base64url");
	const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const signature = es256
		? sign("sha256", Buffer.from(`${head}.${body}`), {
				key,
				dsaEncoding: "ieee-p1363",
			})
		: sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key);
	return `${head}.${body}.${signature.toString("base64url")}`;
}

function provider() {
	const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const fetched: string[] = [];
	const keys = [
		{ ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa-1", alg: "RS256" },
		{ ...ec.publicKey.export({ format: "jwk" }), kid: "ec-1", alg: "ES256" },
	];
	const fakeFetch: typeof fetch = async (input) => {
		const url = String(input);
		fetched.push(url);
		if (url === `${ISSUER}/.well-known/openid-configuration`)
			return Response.json({
				issuer: ISSUER,
				jwks_uri: `${ISSUER}/.well-known/jwks`,
			});
		if (url === `${ISSUER}/.well-known/jwks`) return Response.json({ keys });
		return new Response("missing", { status: 404 });
	};
	const claims = {
		iss: ISSUER,
		aud: AUDIENCE,
		sub: "repo:acme/app:ref:refs/heads/main",
		repository: "acme/app",
		jti: "jti-1",
		iat: NOW / 1000 - 10,
		nbf: NOW / 1000 - 10,
		exp: NOW / 1000 + 300,
	};
	return { rsa, ec, fetched, fakeFetch, claims };
}

describe("OIDC assertions", () => {
	it("verifies RS256 and ES256 tokens from a pinned issuer with cached keys", async () => {
		const p = provider();
		const verifier = createIdentityAssertionVerifier({
			issuers: [{ issuer: ISSUER }],
			fetch: p.fakeFetch,
			now: () => NOW,
		});
		const rs = await verifier.verifyOidc(
			jwt({ alg: "RS256", kid: "rsa-1" }, p.claims, p.rsa.privateKey),
			AUDIENCE,
		);
		expect(rs).toEqual({
			ok: true,
			value: {
				issuer: ISSUER,
				subject: "repo:acme/app:ref:refs/heads/main",
				tokenId: "jti-1",
				claims: expect.objectContaining({
					repository: "acme/app",
					aud: AUDIENCE,
				}),
			},
		});
		const es = await verifier.verifyOidc(
			jwt({ alg: "ES256", kid: "ec-1" }, p.claims, p.ec.privateKey, true),
			AUDIENCE,
		);
		expect(es.ok).toBe(true);
		expect(p.fetched).toHaveLength(2); // discovery and JWKS once
	});

	it("refuses an unpinned issuer, another audience, an expired token, a forged signature and alg none", async () => {
		const p = provider();
		const verifier = createIdentityAssertionVerifier({
			issuers: [{ issuer: ISSUER, jwksUri: `${ISSUER}/.well-known/jwks` }],
			fetch: p.fakeFetch,
			now: () => NOW,
		});
		const forged = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const cases = [
			jwt(
				{ alg: "RS256", kid: "rsa-1" },
				{ ...p.claims, iss: "https://evil.example" },
				p.rsa.privateKey,
			),
			jwt(
				{ alg: "RS256", kid: "rsa-1" },
				{ ...p.claims, aud: "https://other" },
				p.rsa.privateKey,
			),
			jwt(
				{ alg: "RS256", kid: "rsa-1" },
				{ ...p.claims, exp: NOW / 1000 - 120 },
				p.rsa.privateKey,
			),
			jwt({ alg: "RS256", kid: "rsa-1" }, p.claims, forged.privateKey),
			`${Buffer.from(JSON.stringify({ alg: "none", kid: "rsa-1" })).toString("base64url")}.${Buffer.from(JSON.stringify(p.claims)).toString("base64url")}.`,
			jwt({ alg: "HS256", kid: "rsa-1" }, p.claims, p.rsa.privateKey),
		];
		for (const assertion of cases)
			expect((await verifier.verifyOidc(assertion, AUDIENCE)).ok).toBe(false);
	});

	it("re-reads the JWKS for an unknown kid at most once a minute", async () => {
		const p = provider();
		let now = NOW;
		const verifier = createIdentityAssertionVerifier({
			issuers: [{ issuer: ISSUER, jwksUri: `${ISSUER}/.well-known/jwks` }],
			fetch: p.fakeFetch,
			now: () => now,
		});
		const unknown = jwt(
			{ alg: "RS256", kid: "rsa-9" },
			p.claims,
			p.rsa.privateKey,
		);
		await verifier.verifyOidc(unknown, AUDIENCE);
		await verifier.verifyOidc(unknown, AUDIENCE);
		expect(p.fetched).toHaveLength(1);
		now += 61_000;
		await verifier.verifyOidc(unknown, AUDIENCE);
		expect(p.fetched).toHaveLength(2);
	});
});

describe("X.509 chains", () => {
	const dir = join(import.meta.dirname, "../fixtures/x509");
	const pem = (name: string) => readFileSync(join(dir, name), "utf8");
	const leaf = new X509Certificate(pem("leaf.pem"));
	const identityJwk = JSON.stringify(leaf.publicKey.export({ format: "jwk" }));
	const verifier = createIdentityAssertionVerifier({
		issuers: [],
		fetch,
		now: () => NOW,
	});

	it("accepts a chain to a root whose leaf is the identity key", () => {
		const outcome = verifier.verifyCertificateChain({
			chainPem: [pem("leaf.pem"), pem("intermediate.pem")],
			identityJwk,
			rootsPem: [pem("root.pem")],
			nowMs: NOW,
		});
		expect(outcome).toEqual({
			ok: true,
			value: { digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) },
		});
	});

	it("refuses another root, a missing intermediate, another key and an expired chain", () => {
		const base = {
			chainPem: [pem("leaf.pem"), pem("intermediate.pem")],
			identityJwk,
			rootsPem: [pem("root.pem")],
			nowMs: NOW,
		};
		const other = generateKeyPairSync("ec", {
			namedCurve: "P-256",
		}).publicKey.export({ format: "jwk" });
		for (const input of [
			{ ...base, rootsPem: [pem("other-root.pem")] },
			{ ...base, chainPem: [pem("leaf.pem")] },
			{ ...base, identityJwk: JSON.stringify(other) },
			{ ...base, nowMs: Date.parse("2200-01-01T00:00:00Z") },
			{ ...base, rootsPem: [] },
		])
			expect(verifier.verifyCertificateChain(input).ok).toBe(false);
	});
});
