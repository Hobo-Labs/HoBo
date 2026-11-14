import { readFileSync } from "node:fs";
import type { HttpTransport } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createR2ObjectClient } from "../src/index.js";

type Interaction = {
	description: string;
	request: {
		method: string;
		path: string;
		headers?: Record<string, string>;
		body?: string;
	};
	response: { status: number; headers: Record<string, string>; body: string };
};

// SAFETY: this is a checked-in pact fixture; this suite pins all interactions.
const pact = JSON.parse(
	readFileSync(
		new URL("../contracts/pacts/r2-origin.pact.json", import.meta.url),
		"utf8",
	),
) as { interactions: Interaction[] };
type Client = ReturnType<typeof createR2ObjectClient>;
type Outcome =
	| Awaited<ReturnType<Client["get"]>>
	| Awaited<ReturnType<Client["put"]>>;
const cases: Array<{
	invoke(client: Client): Promise<Outcome>;
	expected: Outcome;
}> = [
	{ invoke: (client) => client.get("state/key"), expected: undefined },
	{
		invoke: (client) => client.get("state/key"),
		expected: { body: "one", etag: '"version-1"' },
	},
	{
		invoke: (client) => client.put("state/key", "one", { kind: "absent" }),
		expected: { applied: true, etag: '"version-1"' },
	},
	{
		invoke: (client) =>
			client.put("state/key", "two", { kind: "match", etag: '"version-1"' }),
		expected: { applied: false },
	},
	{
		invoke: (client) => client.put("state/key", "one", { kind: "absent" }),
		expected: { applied: true },
	},
];

describe("R2 origin pact", () => {
	it("covers every checked-in interaction", () => {
		expect(pact.interactions).toHaveLength(cases.length);
	});
	for (const [index, contractCase] of cases.entries()) {
		const interaction = pact.interactions[index];
		if (!interaction) throw new Error(`missing pact interaction ${index}`);
		it(interaction.description, async () => {
			let calls = 0;
			const transport: HttpTransport = async (request) => {
				calls++;
				const url = new URL(request.url);
				expect(url.hostname).toBe(
					"0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
				);
				expect(url.pathname).toBe(interaction.request.path);
				expect(request.method).toBe(interaction.request.method);
				for (const [name, value] of Object.entries(
					interaction.request.headers ?? {},
				)) {
					expect(request.headers[name]).toBe(value);
				}
				if (interaction.request.body !== undefined)
					expect(request.body).toBe(interaction.request.body);
				expect(request.headers.Authorization).toContain(
					"/auto/s3/aws4_request",
				);
				return interaction.response;
			};
			const client = createR2ObjectClient({
				accountId: "0123456789abcdef0123456789abcdef",
				bucket: "hobo-ci-cache",
				transport,
				now: () => Date.parse("2026-01-01T00:00:00Z"),
				maxObjectBytes: 4096,
				resolveCredentials: async () => ({
					accessKeyId: "fixture",
					secretAccessKey: "secret",
				}),
			});
			expect(await contractCase.invoke(client)).toEqual(contractCase.expected);
			expect(calls).toBe(1);
		});
	}
});
