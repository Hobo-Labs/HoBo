import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ConfigurationSchema } from "@hobo/ci";
import { expect, it } from "vitest";
import { z } from "zod";
import { OnboardingOperationSchema } from "../src/onboarding.js";
import {
	controlHttp,
	NOW,
	SETUP_PLAN,
	strictGithub,
} from "../test/fixtures/control-api-github.js";

const Interaction = z.object({
	description: z.string(),
	providerStates: z
		.array(
			z.object({ name: z.literal("tenant has a server-owned reviewed setup") }),
		)
		.optional(),
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
		consumer: z.object({ name: z.literal("HoboAccountCiClient") }),
		provider: z.object({ name: z.literal("HoboCiAccountControlApi") }),
		metadata: z.object({
			pactSpecification: z.object({ version: z.literal("3.0.0") }),
			consumerFixtures: z.object({
				tokens: z.object({
					tenant: z.string(),
					neighbor: z.string(),
					readonly: z.string(),
				}),
				configuration: z.json(),
				setupId: z.string().uuid(),
			}),
		}),
		interactions: z.array(Interaction),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL("./control-plane-boundary.pact.json", import.meta.url),
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

it("serves the account REST Pact over real HTTP, with exact isolation, CAS and rejection envelopes", async () => {
	const fixtures = pact.metadata.consumerFixtures;
	const token = (value: string) =>
		createHash("sha256").update(value).digest("hex");
	const credentialJson = JSON.stringify({
		tokens: [
			{
				accountId: "tenant",
				installationIds: [5],
				tokenSha256: token(fixtures.tokens.tenant),
				scopes: [
					"policy:read",
					"policy:write",
					"repositories:write",
					"operations:write",
				],
			},
			{
				accountId: "neighbor",
				installationIds: [6],
				tokenSha256: token(fixtures.tokens.neighbor),
				scopes: [
					"policy:read",
					"policy:write",
					"repositories:write",
					"operations:write",
				],
			},
			{
				accountId: "tenant",
				installationIds: [5],
				tokenSha256: token(fixtures.tokens.readonly),
				scopes: ["policy:read"],
			},
		],
	});
	const github = strictGithub([]);
	const h = await controlHttp({
		github: github.github,
		credentialJson,
		configuration: fromJsonString(
			ConfigurationSchema,
			JSON.stringify(fixtures.configuration),
		),
	});
	const exercised = new Set<string>();
	let negativeControl = false;
	try {
		expect(pact.interactions).toHaveLength(20);
		for (const interaction of pact.interactions) {
			for (const state of interaction.providerStates ?? []) {
				expect(state.name).toBe("tenant has a server-owned reviewed setup");
				if (!h.store.controlRecord(`onboarding:${fixtures.setupId}`))
					h.store.putControlRecord(
						`onboarding:${fixtures.setupId}`,
						"tenant",
						toJsonString(
							OnboardingOperationSchema,
							create(OnboardingOperationSchema, {
								id: fixtures.setupId,
								plan: SETUP_PLAN,
								status: "planned",
							}),
						),
						NOW,
					);
			}
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
						status: 200,
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
		github.assertComplete();
		expect(
			h.store
				.configuration()
				?.configuration?.accounts.map((account) => [
					account.id,
					account.budgetMicros,
				])
				.sort(),
		).toEqual([
			["neighbor", 2_000_000],
			["tenant", 1_000_100],
		]);
	} finally {
		await h.stop();
	}
});
