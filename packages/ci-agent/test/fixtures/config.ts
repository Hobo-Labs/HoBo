import type { z } from "zod";
import {
	type AgentConfigDocumentSchema,
	type AgentMode,
	agentPolicies,
	parseAgentConfig,
} from "../../src/config.js";

type Document = z.input<typeof AgentConfigDocumentSchema>;
/** The policy blocks a test may override; everything else takes its default. */
export type PolicyOverrides = Pick<Document, "queue" | "resolution" | "budget">;

export function testConfig(mode: AgentMode, overrides: PolicyOverrides = {}) {
	return parseAgentConfig(
		JSON.stringify({
			mode,
			engines: [{ id: "m", kind: "gateway", model: "openai/gpt-5.1" }],
			...overrides,
		}),
	);
}

export const testPolicies = (overrides: PolicyOverrides = {}) =>
	agentPolicies(testConfig("observe", overrides));
