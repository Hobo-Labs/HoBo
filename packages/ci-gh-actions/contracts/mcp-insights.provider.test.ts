import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { insightWorld, rpc } from "../test/support/relay-mcp-insights-world.js";

const Caller = z.object({
	accountId: z.string().min(1),
	scopes: z.array(z.string()),
});

const STORED = "a relay with stored routes, machines and runs";
const STATELESS = "a relay that stores no journal, machines or runs";

const pact = z
	.object({
		consumer: z.object({ name: z.literal("McpAgentClient") }),
		provider: z.object({ name: z.literal("HoboCiRelayMcpInsights") }),
		metadata: z.object({
			pactSpecification: z.object({ version: z.literal("3.0.0") }),
			consumerFixtures: z.object({
				callers: z.object({ reader: Caller, operator: Caller }),
			}),
		}),
		interactions: z.array(
			z.object({
				description: z.string(),
				providerState: z.enum([STORED, STATELESS]),
				caller: z.enum(["reader", "operator"]),
				request: z
					.record(z.string(), z.json())
					.refine(
						(request) =>
							request.jsonrpc === "2.0" &&
							(request.method === "tools/list" ||
								request.method === "tools/call"),
						"a JSON-RPC tools/list or tools/call request",
					),
				response: z.record(z.string(), z.json()),
			}),
		),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL("./mcp-insights.pact.json", import.meta.url),
				"utf8",
			),
		),
	);

it("executes every declared MCP insight interaction against the tools", async () => {
	expect(pact.interactions).toHaveLength(12);
	const { callers } = pact.metadata.consumerFixtures;
	const stored = await insightWorld();
	const stateless = await insightWorld({
		journal: undefined,
		machines: undefined,
		runs: undefined,
	});
	let matched = 0;
	for (const interaction of pact.interactions) {
		const world = interaction.providerState === STORED ? stored : stateless;
		const answer = await rpc(
			world.services,
			interaction.request,
			callers[interaction.caller],
		);
		expect(answer, interaction.description).toMatchObject(interaction.response);
		matched++;
	}
	expect(matched).toBe(12);
	expect(stored.registry.changes.map((change) => change.change)).toEqual([
		"put",
		"put",
		"put",
	]);
	expect(stored.journal.events).toHaveLength(6);
});
