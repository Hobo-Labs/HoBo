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

	it("keeps hand-authored PACT interactions on documented API boundaries", () => {
		const pact = z
			.object({
				consumer: z.object({ name: z.literal("ProviderAgent37Client") }),
				provider: z.object({ name: z.literal("Agent37SandboxApiFake") }),
				interactions: z
					.array(
						z.object({
							description: z.string().min(1),
							request: z.object({
								method: z.enum(["GET", "POST"]),
								path: z.string().startsWith("/v1/"),
								headers: z
									.record(z.string(), z.string())
									.refine(
										(headers) =>
											headers.Authorization === "Bearer <runtime-api-key>" ||
											headers.Authorization ===
												"Bearer <wrong-runtime-api-key>" ||
											headers["X-Agent37-Key"] === "<runtime-api-key>" ||
											headers["X-Agent37-Key"] === "<wrong-runtime-api-key>",
										"request must carry an API key placeholder",
									),
							}),
							response: z.object({
								status: z.number().int().min(100).max(599),
								body: z.record(z.string(), z.unknown()),
							}),
						}),
					)
					.length(5),
				metadata: z.object({
					pactSpecification: z.object({ version: z.literal("3.0.0") }),
				}),
			})
			.parse(fixture("contracts/pacts/agent37_sandbox_fake.pact.json"));
		expect(pact).toMatchObject({
			consumer: { name: "ProviderAgent37Client" },
			provider: { name: "Agent37SandboxApiFake" },
			metadata: { pactSpecification: { version: "3.0.0" } },
		});
		expect(
			pact.interactions.map((interaction) => interaction.description),
		).toEqual([
			"client creates a vm runner box",
			"client runs a named synchronous exec on the sandbox plane",
			"wrong sandbox key is refused",
			"wrong bearer key is refused",
			"client reads a bounded usage window",
		]);
	});
});
