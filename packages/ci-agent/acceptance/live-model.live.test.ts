import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCiAgent } from "../src/agent.js";
import {
	createAiSdkEngine,
	createConfiguredEngines,
} from "../src/ai-sdk-engine.js";
import { parseAgentConfig } from "../src/config.js";
import { createMemoryJournal } from "../src/journal.js";
import { observeQueue } from "../src/planner.js";
import {
	createRepositories,
	type Repositories,
} from "../test/fixtures/repository.js";

/**
 * One pass of the agent with a real model behind the AI Gateway, against
 * real git: two pull requests change the same lines of a TypeScript file in
 * compatible ways, and the agent must commit a merge that keeps both.
 *
 * Run with `pnpm --filter @hobo/ci-agent test:live`; it needs
 * AI_GATEWAY_API_KEY, and HOBO_CI_AGENT_LIVE_MODEL picks the model.
 */
const BASE = `export type Price = {
	amount: number;
};

export function total(prices: readonly Price[]): number {
	return prices.reduce((sum, price) => sum + price.amount, 0);
}
`;
const OURS = BASE.replace(
	"	amount: number;\n",
	"	amount: number;\n	currency: string;\n",
);
const THEIRS = BASE.replace(
	"	amount: number;\n",
	"	amount: number;\n	discount?: number;\n",
).replace("sum + price.amount", "sum + price.amount - (price.discount ?? 0)");

/**
 * Where the model is: an OpenAI-compatible server at
 * HOBO_CI_AGENT_LIVE_BASE_URL (a local llama.cpp or Ollama server with an
 * open-weights model, which costs nothing), or else the AI Gateway.
 */
const local = process.env.HOBO_CI_AGENT_LIVE_BASE_URL;
const gateway = process.env.AI_GATEWAY_API_KEY;

describe.skipIf(!local && !gateway)(
	`live model (${local ? "OpenAI-compatible server" : "AI Gateway"})`,
	// A small model on a CPU answers in minutes, not seconds.
	{ timeout: 900_000 },
	() => {
		let repos: Repositories;
		beforeEach(() => {
			repos = createRepositories();
			repos.seed({ "src/price.ts": BASE });
		});
		afterEach(() => repos.cleanup());

		it("resolves a real conflict into a merge that keeps both changes", async () => {
			const head = repos.commit("pr-1", { "src/price.ts": OURS });
			repos.pull(1, "pr-1");
			repos.commit("main", { "src/price.ts": THEIRS });
			const config = parseAgentConfig(
				JSON.stringify({
					mode: "suggest",
					engines: [
						{
							id: "live",
							kind: "gateway",
							model:
								process.env.HOBO_CI_AGENT_LIVE_MODEL ??
								"anthropic/claude-sonnet-5.5",
						},
					],
					// Room for a small model on a CPU.
					budget: { timeoutSeconds: 600 },
				}),
			);
			const comments: string[] = [];
			const agent = createCiAgent({
				config,
				queue: {
					baseRequiresChecks: async () => true,
					commitChecks: async () => ({ state: "none", failures: "" }),
					snapshot: async () =>
						observeQueue({
							repository: "hobo-labs/hobo",
							baseRef: "main",
							baseSha: repos.remoteRef("refs/heads/main"),
							observedAt: new Date().toISOString(),
							entries: [
								{
									number: 1,
									headSha: head,
									headRef: "pr-1",
									baseRef: "main",
									position: 0,
									enqueuedAt: new Date().toISOString(),
									changedPaths: ["src/price.ts"],
									started: false,
									fork: false,
								},
							],
						}),
				},
				publisher: {
					comment: async (_, body) => {
						comments.push(body);
					},
					enqueue: async () => {},
				},
				workspace: repos.workspace(),
				// The configuration allows only an https base URL; a local server is
				// plain http, so its engine is built from the model directly.
				engines: local
					? [
							createAiSdkEngine({
								id: "live",
								modelName: process.env.HOBO_CI_AGENT_LIVE_MODEL ?? "local",
								model: createOpenAICompatible({
									name: "local",
									baseURL: local,
									supportsStructuredOutputs: true,
								})(process.env.HOBO_CI_AGENT_LIVE_MODEL ?? "local"),
							}),
						]
					: await createConfiguredEngines(config, {
							credential: () => undefined,
						}),
				journal: createMemoryJournal(),
			});

			const report = await agent.tick();
			const [resolution] = report.resolutions;
			expect(resolution).toMatchObject({
				number: 1,
				outcome: "resolved",
				engineId: "live",
			});
			expect(Number(resolution?.usage?.inputTokens)).toBeGreaterThan(0);
			const merged = repos.git(
				repos.agent,
				"show",
				`${resolution?.commitSha}:src/price.ts`,
			);
			expect(merged).toContain("currency: string;");
			expect(merged).toContain("discount?: number;");
			expect(merged).toContain("price.discount ?? 0");
			expect(merged).not.toMatch(/^(<{7}|={7}|>{7})/m);
			expect(comments).toHaveLength(1);
			// The record of the run, for the pull request that lands this test.
			process.stdout.write(
				`${JSON.stringify({
					model: resolution?.model,
					inputTokens: Number(resolution?.usage?.inputTokens),
					outputTokens: Number(resolution?.usage?.outputTokens),
					confidence: resolution?.files[0]?.confidence,
				})}\n${merged}\n`,
			);
		});
	},
);
