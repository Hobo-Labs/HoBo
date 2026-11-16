import { readFile } from "node:fs/promises";

import {
	agent,
	CapabilityDeniedError,
	createWorkflowEngine,
} from "@hobo/runtime";
import { replayRun } from "@hobo/runtime/replay";
import { describe, expect, it } from "vitest";

import {
	opsAgent,
	parseOrderCommand,
	TOKEN_PROVIDER,
	TOKEN_SCOPE,
} from "../src/agent.js";

describe("durable-agent", () => {
	it("parses at the boundary: a derived OrderCommand or a typed refusal", () => {
		expect(parseOrderCommand({ orderId: " ord-7 " }).orderId).toBe("ord-7");
		expect(() => parseOrderCommand({ orderId: "" })).toThrow(TypeError);
		expect(() => parseOrderCommand("ord-7")).toThrow(TypeError);
	});

	it("runs the ops agent: brokered token, journaled tool step, order.Written event", async () => {
		const engine = createWorkflowEngine();
		const handle = await engine.start(
			opsAgent,
			parseOrderCommand({ orderId: "ord-1" }),
		);

		expect(handle.status).toBe("completed");
		expect(handle.result?.orderId).toBe("ord-1");
		expect(handle.result?.tokenRef).toBe(
			`stub://${TOKEN_PROVIDER}/${TOKEN_SCOPE}`,
		);

		const journal = await engine.journal(handle.runId);
		expect(journal.map((event) => event.type)).toContain("order.Written");
		const toolStep = journal.find(
			(event) =>
				event.type === "run.StepCompleted" &&
				// SAFETY: assertion to `event.data as { name?: string }` is required at this boundary.
				(event.data as { name?: string }).name === "tool:writeOrder",
		);
		expect(toolStep).toBeDefined();
	});

	it("survives a host crash: resumes from the journal without re-running the tool", async () => {
		const engine = createWorkflowEngine();
		let toolCalls = 0;
		let crashed = false;
		const flaky = agent<{ orderId: string }, string>({
			name: "flaky-ops",
			tools: [
				{
					name: "writeOrder",
					run() {
						toolCalls += 1;
						return "written";
					},
				},
			],
			async run(ctx, input) {
				// SAFETY: assertion to `(await ctx.tool("writeOrder", input)) as string` is required at this boundary.
				const written = (await ctx.tool("writeOrder", input)) as string;
				if (!crashed) {
					crashed = true;
					throw new Error("SIMULATED_HOST_CRASH");
				}
				return written;
			},
		});

		await expect(engine.start(flaky, { orderId: "ord-9" })).rejects.toThrow(
			"SIMULATED_HOST_CRASH",
		);
		expect(toolCalls).toBe(1);

		// A brand-new engine over the SAME durable store resumes the run.
		const restarted = createWorkflowEngine({ store: engine.store });
		const handle = await restarted.resume(flaky, "run-1", {
			orderId: "ord-9",
		});

		expect(handle.status).toBe("completed");
		expect(handle.result).toBe("written");
		// The tool step was journaled on attempt 1 — replayed, not re-run.
		expect(toolCalls).toBe(1);
	});

	it("replay == live under the existing replay engine", async () => {
		const engine = createWorkflowEngine();
		const command = parseOrderCommand({ orderId: "ord-2" });
		const handle = await engine.start(opsAgent, command);
		expect(handle.status).toBe("completed");

		const replay = await replayRun(
			engine.store,
			handle.runId,
			engine.toReplayDefinition(opsAgent),
			command,
		);

		expect(replay.report.mode).toBe("replay");
		expect(replay.state).toEqual(handle.result);
	});

	it("denies an undeclared broker token with a typed capability denial", async () => {
		const engine = createWorkflowEngine();
		const unauthorized = agent<null, unknown>({
			name: "unauthorized-ops",
			// No token:acme-cloud capability declared.
			async run(ctx) {
				return ctx.token({ provider: TOKEN_PROVIDER, scope: TOKEN_SCOPE });
			},
		});

		let denial: unknown;
		try {
			await engine.start(unauthorized, null);
		} catch (error) {
			denial = error;
		}

		expect(denial).toBeInstanceOf(CapabilityDeniedError);
		// SAFETY: assertion to `nial as CapabilityDeniedError).` is required at this boundary.
		expect((denial as CapabilityDeniedError).capability).toBe(
			`token:${TOKEN_PROVIDER}`,
		);
	});

	it("mints exactly the broker token the pact contract pins", async () => {
		// SAFETY: assertion to `ON.parse( await readFile( new URL( "../contracts/pacts/agent-to-token-broker.pact.json", import.meta.url, ), "utf8", ), ` is required at this boundary.
		const pact = JSON.parse(
			await readFile(
				new URL(
					"../contracts/pacts/agent-to-token-broker.pact.json",
					import.meta.url,
				),
				"utf8",
			),
		) as {
			interactions: {
				request: { body: unknown };
				response: { body: { ref: string } };
			}[];
		};
		const interaction = pact.interactions[0];
		expect(interaction?.request.body).toEqual({
			provider: TOKEN_PROVIDER,
			scope: TOKEN_SCOPE,
		});

		const engine = createWorkflowEngine();
		const handle = await engine.start(
			opsAgent,
			parseOrderCommand({ orderId: "ord-3" }),
		);
		expect(handle.result?.tokenRef).toBe(interaction?.response.body.ref);
	});
});
