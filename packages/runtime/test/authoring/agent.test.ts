import { describe, expect, it } from "vitest";
import { agent } from "../../src/agent.js";
import { CapabilityDeniedError } from "../../src/errors.js";
import type { JsonValue } from "../../src/json.js";
import { createWorkflowEngine } from "../../src/workflow.js";

describe("agent(): durable tool-invoking actor under a deny-by-default ctx", () => {
	it("runs a declared tool as a journaled step", async () => {
		const engine = createWorkflowEngine();
		let toolCalls = 0;
		const support = agent<string, string>({
			name: "support",
			tools: [
				{
					name: "search",
					run: (query) => {
						toolCalls += 1;
						return `results:${String(query)}`;
					},
				},
			],
			async run(ctx, input) {
				// SAFETY: assertion to `(await ctx.tool("search", input)) as string` is required at this boundary.
				return (await ctx.tool("search", input)) as string;
			},
		});

		const handle = await engine.start(support, "outage");

		expect(handle.status).toBe("completed");
		expect(handle.result).toBe("results:outage");
		expect(toolCalls).toBe(1);

		// The tool call is a journaled step (so the agent is replayable).
		const journal = await engine.journal(handle.runId);
		const toolStep = journal.find(
			(event) =>
				event.type === "run.StepCompleted" &&
				// SAFETY: assertion to `event.data as { name?: string }` is required at this boundary.
				(event.data as { name?: string }).name === "tool:search",
		);
		expect(toolStep).toBeDefined();
	});

	it("denies an undeclared broker token with a typed capability denial", async () => {
		const engine = createWorkflowEngine();
		const support = agent<string, JsonValue>({
			name: "support",
			// No token:openai capability declared.
			async run(ctx, _input) {
				return ctx.token({ provider: "openai", scope: "chat" });
			},
		});

		let denial: CapabilityDeniedError | undefined;
		try {
			await engine.start(support, "ping");
		} catch (error) {
			// SAFETY: assertion to `error as CapabilityDeniedError` is required at this boundary.
			denial = error as CapabilityDeniedError;
		}

		expect(denial).toBeInstanceOf(CapabilityDeniedError);
		expect(denial?.capability).toBe("token:openai");
	});

	it("allows a declared broker token through the membrane", async () => {
		const engine = createWorkflowEngine();
		const support = agent<string, { ref: string }>({
			name: "support",
			capabilities: ["token:openai"],
			async run(ctx, _input) {
				return ctx.token({ provider: "openai", scope: "chat" });
			},
		});

		const handle = await engine.start(support, "ping");
		expect(handle.status).toBe("completed");
		expect(handle.result?.ref).toBe("stub://openai/chat");
	});
});
