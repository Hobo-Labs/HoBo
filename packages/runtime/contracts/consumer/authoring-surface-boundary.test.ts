import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { at, first } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import { agent } from "../../src/agent.js";
import { CapabilityDeniedError } from "../../src/errors.js";
import type { JsonObject, JsonValue } from "../../src/json.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
// SAFETY: assertion to `JSON.parse( readFileSync( join(packageRoot, "../pacts/authoring_surface.pact.json"), "utf8", ), ) as { interactions: { d` is required at this boundary.
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/authoring_surface.pact.json"),
		"utf8",
	),
) as {
	interactions: {
		description: string;
		response: { status: number; body: JsonObject };
	}[];
};

interface CheckoutState {
	reserved: boolean;
	charged: boolean;
}

describe("authoring-surface journal consumer boundary", () => {
	it("journals run.* in the order the pact expects for a completed run", async () => {
		const engine = createWorkflowEngine();
		const checkout = defineWorkflow<{ id: string }, CheckoutState>({
			name: "checkout",
			async run(ctx, args) {
				const reserved = await ctx.step("reserve", () => ({
					id: args.id,
					reserved: true,
				}));
				const charged = await ctx.step("charge", () => ({ charged: true }));
				return { reserved: reserved.reserved, charged: charged.charged };
			},
		});

		const handle = await engine.start(checkout, { id: "order-1" });
		const journal = await engine.journal(handle.runId);
		const interaction = first(pact.interactions);

		expect(handle.status).toBe(interaction.response.body.status);
		expect(journal.map((event) => event.type)).toEqual(
			interaction.response.body.eventTypes,
		);
	});

	it("does not re-run a journaled step when resuming after a restart", async () => {
		const interaction = at(pact.interactions, 1);
		const engine = createWorkflowEngine();
		let reserveInvocations = 0;
		let crashed = false;

		const checkout = defineWorkflow<{ id: string }, CheckoutState>({
			name: "checkout",
			async run(ctx, args) {
				const reserved = await ctx.step("reserve", () => {
					reserveInvocations += 1;
					return { id: args.id, reserved: true };
				});
				if (!crashed) {
					crashed = true;
					throw new Error("SIMULATED_HOST_CRASH");
				}
				const charged = await ctx.step("charge", () => ({ charged: true }));
				return { reserved: reserved.reserved, charged: charged.charged };
			},
		});

		// First attempt crashes after the first step is journaled.
		await expect(engine.start(checkout, { id: "order-1" })).rejects.toThrow(
			"SIMULATED_HOST_CRASH",
		);

		// A new engine over the same journal resumes and completes.
		const resumeEngine = createWorkflowEngine({ store: engine.store });
		const handle = await resumeEngine.resume(checkout, "run-1", {
			id: "order-1",
		});
		const journal = await resumeEngine.journal("run-1");

		expect(handle.status).toBe(interaction.response.body.status);
		expect(reserveInvocations).toBe(
			interaction.response.body.reservedInvocations,
		);
		expect(journal.at(-1)?.type).toBe(interaction.response.body.finalEventType);
	});

	it("denies an undeclared agent tool with a typed capability denial", async () => {
		const interaction = at(pact.interactions, 2);
		const engine = createWorkflowEngine();
		const support = agent<string, JsonValue>({
			name: "support",
			tools: [{ name: "search", run: (q) => `results:${String(q)}` }],
			async run(ctx, input) {
				// tool:secret was never declared → deny-by-default.
				return ctx.tool("secret", input);
			},
		});

		let denial: CapabilityDeniedError | undefined;
		try {
			await engine.start(support, "ping");
		} catch (error) {
			// SAFETY: assertion to `ror as CapabilityDeniedError; ` is required at this boundary.
			denial = error as CapabilityDeniedError;
		}

		expect(denial).toBeInstanceOf(CapabilityDeniedError);
		expect(denial?.code).toBe(interaction.response.body.code);
		expect(denial?.capability).toBe(interaction.response.body.capability);
	});
});
