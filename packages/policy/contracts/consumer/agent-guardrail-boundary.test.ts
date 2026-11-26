import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { evaluateAgentGuardrail } from "../../src/agent-guardrails.js";
import { POLICY_IR_SCHEMA_VERSION } from "../../src/policy-ir.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(join(packageRoot, "../pacts/agent_guardrail.pact.json"), "utf8"),
);

describe("agent guardrail Gateway consumer boundary", () => {
	it("returns require-approval for high-risk deploy without approval", () => {
		const result = evaluateAgentGuardrail({
			request: {
				schemaVersion: POLICY_IR_SCHEMA_VERSION,
				subject: {
					kind: "agent",
					id: "agent:tenant-a/agent-deploy",
					delegatedBy: "user:platform-admin",
				},
				action: "hobo:deployment:apply",
				resource: { kind: "deployment", id: "deployment:checkout-prod" },
				phase: "apply",
				context: { costEstimateUsd: 0 },
			},
			policy: {
				agentId: "tenant-a/agent-deploy",
				actionClasses: {
					read: "auto-allow",
					write: "require-approval",
					deploy: "require-approval",
					destroy: "deny",
					token: "require-approval",
					admin: "deny",
				},
				spendCapUsd: 50,
				allowedApprovers: ["user:platform-admin"],
				destroyGrant: { granted: false, grantId: null },
			},
			enforcementPoint: "gateway",
		});
		const interaction = pact.interactions[0];

		expect(result.decision.effect).toBe(interaction.response.body.effect);
		expect(result.actionClass).toBe(interaction.response.body.actionClass);
	});

	it("denies destroy without explicit grant", () => {
		const result = evaluateAgentGuardrail({
			request: {
				schemaVersion: POLICY_IR_SCHEMA_VERSION,
				subject: {
					kind: "agent",
					id: "agent:tenant-a/agent-deploy",
				},
				action: "hobo:deployment:destroy",
				resource: { kind: "deployment", id: "deployment:checkout-prod" },
				phase: "apply",
				context: {},
			},
			policy: {
				agentId: "tenant-a/agent-deploy",
				actionClasses: {
					read: "auto-allow",
					write: "auto-allow",
					deploy: "auto-allow",
					destroy: "auto-allow",
					token: "auto-allow",
					admin: "auto-allow",
				},
				destroyGrant: { granted: false, grantId: null },
			},
		});
		const interaction = pact.interactions[1];

		expect(result.decision.effect).toBe(interaction.response.body.effect);
		expect(
			result.events.some((event) => event.type === "agent.DestroyDenied"),
		).toBe(true);
	});
});
