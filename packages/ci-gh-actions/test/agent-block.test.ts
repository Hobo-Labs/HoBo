import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import {
	parseCiAgentBlock,
	parseCiProjectConfig,
} from "../src/project-config.js";

const project = z
	.record(z.string(), z.json())
	.parse(
		JSON.parse(
			readFileSync(
				join(import.meta.dirname, "../examples/project/ci.json"),
				"utf8",
			),
		),
	);
const agent = {
	mode: "suggest",
	engines: [
		{
			id: "primary",
			kind: "anthropic",
			model: "claude-sonnet-4-5",
			credential: "env:ANTHROPIC_API_KEY",
		},
	],
};
const withAgent = (block: z.infer<ReturnType<typeof z.json>>) =>
	JSON.stringify({ ...project, agent: block });

it("carries the optional agent block without changing the rest of the project", () => {
	const plain = parseCiProjectConfig(JSON.stringify(project));
	expect(parseCiProjectConfig(withAgent(agent))).toEqual(plain);
	expect(parseCiAgentBlock(JSON.stringify(project))).toBeUndefined();
	expect(JSON.parse(parseCiAgentBlock(withAgent(agent)) ?? "")).toEqual(agent);
});

it("refuses a credential value anywhere in the agent block, without echoing it", () => {
	const secret = `sk_live_${"a1B2".repeat(6)}`;
	const leaked = withAgent({
		...agent,
		engines: [{ ...agent.engines[0], credential: secret }],
	});
	for (const parse of [parseCiProjectConfig, parseCiAgentBlock]) {
		let message = "";
		try {
			parse(leaked);
		} catch (error) {
			message = error instanceof Error ? error.message : "";
		}
		expect(message).toMatch(/^invalid CI/);
		expect(message).not.toContain(secret);
	}
});

it("refuses an agent block that is not an object", () => {
	expect(() => parseCiProjectConfig(withAgent("on"))).toThrow(
		"invalid CI project configuration",
	);
	expect(() => parseCiAgentBlock(withAgent(["on"]))).toThrow(
		/^invalid CI agent block/,
	);
	expect(() => parseCiAgentBlock("{")).toThrow(/^invalid CI agent block/);
});
