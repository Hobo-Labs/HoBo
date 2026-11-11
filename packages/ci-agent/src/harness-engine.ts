import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { z } from "zod";
import {
	EngineAnswerSchema,
	RESOLUTION_INSTRUCTIONS,
	resolutionPrompt,
} from "./ai-sdk-engine.js";
import type { ResolutionEngine } from "./resolver.js";

/** One prompt to an agent runtime, and the text it answered with. */
export interface HarnessRunner {
	run(input: { prompt: string; signal: AbortSignal }): Promise<{
		text: string;
		usage: { inputTokens: number; outputTokens: number };
	}>;
}

/** Appended to the standing instructions: a runtime answers in text, not a schema. */
export const HARNESS_ANSWER_FORMAT =
	'Do not use any tool. Reply with one JSON object and nothing else, of the form {"regions":[{"id":0,"resolution":"...","confidence":0.9}]}.';

/** The JSON object in a runtime's reply: the whole reply, or its one fenced block. */
export function parseHarnessAnswer(text: string) {
	const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1];
	return EngineAnswerSchema.parse(JSON.parse((fenced ?? text).trim()));
}

/**
 * An engine over a coding-agent runtime (Claude Code, Codex, OpenCode, Pi,
 * Grok Build) instead of a model API. It gets the same document and the
 * same checks as a model engine; an answer that is not the expected JSON
 * throws, so the resolver moves to the next engine.
 */
export function createHarnessEngine(options: {
	id: string;
	adapter: string;
	runner: HarnessRunner;
}): ResolutionEngine {
	return {
		id: options.id,
		model: options.adapter,
		async resolve(request) {
			const reply = await options.runner.run({
				prompt: resolutionPrompt(request),
				signal: request.signal,
			});
			return {
				regions: parseHarnessAnswer(reply.text).regions,
				usage: reply.usage,
			};
		},
	};
}

const ADAPTER_PACKAGES = new Map([
	["claude-code", "@ai-sdk/harness-claude-code"],
	["codex", "@ai-sdk/harness-codex"],
	["opencode", "@ai-sdk/harness-opencode"],
	["pi", "@ai-sdk/harness-pi"],
	["grok-build", "@ai-sdk/harness-grok-build"],
]);
const HarnessExport = z
	.object({ specificationVersion: z.literal("harness-v1") })
	.loose();

/**
 * A runner over the AI SDK harness agent, with every built-in tool of the
 * runtime switched off and an empty in-memory sandbox, so the runtime sees
 * the conflict text and nothing else. The runtime signs in on its own (for
 * example Claude Code with `ANTHROPIC_API_KEY`); the agent holds no
 * credential for it. Each run is a fresh session, destroyed afterwards.
 */
export async function createAiSdkHarnessRunner(
	adapter: string,
): Promise<HarnessRunner> {
	const packageName = ADAPTER_PACKAGES.get(adapter);
	if (!packageName) throw new Error(`unknown CI agent harness: ${adapter}`);
	const [{ HarnessAgent }, { createJustBashSandbox }, module] =
		await Promise.all([
			import("@ai-sdk/harness/agent"),
			import("@ai-sdk/sandbox-just-bash"),
			import(packageName).catch(() => {
				throw new Error(
					`CI agent harness ${adapter} needs ${packageName} installed next to @hobo/ci-agent`,
				);
			}),
		]);
	const exported = z.record(z.string(), z.unknown()).parse(module);
	const name = Object.keys(exported).find(
		(key) => HarnessExport.safeParse(exported[key]).success,
	);
	if (!name) throw new Error(`${packageName} exports no harness`);
	const agent = new HarnessAgent({
		// SAFETY: the export was checked to carry the harness-v1 specification marker.
		harness: exported[name] as HarnessAgentAdapter,
		instructions: `${RESOLUTION_INSTRUCTIONS}\n${HARNESS_ANSWER_FORMAT}`,
		activeTools: [],
		permissionMode: "allow-reads",
		sandbox: createJustBashSandbox(),
	});
	return {
		async run({ prompt, signal }) {
			const session = await agent.createSession({ abortSignal: signal });
			try {
				const result = await agent.generate({
					prompt,
					session,
					abortSignal: signal,
				});
				return {
					text: result.text,
					usage: {
						inputTokens: result.usage.inputTokens ?? 0,
						outputTokens: result.usage.outputTokens ?? 0,
					},
				};
			} finally {
				await session.destroy().catch(() => undefined);
			}
		},
	};
}
