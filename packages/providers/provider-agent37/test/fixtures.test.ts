import { readFileSync } from "node:fs";
import type { JsonValue } from "@hobo/provider-agent37/fake";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	agent37ExecResultSchema,
	agent37InstanceSchema,
	agent37WebhookSchema,
} from "../src/contracts.js";

const root = new URL("../", import.meta.url);
const fixture = (path: string): JsonValue =>
	JSON.parse(readFileSync(new URL(path, root), "utf8"));

describe("Agent37 schema and PACT fixtures", () => {
	it("keeps valid protobuf/CUE fixture records aligned with runtime parsers", () => {
		expect(
			agent37InstanceSchema.safeParse(
				fixture("data-models/fixtures/valid/instance.json"),
			).success,
		).toBe(true);
		expect(
			agent37ExecResultSchema.safeParse(
				fixture("data-models/fixtures/valid/exec-result.json"),
			).success,
		).toBe(true);
		expect(
			agent37WebhookSchema.safeParse(
				fixture("data-models/fixtures/valid/webhook.json"),
			).success,
		).toBe(true);
	});

	it("rejects the invalid fixture", () => {
		expect(
			agent37InstanceSchema.safeParse(
				fixture("data-models/fixtures/invalid/instance.json"),
			).success,
		).toBe(false);
	});

	const pactInteraction = z.object({
		description: z.string().min(1),
		request: z.object({
			method: z.enum(["GET", "POST", "DELETE", "PATCH", "PUT"]),
			path: z.string().min(1),
			headers: z.record(z.string()).optional(),
			body: z.unknown().optional(),
			query: z.string().optional(),
		}),
		response: z.object({
			status: z.number().int(),
			body: z.unknown(),
		}),
	});

	it("keeps hand-authored PACT interactions on documented API boundaries", () => {
		const pact = z
			.object({
				consumer: z.object({ name: z.literal("ProviderAgent37Client") }),
				provider: z.object({ name: z.literal("Agent37SandboxApiFake") }),
				interactions: z.array(pactInteraction).length(5),
				metadata: z.object({
					pactSpecification: z.object({ version: z.literal("3.0.0") }),
				}),
			})
			.parse(fixture("contracts/pacts/agent37_sandbox_fake.pact.json"));
		expect(pact.interactions.map((interaction) => interaction.description)).toEqual(
			[
				"client creates a vm runner box",
				"client runs a named synchronous exec on the sandbox plane",
				"wrong sandbox key is refused",
				"wrong bearer key is refused",
				"client reads a bounded usage window",
			],
		);
		for (const interaction of pact.interactions) {
			expect(interaction.request.headers).toBeDefined();
			const auth =
				interaction.request.headers?.Authorization ??
				interaction.request.headers?.["X-Agent37-Key"];
			expect(auth).toMatch(/<(?:wrong-)?runtime-api-key>/);
		}
	});
});
