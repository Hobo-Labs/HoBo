import { describe, expect, it } from "vitest";
import {
	createAiSdkHarnessRunner,
	createHarnessEngine,
	parseHarnessAnswer,
} from "../src/harness-engine.js";
import type { EngineRequest } from "../src/resolver.js";

const request: EngineRequest = {
	path: "src/a.ts",
	oursLabel: "pull request #1",
	theirsLabel: "main",
	regions: [
		{ id: 0, ours: "a\n", base: "", theirs: "b\n", before: "", after: "" },
	],
	maxOutputTokens: 100,
	signal: new AbortController().signal,
};
const answer = { regions: [{ id: 0, resolution: "a\nb\n", confidence: 0.9 }] };

describe("harness engine", () => {
	it("reads the JSON answer, bare or in one fenced block", () => {
		expect(parseHarnessAnswer(JSON.stringify(answer))).toEqual(answer);
		expect(
			parseHarnessAnswer(
				`Here it is:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\n`,
			),
		).toEqual(answer);
		expect(() => parseHarnessAnswer("I merged it for you.")).toThrow();
		expect(() =>
			parseHarnessAnswer(
				JSON.stringify({ regions: [{ id: 0, resolution: 1 }] }),
			),
		).toThrow();
	});

	it("sends the same document as a model engine and returns the runtime's usage", async () => {
		const prompts: string[] = [];
		const engine = createHarnessEngine({
			id: "cc",
			adapter: "claude-code",
			runner: {
				run: async ({ prompt }) => {
					prompts.push(prompt);
					return {
						text: JSON.stringify(answer),
						usage: { inputTokens: 50, outputTokens: 10 },
					};
				},
			},
		});
		expect(await engine.resolve(request)).toEqual({
			regions: answer.regions,
			usage: { inputTokens: 50, outputTokens: 10 },
		});
		expect(JSON.parse(prompts[0] ?? "")).toMatchObject({
			path: "src/a.ts",
			regions: [{ id: 0 }],
		});
	});

	it("builds the AI SDK harness agent for an installed runtime without starting it", async () => {
		// Constructing the agent checks the adapter accepts an empty tool list and
		// the in-memory sandbox; no runtime process is started until a run.
		const runner = await createAiSdkHarnessRunner("claude-code");
		expect(runner.run).toBeInstanceOf(Function);
		await expect(createAiSdkHarnessRunner("emacs")).rejects.toThrow(
			"unknown CI agent harness: emacs",
		);
		await expect(createAiSdkHarnessRunner("grok-build")).rejects.toThrow(
			"needs @ai-sdk/harness-grok-build installed",
		);
	});
});
