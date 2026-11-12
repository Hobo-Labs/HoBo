import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAiSdkEngine, resolutionPrompt } from "../src/ai-sdk-engine.js";
import { agentPolicies, parseAgentConfig } from "../src/config.js";
import { type EngineRequest, resolveConflicts } from "../src/resolver.js";
import pactJson from "./resolution-engine.pact.json" with { type: "json" };

const Region = z.object({
	id: z.number(),
	ours: z.string(),
	base: z.string(),
	theirs: z.string(),
	before: z.string(),
	after: z.string(),
});
const pact = z
	.object({
		consumer: z.object({ name: z.literal("HoboCiAgent") }),
		provider: z.object({ name: z.literal("ResolutionEngine") }),
		metadata: z.object({
			pactSpecification: z.object({ version: z.literal("4.0.0") }),
		}),
		interactions: z.array(
			z.object({
				type: z.literal("Synchronous/Messages"),
				description: z.string(),
				request: z.object({
					contents: z.object({
						path: z.string(),
						ours: z.string(),
						theirs: z.string(),
						regions: z.array(Region),
					}),
				}),
				response: z.array(z.object({ contents: z.json() })).length(1),
				expectedOutcome: z.literal("failed").optional(),
			}),
		),
	})
	.parse(pactJson);

const engineFor = (contents: z.infer<ReturnType<typeof z.json>>) =>
	createAiSdkEngine({
		id: "contract",
		modelName: "mock",
		model: new MockLanguageModelV4({
			doGenerate: {
				content: [{ type: "text", text: JSON.stringify(contents) }],
				finishReason: { unified: "stop", raw: undefined },
				usage: {
					inputTokens: {
						total: 200,
						noCache: 200,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 30, text: 30, reasoning: undefined },
				},
				warnings: [],
			},
		}),
	});

describe("resolution engine consumer contract", () => {
	it.each(pact.interactions)("$description", async (interaction) => {
		const { contents } = interaction.request;
		const request: EngineRequest = {
			path: contents.path,
			oursLabel: contents.ours,
			theirsLabel: contents.theirs,
			regions: contents.regions,
			maxOutputTokens: 1000,
			signal: new AbortController().signal,
		};
		// The request the engine receives is exactly the contract's message.
		expect(JSON.parse(resolutionPrompt(request))).toEqual(contents);

		const [region] = contents.regions;
		if (!region) throw new Error("contract region missing");
		const merged = `${region.before}<<<<<<< ours\n${region.ours}||||||| base\n${region.base}=======\n${region.theirs}>>>>>>> theirs\n${region.after}`;
		const { resolution, budget } = agentPolicies(
			parseAgentConfig(
				JSON.stringify({
					mode: "observe",
					engines: [
						{ id: "contract", kind: "gateway", model: "openai/gpt-5.1" },
					],
				}),
			),
		);
		const result = await resolveConflicts({
			files: [
				{
					path: contents.path,
					kind: "content",
					merged,
					markerSize: 7,
					bytes: merged.length,
				},
			],
			policy: resolution,
			budget,
			engines: [engineFor(interaction.response[0]?.contents ?? null)],
			remainingTokens: 1_000_000,
			oursLabel: contents.ours,
			theirsLabel: contents.theirs,
		});
		if (interaction.expectedOutcome === "failed") {
			expect(result).toMatchObject({
				outcome: "failed",
				reason: "engine-unavailable",
			});
			return;
		}
		expect(result).toMatchObject({
			outcome: "resolved",
			usage: { inputTokens: 200, outputTokens: 30 },
			files: [
				{
					confidence: 0.86,
					content: `${region.before}export const RATE = 0.2;\nexport const CURRENCY = "USD";\n${region.after}`,
				},
			],
		});
	});
});
