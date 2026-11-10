import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { AccountSchema, OfferSchema } from "@hobo/ci";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createFleetRoutePublisher } from "../src/fleet-routes.js";
import {
	createGithubAppTransport,
	type GithubTransport,
} from "../src/github.js";

const Interaction = z.object({
	description: z.string(),
	request: z.object({
		method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
		path: z.string(),
		headers: z.record(z.string(), z.string()),
		body: z.json().optional(),
	}),
	response: z.object({
		status: z.number().int(),
		headers: z.record(z.string(), z.string()).optional(),
		body: z.json().optional(),
	}),
});
const pact = z
	.object({
		consumer: z.object({ name: z.literal("HoboCiGhActions") }),
		provider: z.object({ name: z.literal("GithubActionsRestApi") }),
		metadata: z.object({
			pactSpecification: z.object({ version: z.literal("3.0.0") }),
			consumerFixtures: z.object({
				appId: z.string(),
				installationId: z.number().int(),
				nowMilliseconds: z.number(),
				appJwtClaims: z.object({
					iat: z.number(),
					exp: z.number(),
					iss: z.string(),
				}),
			}),
		}),
		interactions: z.array(Interaction),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL("./github-app-boundary.pact.json", import.meta.url),
				"utf8",
			),
		),
	);

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const fixtures = pact.metadata.consumerFixtures;
const exercised = new Set<string>();

function interaction(description: string): z.infer<typeof Interaction> {
	const match = pact.interactions.find(
		(candidate) => candidate.description === description,
	);
	if (!match) throw new Error(`missing pact interaction: ${description}`);
	return match;
}

function assertSignedAppJwt(authorization: string | null): void {
	if (!authorization?.startsWith("Bearer "))
		throw new Error("App JWT authorization missing");
	const parts = authorization.slice(7).split(".");
	const [header, payload, signature] = parts;
	if (parts.length !== 3 || !header || !payload || !signature)
		throw new Error("App JWT must have three segments");
	expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
		alg: "RS256",
		typ: "JWT",
	});
	expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual(
		fixtures.appJwtClaims,
	);
	expect(
		verify(
			"RSA-SHA256",
			Buffer.from(`${header}.${payload}`),
			publicKey,
			Buffer.from(signature, "base64url"),
		),
	).toBe(true);
}

/** The artifact supplies every API request and response; no secondary wire fixtures. */
function contractTransport(...sequence: z.infer<typeof Interaction>[]) {
	let calls = 0;
	const send: typeof fetch = async (input, init) => {
		const expected = sequence[calls];
		calls += 1;
		if (!expected) throw new Error("unexpected GitHub request");
		exercised.add(expected.description);
		expect(String(input)).toBe(
			`https://api.github.com${expected.request.path}`,
		);
		expect(init?.method).toBe(expected.request.method);
		expect(init?.redirect).toBe("error");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.signal?.aborted).toBe(false);
		const headers = new Headers(init?.headers);
		expect([...headers.keys()].sort()).toEqual(
			Object.keys(expected.request.headers)
				.map((name) => name.toLowerCase())
				.sort(),
		);
		for (const [name, value] of Object.entries(expected.request.headers)) {
			if (name === "Authorization" && value === "Bearer signed.app.jwt") {
				assertSignedAppJwt(headers.get(name));
			} else {
				expect(headers.get(name)).toBe(value);
			}
		}
		expect(init?.body).toBe(
			expected.request.body === undefined
				? undefined
				: JSON.stringify(expected.request.body),
		);
		// Fetch's redirect statuses; a 304 is an ordinary response.
		if ([301, 302, 303, 307, 308].includes(expected.response.status)) {
			// Model Fetch's redirect:error rejection; no redirected request is issued.
			throw new TypeError("fixture fetch refused redirect");
		}
		return new Response(
			expected.response.body === undefined
				? null
				: JSON.stringify(expected.response.body),
			{
				status: expected.response.status,
				headers: expected.response.headers ?? {},
			},
		);
	};
	const transport = createGithubAppTransport({
		appId: fixtures.appId,
		privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		fetch: send,
		now: () => fixtures.nowMilliseconds,
	});
	return { transport, calls: () => calls };
}

function request(
	transport: GithubTransport,
	expected: z.infer<typeof Interaction>,
) {
	return transport.request(
		fixtures.installationId,
		expected.request.path,
		expected.request.method,
		expected.request.body === undefined
			? undefined
			: JSON.stringify(expected.request.body),
	);
}

const exchange = interaction("exchange signed App JWT for installation token");
const dispatch = interaction(
	"dispatch a provider host workflow using the configured bridge ref",
);
const registration = interaction(
	"register one repository scoped JIT runner with the hobo label",
);

afterAll(() => {
	expect([...exercised].sort()).toEqual(
		pact.interactions.map((entry) => entry.description).sort(),
	);
});

describe("hand-authored GitHub App REST consumer contract", () => {
	it("signs a time-bounded App JWT and dispatches with the installation token", async () => {
		const api = contractTransport(exchange, dispatch);
		const response = await request(api.transport, dispatch);
		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(api.calls()).toBe(2);
	});

	it("forwards the exact JIT registration payload and returns its encoded config", async () => {
		const api = contractTransport(exchange, registration);
		const response = await request(api.transport, registration);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual(registration.response.body);
		expect(api.calls()).toBe(2);
	});

	it("sends If-None-Match on a GET and hands back the 304, but never on a write", async () => {
		const conditional = interaction(
			"re-read an unchanged job list conditionally and get 304 Not Modified",
		);
		const etag = conditional.request.headers["If-None-Match"];
		const api = contractTransport(exchange, conditional, exchange, dispatch);
		const response = await api.transport.request(
			fixtures.installationId,
			conditional.request.path,
			"GET",
			undefined,
			etag,
		);
		expect(response.status).toBe(304);
		expect(response.headers.get("etag")).toBe(etag);
		// The dispatch interaction pins its exact header set, so a leaked
		// If-None-Match on the POST fails here.
		const write = await api.transport.request(
			fixtures.installationId,
			dispatch.request.path,
			"POST",
			JSON.stringify(dispatch.request.body),
			etag,
		);
		expect(write.status).toBe(204);
		expect(api.calls()).toBe(4);
	});

	it("stops before the API operation when App authentication fails", async () => {
		const rejected = interaction(
			"refuse installation token exchange when App authentication fails",
		);
		const api = contractTransport(rejected);
		await expect(request(api.transport, dispatch)).rejects.toThrow(
			"GitHub App authentication failed (401)",
		);
		expect(api.calls()).toBe(1);
	});

	it("rejects a malformed successful exchange without sending an empty credential", async () => {
		const malformed = interaction(
			"reject a successful installation exchange without a usable token",
		);
		const api = contractTransport(malformed);
		await expect(request(api.transport, dispatch)).rejects.toMatchObject({
			name: "ZodError",
			issues: [expect.objectContaining({ path: ["token"] })],
		});
		expect(api.calls()).toBe(1);
	});

	it.each([
		"return provider host dispatch authorization failure to the caller",
		"return JIT registration validation failure to the caller",
	])("%s", async (description) => {
		const rejected = interaction(description);
		const api = contractTransport(exchange, rejected);
		const response = await request(api.transport, rejected);
		expect(response.ok).toBe(false);
		expect(response.status).toBe(rejected.response.status);
		expect(await response.json()).toEqual(rejected.response.body);
		expect(api.calls()).toBe(2);
	});

	it.each([
		"refuse a redirect during the App token exchange",
		"refuse a redirect when dispatching the host workflow",
	])("%s", async (description) => {
		const redirect = interaction(description);
		const isExchange = redirect.request.path === exchange.request.path;
		const api = isExchange
			? contractTransport(redirect)
			: contractTransport(exchange, redirect);
		await expect(request(api.transport, dispatch)).rejects.toMatchObject({
			name: "TypeError",
			message: "fixture fetch refused redirect",
		});
		expect(api.calls()).toBe(isExchange ? 1 : 2);
	});

	describe("fleet route table variable", () => {
		const repository = interaction(
			"read the repository's visibility and owner type before routing",
		);
		const update = interaction(
			"update the fleet route table repository variable",
		);
		const routes = () => ({
			installationId: fixtures.installationId,
			repository: repository.request.path.slice("/repos/".length),
			account: create(AccountSchema, {
				id: "hobo-fixture",
				budgetMicros: 1_000_000,
				maxRuntimeMinutes: 19,
				startupMinutes: 1,
				offers: [
					create(OfferSchema, {
						id: "box",
						provider: "hobo-box-worker",
						providerAccountId: "box",
						enabled: true,
						runsOn: "hobo-isolated-worker",
						backend: "isolated-container",
						concurrency: 2,
						observedAt: "2026-11-09T00:00:00Z",
						validUntil: "2026-12-09T00:00:00Z",
						sourceUrl: "https://example.test/rates",
						bridgeAcknowledged: true,
					}),
				],
			}),
			leases: async () => [],
			isolatedOnly: true,
			at: "2026-11-10T00:00:00Z",
		});

		it("reads the repository and updates the variable with the published table", async () => {
			// The transport exchanges an installation token for every request.
			const api = contractTransport(exchange, repository, exchange, update);
			const publisher = createFleetRoutePublisher({ github: api.transport });
			const result = await publisher.publish(routes());
			expect(result?.outcome).toBe("published");
			expect(result?.value).toBe(
				z.object({ value: z.string() }).parse(update.request.body).value,
			);
			expect(api.calls()).toBe(4);
		});

		it("creates the variable when the update reports it missing", async () => {
			const api = contractTransport(
				exchange,
				repository,
				exchange,
				interaction("report a missing fleet route table repository variable"),
				exchange,
				interaction("create the fleet route table repository variable"),
			);
			const publisher = createFleetRoutePublisher({ github: api.transport });
			expect((await publisher.publish(routes()))?.outcome).toBe("published");
			expect(api.calls()).toBe(6);
		});

		it("reports a refused write without retrying it", async () => {
			const api = contractTransport(
				exchange,
				repository,
				exchange,
				interaction(
					"refuse the fleet route table write without Variables permission",
				),
			);
			const publisher = createFleetRoutePublisher({ github: api.transport });
			expect((await publisher.publish(routes()))?.outcome).toBe("failed");
			expect(api.calls()).toBe(4);
		});
	});

	it("rejects malformed API paths before signing or sending credentials", async () => {
		const api = contractTransport();
		for (const path of [
			"https://redirect.invalid/token",
			"/repos/org/repo/../other/actions/runs/1",
			"/repos/org/repo/actions/%2fsecrets",
		]) {
			await expect(
				api.transport.request(fixtures.installationId, path),
			).rejects.toThrow("invalid GitHub API path");
		}
		expect(api.calls()).toBe(0);
	});
});
