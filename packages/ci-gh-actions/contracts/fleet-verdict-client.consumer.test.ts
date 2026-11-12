import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CiRelayClientError, createCiRelayClient } from "../src/client.js";
import { parseFleetVerdictReport } from "../src/fleet-verdict.js";

const ORIGIN = "https://relay.example";
const Interaction = z.object({
	description: z.string(),
	request: z.object({
		method: z.enum(["GET", "PUT", "POST"]),
		path: z.string(),
		headers: z.record(z.string(), z.string()),
		body: z.json().optional(),
	}),
	response: z.object({ status: z.number(), body: z.json() }),
});
const pact = z
	.object({
		metadata: z.object({
			consumerFixtures: z.object({ tokens: z.object({ tenant: z.string() }) }),
		}),
		interactions: z.array(Interaction),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL("./fleet-verdict-boundary.pact.json", import.meta.url),
				"utf8",
			),
		),
	);
type Client = ReturnType<typeof createCiRelayClient>;
const repositoryOf = (path: string) => path.split("/").slice(-2).join("/");

/** The reporting relay as a consumer: it only ever sends a report it could parse. */
function report(client: Client, interaction: z.infer<typeof Interaction>) {
	const parsed = parseFleetVerdictReport(
		JSON.stringify(interaction.request.body),
	);
	if (!parsed) throw new Error("the client cannot author this report");
	return client.putFleetVerdict(
		repositoryOf(interaction.request.path),
		parsed.blocked,
		parsed.ttlMs / 1000,
	);
}

describe("the fleet reporter as a consumer of the verdict routes", () => {
	it("sends every report the Pact has it send, and reads the verdict or a sanitized refusal back", async () => {
		// The rest are requests this client cannot make: no credential, a
		// report it would refuse to author, another method, a path with no
		// repository. The provider suite verifies how the relay answers them.
		const reachable = pact.interactions.filter(
			({ request }) =>
				request.method === "PUT" &&
				request.headers.Authorization !== undefined &&
				parseFleetVerdictReport(JSON.stringify(request.body)) !== undefined,
		);
		expect(reachable.map((entry) => entry.response.status)).toEqual([
			403, 404, 200, 200,
		]);
		for (const interaction of reachable) {
			let calls = 0;
			const send: typeof fetch = async (url, init) => {
				calls++;
				expect(String(url)).toBe(`${ORIGIN}${interaction.request.path}`);
				expect(init?.method).toBe("PUT");
				expect(init?.redirect).toBe("error");
				expect(Object.fromEntries(new Headers(init?.headers))).toEqual(
					Object.fromEntries(new Headers(interaction.request.headers)),
				);
				expect(JSON.parse(String(init?.body))).toEqual(
					interaction.request.body,
				);
				return Response.json(interaction.response.body, {
					status: interaction.response.status,
				});
			};
			const client = createCiRelayClient({
				origin: ORIGIN,
				accountToken: async () =>
					(interaction.request.headers.Authorization ?? "").slice(7),
				fetch: send,
			});
			if (interaction.response.status >= 400)
				await expect(report(client, interaction)).rejects.toMatchObject({
					name: "CiRelayClientError",
					status: interaction.response.status,
					message: `relay request failed (${interaction.response.status})`,
				});
			else {
				const verdict = await report(client, interaction);
				expect(verdict.$typeName).toBe("hobo.ci.gh_actions.v1.FleetVerdict");
				expect(verdict).toMatchObject(
					z.record(z.string(), z.json()).parse(interaction.response.body),
				);
			}
			expect(calls).toBe(1);
		}
	});

	it("reads a standing verdict", async () => {
		const standing = pact.interactions.find(
			(entry) =>
				entry.request.method === "GET" &&
				entry.description.startsWith("answer the standing verdict"),
		);
		if (!standing) throw new Error("the Pact has no standing verdict");
		const client = createCiRelayClient({
			origin: ORIGIN,
			accountToken: () => pact.metadata.consumerFixtures.tokens.tenant,
			fetch: async (url, init) => {
				expect(String(url)).toBe(`${ORIGIN}${standing.request.path}`);
				expect(init?.method).toBe("GET");
				return Response.json(standing.response.body);
			},
		});
		const verdict = await client.getFleetVerdict("hobo-labs/hobo");
		expect(verdict.blocked.hobo?.reason).toBe("no-capacity");
		expect(verdict.expiresAt).toBe("2026-10-27T00:03:00.000Z");
	});

	it("never sends a report it could not parse, or one for something that is not a repository", async () => {
		const client = createCiRelayClient({
			origin: ORIGIN,
			accountToken: () => pact.metadata.consumerFixtures.tokens.tenant,
			fetch: async () => {
				throw new Error("nothing should be sent");
			},
		});
		const blocked = new Map([["hobo", "no-node" as const]]);
		for (const send of [
			() => client.putFleetVerdict("hobo-labs/hobo", blocked, 86_400),
			() => client.putFleetVerdict("hobo-labs/hobo", blocked, 0),
			() => client.putFleetVerdict("hobo-labs", blocked, 60),
			() => client.putFleetVerdict("hobo-labs/hobo/../x", blocked, 60),
			() => client.getFleetVerdict("../accounts/self/policy"),
		])
			expect(send).toThrow(CiRelayClientError);
	});
});
