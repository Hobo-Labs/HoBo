import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fromJsonString } from "@bufbuild/protobuf";
import { ConfigurationSchema } from "@hobo/ci";
import { expect, it } from "vitest";
import { z } from "zod";
import { askRelay, relayRefusal } from "../../../scripts/ci/route-runner.mts";
import { createCiRelayClient } from "../src/client.js";
import { createMemoryFleetVerdicts } from "../src/fleet-verdict.js";
import {
	controlHttp,
	NOW,
	strictGithub,
} from "../test/fixtures/control-api-github.js";

const Interaction = z.object({
	description: z.string(),
	request: z.object({
		method: z.enum(["GET", "POST", "PUT"]),
		path: z.string(),
		headers: z.record(z.string(), z.string()),
		body: z.json().optional(),
	}),
	response: z.object({
		status: z.number(),
		headers: z.record(z.string(), z.string()),
		body: z.json(),
	}),
});
const pact = z
	.object({
		consumer: z.object({
			name: z.literal("HoboCiRunnerRoutingAndFleetReporter"),
		}),
		provider: z.object({ name: z.literal("HoboCiRelayFleetVerdictApi") }),
		metadata: z.object({
			pactSpecification: z.object({ version: z.literal("3.0.0") }),
			consumerFixtures: z.object({
				tokens: z.object({
					tenant: z.string(),
					neighbor: z.string(),
					readonly: z.string(),
				}),
				now: z.literal(NOW),
				configuration: z.json(),
			}),
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

async function assertResponse(
	response: Response,
	expected: z.infer<typeof Interaction>["response"],
) {
	expect(response.status).toBe(expected.status);
	for (const [key, value] of Object.entries(expected.headers))
		expect(response.headers.get(key)).toBe(value);
	expect(await response.json()).toEqual(expected.body);
}

it("serves the fleet verdict Pact over real HTTP: read by anyone, written only by the connected account", async () => {
	const fixtures = pact.metadata.consumerFixtures;
	const token = (value: string) =>
		createHash("sha256").update(value).digest("hex");
	const write = [
		"policy:read",
		"policy:write",
		"repositories:write",
		"operations:write",
	];
	const h = await controlHttp({
		github: strictGithub([]).github,
		credentialJson: JSON.stringify({
			tokens: [
				{
					accountId: "tenant",
					installationIds: [5],
					tokenSha256: token(fixtures.tokens.tenant),
					scopes: write,
				},
				{
					accountId: "neighbor",
					installationIds: [6],
					tokenSha256: token(fixtures.tokens.neighbor),
					scopes: write,
				},
				{
					accountId: "tenant",
					installationIds: [5],
					tokenSha256: token(fixtures.tokens.readonly),
					scopes: ["policy:read"],
				},
			],
		}),
		configuration: fromJsonString(
			ConfigurationSchema,
			JSON.stringify(fixtures.configuration),
		),
		fleetVerdicts: createMemoryFleetVerdicts(() => Date.parse(NOW)),
	});
	const exercised = new Set<string>();
	let negativeControl = false;
	try {
		expect(pact.interactions).toHaveLength(13);
		for (const interaction of pact.interactions) {
			const init: RequestInit = {
				method: interaction.request.method,
				headers: interaction.request.headers,
			};
			if (interaction.request.body !== undefined)
				init.body = JSON.stringify(interaction.request.body);
			const response = await fetch(
				`${h.base}${interaction.request.path}`,
				init,
			);
			if (!negativeControl) {
				await expect(
					assertResponse(response.clone(), {
						...interaction.response,
						status: 503,
					}),
				).rejects.toThrow();
				negativeControl = true;
			}
			await assertResponse(response, interaction.response);
			exercised.add(interaction.description);
		}
		expect(negativeControl).toBe(true);
		expect([...exercised].sort()).toEqual(
			pact.interactions.map((entry) => entry.description).sort(),
		);
	} finally {
		await h.stop();
	}
});

it("answers a relay that keeps no verdicts as blocking nothing", async () => {
	const h = await controlHttp({ github: strictGithub([]).github });
	try {
		const read = await fetch(`${h.base}/v1/fleet/verdicts/Hobo-Labs/HoBo`);
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({
			repository: "hobo-labs/hobo",
			blocked: {},
		});
	} finally {
		await h.stop();
	}
});

it("is asked by the routing job's own client and reported by the relay client, end to end", async () => {
	const fixtures = pact.metadata.consumerFixtures;
	const kept = createMemoryFleetVerdicts(() => Date.parse(NOW));
	const reads: string[] = [];
	const h = await controlHttp({
		github: strictGithub([]).github,
		credentialJson: JSON.stringify({
			tokens: [
				{
					accountId: "tenant",
					installationIds: [5],
					tokenSha256: createHash("sha256")
						.update(fixtures.tokens.tenant)
						.digest("hex"),
					scopes: ["policy:read", "operations:write"],
				},
			],
		}),
		configuration: fromJsonString(
			ConfigurationSchema,
			JSON.stringify(fixtures.configuration),
		),
		fleetVerdicts: {
			read: (repository) => {
				reads.push(repository);
				return kept.read(repository);
			},
			write: (verdict) => kept.write(verdict),
		},
	});
	const ask = () => askRelay({ origin: h.base, repository: "Hobo-Labs/HoBo" });
	const reporter = createCiRelayClient({
		origin: h.base,
		allowInsecureLoopback: true,
		accountToken: () => fixtures.tokens.tenant,
	});
	try {
		// Nothing reported: the routing job is told nothing is blocked.
		const before = await ask();
		expect(before).toEqual({ kind: "verdict", blocked: new Map() });
		expect(relayRefusal(before, "hobo")).toBeUndefined();

		await reporter.putFleetVerdict(
			"Hobo-Labs/HoBo",
			new Map([["hobo", "no-capacity"]]),
			120,
		);
		const blocked = await ask();
		expect(relayRefusal(blocked, "hobo")).toBe(
			"the relay keeps new work off hobo: no node can admit a job and none has a free slot",
		);
		expect(relayRefusal(blocked, "hobo-trunk")).toBeUndefined();

		await reporter.putFleetVerdict("Hobo-Labs/HoBo", new Map(), 60);
		expect(relayRefusal(await ask(), "hobo")).toBeUndefined();

		// Asking about a repository no account is connected to reads nothing
		// from the store: a made-up name costs the relay no lookup.
		const asked = reads.length;
		expect(
			await askRelay({ origin: h.base, repository: "acme/unknown" }),
		).toEqual({ kind: "verdict", blocked: new Map() });
		expect(reads).toHaveLength(asked);
		expect(new Set(reads)).toEqual(new Set(["hobo-labs/hobo"]));
	} finally {
		await h.stop();
	}
});
