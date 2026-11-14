import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGithubWorkflowVerifier } from "../src/workflow-oidc.js";

const AUDIENCE = "https://ci.hobo.test";
const NOW = Date.parse("2026-11-12T16:00:00Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const jwk = publicKey.export({ format: "jwk" });
const jwks = { keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] };

function token(
	claims: Readonly<Record<string, string | number | readonly string[]>> = {},
	header: Readonly<Record<string, string>> = {},
	key = privateKey,
) {
	const encode = (
		value: Readonly<Record<string, string | number | readonly string[]>>,
	) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const seconds = Math.floor(NOW / 1000);
	const head = encode({ alg: "RS256", kid: "k1", typ: "JWT", ...header });
	const body = encode({
		iss: "https://token.actions.githubusercontent.com",
		aud: AUDIENCE,
		exp: seconds + 300,
		nbf: seconds - 5,
		iat: seconds - 5,
		repository: "Hobo-Labs/HoBo",
		repository_id: "101",
		event_name: "schedule",
		run_id: "43207388098",
		...claims,
	});
	const signature = sign(
		"RSA-SHA256",
		Buffer.from(`${head}.${body}`),
		key,
	).toString("base64url");
	return `${head}.${body}.${signature}`;
}

function verifier(fetched: string[] = []) {
	return createGithubWorkflowVerifier({
		audience: AUDIENCE,
		now: () => NOW,
		fetch: async (url) => {
			fetched.push(String(url));
			return Response.json(jwks);
		},
	});
}

describe("a GitHub Actions workflow token", () => {
	it("names the repository asking, for any event, with keys only from GitHub", async () => {
		const fetched: string[] = [];
		for (const event of ["schedule", "workflow_dispatch", "push"])
			expect(
				await verifier(fetched).verify(token({ event_name: event })),
			).toEqual({
				repository: "Hobo-Labs/HoBo",
				repositoryId: "101",
				eventName: event,
				runId: "43207388098",
			});
		expect(new Set(fetched)).toEqual(
			new Set(["https://token.actions.githubusercontent.com/.well-known/jwks"]),
		);
	});

	it("is refused for another audience, issuer, lifetime, key or shape", async () => {
		const seconds = Math.floor(NOW / 1000);
		const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
		for (const bad of [
			token({ aud: "https://hobo-ci.vercel.app" }),
			token({ aud: [AUDIENCE, "https://elsewhere.example"] }),
			token({ iss: "https://token.example" }),
			token({ exp: seconds }),
			token({ nbf: seconds + 60 }),
			token({ iat: seconds - 601 }),
			token({ repository: "not a repository" }),
			token({}, { kid: "unknown" }),
			token({}, { alg: "none" }),
			token({}, {}, other.privateKey),
			"a.b",
			"",
			`${"a".repeat(16001)}`,
		])
			await expect(verifier().verify(bad)).rejects.toThrow();
	});

	it("is refused when GitHub's keys cannot be read", async () => {
		const failing = createGithubWorkflowVerifier({
			audience: AUDIENCE,
			now: () => NOW,
			fetch: async () => new Response("", { status: 503 }),
		});
		await expect(failing.verify(token())).rejects.toThrow(
			"identity keys unavailable",
		);
	});
});
