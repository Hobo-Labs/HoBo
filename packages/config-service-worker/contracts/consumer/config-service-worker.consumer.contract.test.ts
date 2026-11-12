/**
 * Consumer side: the client the relay's loader, HoBo's provisioning and the
 * deploy workflow use, against a mock built from the pact. Every request the
 * client makes must be one the pact records, with the headers it names.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMockProviderFromPact,
	loadPactDirectory,
	type PactDocument,
	type PactRequest,
} from "@hobo/contract-harness";
import { beforeAll, describe, expect, it } from "vitest";
import {
	ConfigServiceClientError,
	createConfigServiceClient,
} from "../../src/index.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const METHODS = ["GET", "POST", "PATCH"] as const;
// Placeholders, the same ones the pact names: never real tokens.
const TOKENS = {
	"vercel-relay": "{vercel-relay}",
	"github-deploy": "{github-deploy}",
	bootstrap: "{bootstrap}",
};

let pact: PactDocument;
const seen: PactRequest[] = [];

beforeAll(async () => {
	const found = (
		await loadPactDirectory(path.join(contractsDir, "pacts"))
	).find((candidate) => candidate.provider.name === "HoboConfigServiceWorker");
	if (!found) throw new Error("the config-service Worker pact is missing");
	pact = found;
});

function mockFetch(): typeof fetch {
	const mock = createMockProviderFromPact(pact);
	return async (input, init) => {
		const url = new URL(String(input));
		const method = METHODS.find(
			(candidate) => candidate === (init?.method ?? "GET"),
		);
		if (method === undefined) return new Response(null, { status: 405 });
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		const request: PactRequest = {
			method,
			path: `${url.pathname}${url.search}`,
			headers,
			...(init?.body ? { body: JSON.parse(String(init.body)) } : undefined),
		};
		seen.push(request);
		const response = await mock.handle(request);
		return new Response(
			response.body === undefined ? null : JSON.stringify(response.body),
			{
				status: response.status,
				headers: response.headers,
			},
		);
	};
}

describe("the relay, provisioning and the deploy workflow ⇄ the config-service Worker (consumer)", () => {
	it("makes only the requests the pact records, with the headers it names", async () => {
		const client = createConfigServiceClient({
			origin: "https://hobo-config.example.workers.dev",
			fetch: mockFetch(),
		});
		expect(await client.health("pact-nonce-0123456789")).toMatchObject({
			nonce: "pact-nonce-0123456789",
		});
		await client.seed(TOKENS.bootstrap, {
			relay: { HOBO_CI_CONFIG_JSON: "{}" },
			deploy: {},
		});
		const relay = {
			kind: "oidc" as const,
			token: async () => TOKENS["vercel-relay"],
		};
		expect((await client.read("relay", relay)).entries).toEqual({
			HOBO_CI_CONFIG_JSON: "{}",
		});
		await expect(client.read("deploy", relay)).rejects.toBeInstanceOf(
			ConfigServiceClientError,
		);
		await expect(client.read("deploy", relay)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		const deploy = {
			kind: "oidc" as const,
			token: async () => TOKENS["github-deploy"],
		};
		expect(
			await client.write("relay", deploy, {
				entries: { HOBO_CI_GITHUB_APP_ID: "123456" },
			}),
		).toMatchObject({ names: ["HOBO_CI_GITHUB_APP_ID"], version: 2 });

		for (const request of seen) {
			const interaction = pact.interactions.find(
				(candidate) =>
					candidate.request.method === request.method &&
					candidate.request.path === request.path,
			);
			expect(interaction, `${request.method} ${request.path}`).toBeDefined();
			for (const [name, value] of Object.entries(
				interaction?.request.headers ?? {},
			))
				expect(
					request.headers?.[name],
					`${request.method} ${request.path} ${name}`,
				).toBe(value);
		}
	});
});
