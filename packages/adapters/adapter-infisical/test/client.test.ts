import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createInfisicalClient,
	type InfisicalAuth,
	InfisicalError,
	oidcAuth,
	parseInfisicalBinding,
} from "../src/index.js";
import {
	createFakeInfisical,
	type FakeInfisical,
	fakeJwt,
} from "./support/fake-infisical.js";

const IDENTITY = "11111111-2222-4333-8444-555555555555";
const scope = {
	projectId: "proj-1",
	environment: "prod",
	secretPath: "/hobo-ci-relay",
};

let fake: FakeInfisical;
let server: { url: string; close: () => Promise<void> };
let clock: number;
let sleeps: number[];
let jwtCalls: number;
const JWT = fakeJwt("owner:acme:project:hobo-ci:environment:production");

beforeEach(async () => {
	fake = createFakeInfisical();
	fake.identities.push({
		kind: "oidc",
		identityId: IDENTITY,
		jwt: JWT,
		access: "read",
	});
	server = await fake.listen();
	clock = 1_000_000;
	sleeps = [];
	jwtCalls = 0;
});

afterEach(async () => {
	await server.close();
});

function client(
	auth: InfisicalAuth = oidcAuth({
		identityId: IDENTITY,
		jwt: async () => {
			jwtCalls++;
			return JWT;
		},
	}),
	retry = {},
) {
	return createInfisicalClient({
		binding: parseInfisicalBinding({ siteUrl: server.url, ...scope }),
		auth,
		now: () => clock,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		retry,
	});
}

function logins() {
	return fake.requests.filter((request) => request.path.includes("/auth/"))
		.length;
}

async function caught(promise: Promise<unknown>): Promise<InfisicalError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof InfisicalError) return error;
		throw error;
	}
	throw new Error("expected an InfisicalError");
}

describe("OIDC login and reads", () => {
	it("logs in with the workload JWT and lists the folder in one request", async () => {
		fake.seed(scope, "HOBO_CI_PUBLIC_URL", "https://ci.example.com");
		fake.seed(scope, "CRON_SECRET", "c".repeat(40));
		const secrets = await client().listSecrets();
		expect(
			Object.fromEntries(secrets.map((s) => [s.secretKey, s.value])),
		).toEqual({
			HOBO_CI_PUBLIC_URL: "https://ci.example.com",
			CRON_SECRET: "c".repeat(40),
		});
		const list = fake.requests.find((r) =>
			r.path.startsWith("/api/v4/secrets"),
		);
		expect(list?.path).toBe(
			"/api/v4/secrets?projectId=proj-1&environment=prod&secretPath=%2Fhobo-ci-relay&viewSecretValue=true&recursive=false&expandSecretReferences=false&includeImports=false",
		);
		expect(list?.authorized).toBe(true);
		const login = fake.requests[0];
		expect(login?.path).toBe("/api/v1/auth/oidc-auth/login");
		expect(login?.body).toEqual({ identityId: IDENTITY, jwt: JWT });
	});

	it("caches the access token until shortly before it expires", async () => {
		fake.expiresIn = 120;
		const c = client();
		await c.listSecrets();
		clock += 100_000;
		await c.listSecrets();
		expect(logins()).toBe(1);
		// A tenth of the lifetime (12 s) before expiry it signs in again.
		clock += 9_000;
		await c.listSecrets();
		expect(logins()).toBe(2);
		expect(jwtCalls).toBe(2);
	});

	it("shares one login between concurrent requests", async () => {
		const c = client();
		await Promise.all([c.listSecrets(), c.listSecrets(), c.listSecrets()]);
		expect(logins()).toBe(1);
	});

	it("signs in again once when the server has expired the token", async () => {
		const c = client();
		await c.listSecrets();
		fake.revokeTokens();
		await c.listSecrets();
		expect(logins()).toBe(2);
	});

	it("gives up as unauthorized when a fresh token is refused too", async () => {
		const c = client();
		fake.fail(
			(r) => r.path.startsWith("/api/v4/secrets"),
			{ status: 401, body: { reqId: "r1", message: "nope" } },
			2,
		);
		const error = await caught(c.listSecrets());
		expect(error.code).toBe("unauthorized");
		expect(logins()).toBe(2);
	});

	it("does not retry 403 and names it forbidden", async () => {
		fake.fail((r) => r.path.startsWith("/api/v4/secrets"), {
			status: 403,
			body: { reqId: "req-403", message: "Permission denied" },
		});
		const error = await caught(client().listSecrets());
		expect(error.code).toBe("forbidden");
		expect(error.reqId).toBe("req-403");
		expect(sleeps).toEqual([]);
	});

	it("retries 429 honouring Retry-After, capped", async () => {
		fake.fail(
			(r) => r.path.startsWith("/api/v4/secrets"),
			{ status: 429, headers: { "retry-after": "2" }, body: {} },
			2,
		);
		await client(undefined, { maxDelayMs: 1500 }).listSecrets();
		expect(sleeps).toEqual([1500, 1500]);
	});

	it("stops after the retry budget and reports rate-limited", async () => {
		fake.fail(
			(r) => r.path.startsWith("/api/v4/secrets"),
			{ status: 429, body: {} },
			10,
		);
		const error = await caught(
			client(undefined, { attempts: 3 }).listSecrets(),
		);
		expect(error.code).toBe("rate-limited");
		expect(sleeps).toEqual([250, 500]);
	});

	it("retries 5xx with exponential backoff and reports unavailable", async () => {
		fake.fail(
			(r) => r.path.startsWith("/api/v4/secrets"),
			{ status: 503, body: {} },
			10,
		);
		const error = await caught(
			client(undefined, { attempts: 4 }).listSecrets(),
		);
		expect(error.code).toBe("unavailable");
		expect(sleeps).toEqual([250, 500, 1000]);
	});

	it("recovers when a 5xx clears within the budget", async () => {
		fake.seed(scope, "A", "1");
		fake.fail((r) => r.path.startsWith("/api/v4/secrets"), {
			status: 502,
			body: {},
		});
		expect((await client().listSecrets()).length).toBe(1);
	});

	it("treats an unreachable server as unavailable", async () => {
		const c = client(undefined, { attempts: 2 });
		await server.close();
		const error = await caught(c.listSecrets());
		expect(error.code).toBe("unavailable");
		server = await fake.listen();
	});

	it("refuses a login without retrying it", async () => {
		const error = await caught(
			client(
				oidcAuth({
					identityId: IDENTITY,
					jwt: async () => fakeJwt("someone-else"),
				}),
			).listSecrets(),
		);
		expect(error.code).toBe("login-denied");
		expect(logins()).toBe(1);
	});

	it("reports a missing workload token as jwt-unavailable", async () => {
		const error = await caught(
			client(
				oidcAuth({
					identityId: IDENTITY,
					jwt: async () => {
						throw new Error("no x-vercel-oidc-token header");
					},
				}),
			).listSecrets(),
		);
		expect(error.code).toBe("jwt-unavailable");
		expect(logins()).toBe(0);
	});

	it("refuses a secret whose value the identity may not view", async () => {
		fake.seed(scope, "HIDDEN", "x", { hidden: true });
		expect((await caught(client().getSecret("HIDDEN"))).code).toBe(
			"value-hidden",
		);
	});

	it("reads a named secret and an older version", async () => {
		fake.seed(scope, "KEY", "one");
		fake.seed(scope, "KEY", "two");
		const c = client();
		expect(await c.getSecret("KEY")).toMatchObject({
			value: "two",
			version: 2,
		});
		expect(await c.getSecret("KEY", 1)).toMatchObject({
			value: "one",
			version: 1,
		});
		expect((await caught(c.getSecret("MISSING"))).code).toBe("not-found");
		expect((await caught(c.getSecret("../x"))).code).toBe("invalid-input");
	});

	it("rejects a 2xx answer that is not the documented shape", async () => {
		fake.fail((r) => r.path.startsWith("/api/v4/secrets"), {
			status: 200,
			body: { secrets: [{ secretKey: 7 }] },
		});
		expect((await caught(client().listSecrets())).code).toBe(
			"invalid-response",
		);
	});
});

describe("writes", () => {
	beforeEach(() => {
		fake.identities.push({
			kind: "universal-auth",
			clientId: "owner-client",
			clientSecret: "owner-client-secret-value",
			access: "write",
		});
	});

	const writer: InfisicalAuth = {
		method: "universal-auth",
		clientId: "owner-client",
		clientSecret: "owner-client-secret-value",
	};

	it("creates a missing secret and updates an existing one", async () => {
		const c = client(writer);
		expect(await c.putSecret("HOBO_CI_GITHUB_APP_ID", "123")).toEqual({
			version: 1,
		});
		expect(await c.putSecret("HOBO_CI_GITHUB_APP_ID", "456")).toEqual({
			version: 2,
		});
		expect(fake.value(scope, "HOBO_CI_GITHUB_APP_ID")).toBe("456");
		expect(
			fake.requests
				.filter((r) => r.path.startsWith("/api/v4/"))
				.map((r) => r.method),
		).toEqual(["PATCH", "POST", "PATCH"]);
		expect(
			fake.requests.find((r) => r.method === "POST" && r.path.includes("/v4/"))
				?.body,
		).toEqual({
			projectId: "proj-1",
			environment: "prod",
			secretPath: "/hobo-ci-relay",
			secretValue: "123",
			type: "shared",
		});
	});

	it("is refused for a read-only identity", async () => {
		expect((await caught(client().putSecret("X", "y"))).code).toBe("forbidden");
	});

	it("reports a secret-protection approval instead of claiming success", async () => {
		fake.fail((r) => r.method === "PATCH", {
			status: 200,
			body: { approval: { id: "a1", policyId: "p", slug: "s" } },
		});
		expect((await caught(client(writer).putSecret("X", "y"))).code).toBe(
			"approval-required",
		);
	});

	it("accepts an access token the Infisical CLI already issued", async () => {
		const token = fake.tokenFor("write");
		await client({ method: "access-token", accessToken: token }).putSecret(
			"K",
			"v",
		);
		expect(logins()).toBe(0);
	});
});

describe("redaction", () => {
	it("never puts the JWT, the access token or a value in an error", async () => {
		fake.seed(scope, "SECRET", "value-that-must-not-leak");
		const c = client();
		await c.listSecrets();
		const token = fake.issuedTokens[0] ?? "";
		fake.fail(
			(r) => r.path.startsWith("/api/v4/secrets"),
			{
				status: 400,
				body: {
					reqId: "req-1",
					message: `echo ${token} ${JWT} value-that-must-not-leak`,
				},
			},
			5,
		);
		const errors = [
			await caught(c.listSecrets()),
			await caught(c.getSecret("SECRET")),
		];
		for (const error of errors) {
			const rendered = `${error.message} ${String(error)} ${JSON.stringify(error)} ${error.stack}`;
			expect(rendered).not.toContain(token);
			expect(rendered).not.toContain(JWT);
			expect(rendered).not.toContain("value-that-must-not-leak");
		}
		expect(token).not.toBe("");
	});
});
