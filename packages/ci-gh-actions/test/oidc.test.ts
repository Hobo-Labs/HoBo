import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGithubOidcVerifier, type GithubClaims } from "../src/oidc.js";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const SECONDS = NOW / 1000;
const AUDIENCE = "https://relay.example";
const KID = "consumer-generated-rsa-key";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const jwks = JSON.stringify({
	keys: [
		{
			...publicKey.export({ format: "jwk" }),
			kid: KID,
			alg: "RS256",
			use: "sig",
		},
	],
});
const validClaims: GithubClaims = {
	iss: "https://token.actions.githubusercontent.com",
	aud: AUDIENCE,
	exp: SECONDS + 300,
	nbf: SECONDS - 30,
	iat: SECONDS - 30,
	repository_id: "101",
	repository: "org/repo",
	run_id: "22",
	run_attempt: "1",
	workflow_sha: "a".repeat(40),
	workflow_ref: "org/repo/.github/workflows/host.yml@refs/tags/hobo-ci-v1",
	event_name: "workflow_dispatch",
};

function token(
	claimsText = JSON.stringify(validClaims),
	headerText = JSON.stringify({ alg: "RS256", kid: KID }),
): string {
	const header = Buffer.from(headerText).toString("base64url");
	const payload = Buffer.from(claimsText).toString("base64url");
	const input = `${header}.${payload}`;
	const signature = sign("RSA-SHA256", Buffer.from(input), privateKey).toString(
		"base64url",
	);
	return `${input}.${signature}`;
}

function verifier(status = 200, body = jwks) {
	const requests: Parameters<typeof fetch>[] = [];
	const send: typeof fetch = async (input, init) => {
		requests.push([input, init]);
		expect(String(input)).toBe(
			"https://token.actions.githubusercontent.com/.well-known/jwks",
		);
		expect(init?.redirect).toBe("error");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.signal?.aborted).toBe(false);
		expect(new Headers(init?.headers).has("authorization")).toBe(false);
		return new Response(body, {
			status,
			headers: { "Content-Type": "application/json" },
		});
	};
	return {
		identity: createGithubOidcVerifier(AUDIENCE, send, () => NOW),
		requests,
	};
}

describe("GitHub OIDC cryptographic verification", () => {
	it("verifies a real RSA signature against the pinned JWKS and returns claims", async () => {
		const v = verifier();
		await expect(v.identity.verify(token())).resolves.toEqual(validClaims);
		expect(v.requests).toHaveLength(1);
	});

	it("rejects an altered signature", async () => {
		const original = token();
		const separator = original.lastIndexOf(".");
		const signature = Buffer.from(original.slice(separator + 1), "base64url");
		signature[0] = (signature[0] ?? 0) ^ 1;
		const altered = `${original.slice(0, separator + 1)}${signature.toString("base64url")}`;
		const v = verifier();
		await expect(v.identity.verify(altered)).rejects.toThrow(
			"invalid identity signature",
		);
		expect(v.requests).toHaveLength(1);
	});

	it("rejects altered claims even when the old signature is retained", async () => {
		const original = token();
		const [header, , signature] = original.split(".");
		const alteredClaims = Buffer.from(
			JSON.stringify({ ...validClaims, repository_id: "999" }),
		).toString("base64url");
		const v = verifier();
		await expect(
			v.identity.verify(`${header}.${alteredClaims}.${signature}`),
		).rejects.toThrow("invalid identity signature");
	});

	it.each([
		["wrong audience", { ...validClaims, aud: "https://other-relay.example" }],
		["expired token", { ...validClaims, exp: SECONDS - 1 }],
		["expiration at the current second", { ...validClaims, exp: SECONDS }],
		["future not-before", { ...validClaims, nbf: SECONDS + 31 }],
		["future issued-at", { ...validClaims, iat: SECONDS + 31 }],
		[
			"issued-at older than ten minutes",
			{ ...validClaims, iat: SECONDS - 601 },
		],
	])("rejects %s after cryptographic verification", async (_name, claims) => {
		const v = verifier();
		await expect(
			v.identity.verify(token(JSON.stringify(claims))),
		).rejects.toThrow("identity audience or lifetime invalid");
		expect(v.requests).toHaveLength(1);
	});

	it.each([
		["issuer", { ...validClaims, iss: "https://issuer.invalid" }],
		["event", { ...validClaims, event_name: "pull_request" }],
		["repository identifier", { ...validClaims, repository_id: "not-an-id" }],
		["workflow commit", { ...validClaims, workflow_sha: "main" }],
	])("rejects an invalid %s claim", async (_name, claims) => {
		const v = verifier();
		await expect(
			v.identity.verify(token(JSON.stringify(claims))),
		).rejects.toMatchObject({ name: "ZodError" });
		expect(v.requests).toHaveLength(1);
	});

	it.each([
		"none",
		"HS256",
		"RS512",
	])("rejects token algorithm %s before fetching keys", async (alg) => {
		const v = verifier();
		await expect(
			v.identity.verify(token(undefined, JSON.stringify({ alg, kid: KID }))),
		).rejects.toMatchObject({ name: "ZodError" });
		expect(v.requests).toHaveLength(0);
	});

	it("rejects an unknown key identifier", async () => {
		const v = verifier();
		await expect(
			v.identity.verify(
				token(undefined, JSON.stringify({ alg: "RS256", kid: "unknown" })),
			),
		).rejects.toThrow("invalid identity signature");
		expect(v.requests).toHaveLength(1);
	});

	it("ignores a JWT-provided key URL and fetches only GitHub's pinned JWKS", async () => {
		const v = verifier();
		const signed = token(
			undefined,
			JSON.stringify({
				alg: "RS256",
				kid: KID,
				jku: "https://attacker.invalid/jwks",
				x5u: "https://attacker.invalid/key.pem",
			}),
		);
		await expect(v.identity.verify(signed)).resolves.toEqual(validClaims);
		expect(v.requests).toHaveLength(1);
	});

	it("accepts exactly the configured thirty-second future skew", async () => {
		const v = verifier();
		const claims = { ...validClaims, nbf: SECONDS + 30, iat: SECONDS + 30 };
		await expect(
			v.identity.verify(token(JSON.stringify(claims))),
		).resolves.toEqual(claims);
	});

	it("accepts a token issued exactly ten minutes ago", async () => {
		const v = verifier();
		const claims = { ...validClaims, iat: SECONDS - 600 };
		await expect(
			v.identity.verify(token(JSON.stringify(claims))),
		).resolves.toEqual(claims);
	});

	it("fails closed when JWKS is unavailable", async () => {
		const v = verifier(503);
		await expect(v.identity.verify(token())).rejects.toThrow(
			"identity keys unavailable",
		);
		expect(v.requests).toHaveLength(1);
	});

	it("fails closed when JWKS contains no matching signing key", async () => {
		const v = verifier(200, JSON.stringify({ keys: [] }));
		await expect(v.identity.verify(token())).rejects.toThrow(
			"invalid identity signature",
		);
	});

	it("rejects malformed JWKS instead of accepting unverified claims", async () => {
		const v = verifier(200, JSON.stringify({ keys: [{ kid: KID }] }));
		await expect(v.identity.verify(token())).rejects.toMatchObject({
			name: "ZodError",
		});
	});

	it("propagates a Fetch redirect refusal without trying a second destination", async () => {
		let requests = 0;
		const send: typeof fetch = async (input, init) => {
			requests += 1;
			expect(String(input)).toBe(
				"https://token.actions.githubusercontent.com/.well-known/jwks",
			);
			expect(init?.redirect).toBe("error");
			throw new TypeError("fixture fetch refused JWKS redirect");
		};
		const identity = createGithubOidcVerifier(AUDIENCE, send, () => NOW);
		await expect(identity.verify(token())).rejects.toMatchObject({
			name: "TypeError",
			message: "fixture fetch refused JWKS redirect",
		});
		expect(requests).toBe(1);
	});

	it.each([
		"",
		"a.b",
		"a.b.c.d",
		"a..c",
		"x".repeat(16001),
	])("rejects malformed or oversized token before key discovery (%#)", async (invalid) => {
		const v = verifier();
		await expect(v.identity.verify(invalid)).rejects.toThrow(
			"invalid identity",
		);
		expect(v.requests).toHaveLength(0);
	});
});
