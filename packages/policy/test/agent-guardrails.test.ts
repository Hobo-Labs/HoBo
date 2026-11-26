import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	AGENT_GUARDRAILS_ENGINE_ID,
	canAgentProceed,
	classifyActionClass,
	evaluateAgentGuardrail,
	rebuildAgentGuardrailState,
} from "../src/agent-guardrails.js";
import type { JsonObject } from "../src/json.js";
import { POLICY_IR_SCHEMA_VERSION } from "../src/policy-ir.js";

function decisionRequest(overrides: JsonObject = {}) {
	const context = {
		owner: {
			tenantId: "tenant-a",
			campId: "camp-prod",
			agentId: "agent-deploy",
		},
		actorId: "user:platform-admin",
		environment: "prod",
		costEstimateUsd: 0,
		correlationId: "corr-633",
		occurredAt: "2026-07-01T12:00:00.000Z",
		// SAFETY: assertion required at this I/O or test boundary.
		...(overrides.context as JsonObject | undefined),
	};
	return {
		schemaVersion: POLICY_IR_SCHEMA_VERSION,
		subject: {
			kind: "agent",
			id: "agent:tenant-a/agent-deploy",
			delegatedBy: "user:platform-admin",
			roles: ["deployer"],
			scopes: ["hobo:deployment:apply"],
		},
		action: "hobo:deployment:apply",
		resource: {
			kind: "deployment",
			id: "deployment:checkout-prod",
		},
		phase: "apply",
		context,
		...overrides,
	};
}

function agentPolicy(overrides: JsonObject = {}) {
	return {
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
		allowedApprovers: ["user:platform-admin", "user:finance-admin"],
		destroyGrant: { granted: false, grantId: null },
		...overrides,
	};
}

function meteringView(scopeCosts: JsonObject = {}, seq = 10) {
	return { seq, scopeCosts };
}

function obligationSatisfied(overrides: JsonObject = {}) {
	return {
		type: "policy.ObligationSatisfied",
		seq: 3,
		occurredAt: "2026-07-01T12:05:00.000Z",
		correlationId: "corr-633",
		data: {
			id: "approval:tenant-a/agent-deploy:hobo:deployment:apply",
			effectRef: "agent-guardrail:tenant-a/agent-deploy:hobo:deployment:apply",
			agentId: "tenant-a/agent-deploy",
			action: "hobo:deployment:apply",
			approverId: "user:platform-admin",
			...overrides,
		},
	};
}

describe("agent guardrails", () => {
	it("classifyActionClass maps gateway and runtime actions consistently", () => {
		expect(classifyActionClass("hobo:deployment:destroy")).toBe("destroy");
		expect(classifyActionClass("hobo:resource.delete")).toBe("destroy");
		expect(classifyActionClass("hobo:deployment:apply")).toBe("deploy");
		expect(classifyActionClass("hobo:deployment:get")).toBe("read");
		expect(classifyActionClass("hobo:token:request")).toBe("token");
	});

	it("high-risk deploy blocks on policy gate until human approval with event-sourced decisions", () => {
		const blocked = evaluateAgentGuardrail({
			request: decisionRequest(),
			policy: agentPolicy(),
			enforcementPoint: "gateway",
		});

		expect(blocked.decision.effect).toBe("require-approval");
		expect(blocked.actionClass).toBe("deploy");
		expect(blocked.events.map((event) => event.type)).toEqual([
			"policy.Decided",
			"agent.GuardrailBlocked",
		]);
		expect(blocked.events[0].data.evidence.engine).toBe(
			AGENT_GUARDRAILS_ENGINE_ID,
		);
		expect(canAgentProceed(blocked.events).canProceed).toBe(false);

		const approved = evaluateAgentGuardrail({
			request: decisionRequest(),
			policy: agentPolicy(),
			enforcementPoint: "runtime",
			approval: {
				decision: "approved",
				approverId: "user:platform-admin",
				approvedAt: "2026-07-01T12:01:00.000Z",
			},
		});

		expect(approved.decision.effect).toBe("allow");
		expect(approved.events[1].type).toBe("agent.GuardrailCleared");
		expect(canAgentProceed(approved.events).canProceed).toBe(true);

		const satisfied = [...blocked.events, obligationSatisfied()];
		expect(canAgentProceed(satisfied).canProceed).toBe(true);
		const rebuilt = rebuildAgentGuardrailState(satisfied);
		expect(rebuilt.policyDecision.effect).toBe("require-approval");
		expect(rebuilt.canProceed).toBe(false);
	});

	it("spend-over-cap deploy halts with require-approval instead of silent spend", () => {
		const halted = evaluateAgentGuardrail({
			request: decisionRequest({
				action: "hobo:deployment:apply",
				context: { costEstimateUsd: 12 },
			}),
			policy: agentPolicy({
				actionClasses: {
					read: "auto-allow",
					write: "auto-allow",
					deploy: "auto-allow",
					destroy: "deny",
					token: "require-approval",
					admin: "deny",
				},
				spendCapUsd: 30,
			}),
			meteringView: meteringView({
				"agent:tenant-a/agent-deploy": { cost: 25 },
			}),
		});

		expect(halted.decision.effect).toBe("require-approval");
		expect(halted.decision.reason).toMatch(/spendCapUsd/);
		expect(
			halted.events.some((event) => event.type === "spend.CapGateEvaluated"),
		).toBe(true);
		expect(canAgentProceed(halted.events).canProceed).toBe(false);

		const approved = evaluateAgentGuardrail({
			request: decisionRequest({
				action: "hobo:deployment:apply",
				context: { costEstimateUsd: 12 },
			}),
			policy: agentPolicy({
				actionClasses: {
					read: "auto-allow",
					write: "auto-allow",
					deploy: "auto-allow",
					destroy: "deny",
					token: "require-approval",
					admin: "deny",
				},
				spendCapUsd: 30,
			}),
			meteringView: meteringView({
				"agent:tenant-a/agent-deploy": { cost: 25 },
			}),
			approval: {
				decision: "approved",
				approverId: "user:finance-admin",
				approvedAt: "2026-07-01T12:02:00.000Z",
			},
		});

		expect(approved.decision.effect).toBe("allow");
		expect(approved.decision.approvals[0].approverId).toBe(
			"user:finance-admin",
		);
	});

	it("destroy without explicit grant is denied with auditable policy.Decided", () => {
		const denied = evaluateAgentGuardrail({
			request: decisionRequest({
				action: "hobo:deployment:destroy",
				resource: { kind: "deployment", id: "deployment:checkout-prod" },
			}),
			policy: agentPolicy({
				actionClasses: {
					read: "auto-allow",
					write: "auto-allow",
					deploy: "auto-allow",
					destroy: "auto-allow",
					token: "auto-allow",
					admin: "auto-allow",
				},
				destroyGrant: { granted: false, grantId: null },
			}),
		});

		expect(denied.decision.effect).toBe("deny");
		expect(denied.decision.reason).toMatch(
			/destroy denied without explicit grant/,
		);
		expect(
			denied.events.some((event) => event.type === "agent.DestroyDenied"),
		).toBe(true);
		expect(canAgentProceed(denied.events).canProceed).toBe(false);
	});

	it("destroy proceeds only with explicit grant recorded on policy or request context", () => {
		const granted = evaluateAgentGuardrail({
			request: decisionRequest({
				action: "hobo:deployment:destroy",
				context: {
					destroyGrant: {
						granted: true,
						grantId: "grant:checkout-prod-destroy",
					},
				},
			}),
			policy: agentPolicy({
				actionClasses: {
					read: "auto-allow",
					write: "auto-allow",
					deploy: "auto-allow",
					destroy: "auto-allow",
					token: "auto-allow",
					admin: "auto-allow",
				},
			}),
		});

		expect(granted.decision.effect).toBe("allow");
		expect(granted.events[1].type).toBe("agent.GuardrailCleared");
	});

	it("adversarial: forged approval obligation does not release a blocked high-risk action", () => {
		const blocked = evaluateAgentGuardrail({
			request: decisionRequest(),
			policy: agentPolicy(),
		});

		const forged = [
			...blocked.events,
			obligationSatisfied({
				id: "approval:other-agent",
				effectRef: "agent-guardrail:other-agent:hobo:deployment:apply",
				agentId: "tenant-a/other-agent",
				action: "hobo:deployment:destroy",
			}),
		];

		expect(canAgentProceed(forged).canProceed).toBe(false);
	});

	it("adversarial: denied action class stays denied even with approval present", () => {
		const denied = evaluateAgentGuardrail({
			request: decisionRequest({ action: "hobo:admin:impersonate" }),
			policy: agentPolicy(),
			approval: {
				decision: "approved",
				approverId: "user:platform-admin",
				approvedAt: "2026-07-01T12:03:00.000Z",
			},
		});

		expect(denied.decision.effect).toBe("deny");
		expect(denied.decision.reason).toMatch(/admin actions are denied/);
	});

	it("adversarial: read actions auto-allow without approval when spend cap is not exceeded", () => {
		const allowed = evaluateAgentGuardrail({
			request: decisionRequest({
				action: "hobo:deployment:get",
				context: { costEstimateUsd: 0 },
			}),
			policy: agentPolicy(),
		});

		expect(allowed.decision.effect).toBe("allow");
		expect(allowed.events[1].type).toBe("agent.GuardrailCleared");
	});
});

describe("agent guardrail consumer boundary", () => {
	const packageRoot = dirname(fileURLToPath(import.meta.url));
	const pact = JSON.parse(
		readFileSync(
			join(packageRoot, "../contracts/pacts/agent_guardrail.pact.json"),
			"utf8",
		),
	);

	it("matches require-approval pact for high-risk deploy at gateway", () => {
		const blocked = evaluateAgentGuardrail({
			request: decisionRequest(),
			policy: agentPolicy(),
			enforcementPoint: "gateway",
		});
		const interaction = pact.interactions[0];

		expect(blocked.decision.effect).toBe(interaction.response.body.effect);
		expect(blocked.actionClass).toBe(interaction.response.body.actionClass);
		expect(blocked.events.map((event) => ({ type: event.type }))).toEqual(
			interaction.response.body.events,
		);
	});

	it("matches deny pact for destroy without explicit grant", () => {
		const denied = evaluateAgentGuardrail({
			request: decisionRequest({
				action: "hobo:deployment:destroy",
			}),
			policy: agentPolicy({
				actionClasses: {
					read: "auto-allow",
					write: "auto-allow",
					deploy: "auto-allow",
					destroy: "auto-allow",
					token: "auto-allow",
					admin: "auto-allow",
				},
			}),
		});
		const interaction = pact.interactions[1];

		expect(denied.decision.effect).toBe(interaction.response.body.effect);
		expect(
			denied.events.some((event) => event.type === "agent.DestroyDenied"),
		).toBe(true);
		expect(denied.events.some((event) => event.type === "policy.Decided")).toBe(
			true,
		);
	});
});
