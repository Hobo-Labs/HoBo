import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateCanDeploy } from "../../src/can-deploy.js";
import { createBoundaryContract } from "../../src/contract-ir.js";
import { evaluateGatekeeper } from "../../src/gatekeeper.js";
import { isJsonNumber } from "../../src/json.js";
import {
	definePolicyRule,
	evaluatePolicyPack,
	type PolicyPack,
} from "../../src/policy-pack.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));

function loadPact(name: string) {
	return JSON.parse(readFileSync(join(packageRoot, "../pacts/", name), "utf8"));
}

const deployedContract = createBoundaryContract({
	id: "contract-orders-http",
	version: "1.2.0",
	edge: {
		kind: "event",
		producer: "checkout-api@1.2.0",
		consumer: "checkout-worker@1.7.0",
		channel: "orders.http",
		operation: "order.created",
	},
	requiredLayout: {
		format: "json-schema",
		requiredFields: ["id", "tenantId", "total"],
		providedFields: ["id", "tenantId", "total"],
	},
});

const compatibleCandidate = createBoundaryContract({
	id: "contract-orders-http",
	version: "1.3.0",
	edge: {
		kind: "event",
		producer: "checkout-api@2.4.0",
		consumer: "checkout-worker@1.7.0",
		channel: "orders.http",
		operation: "order.created",
	},
	requiredLayout: {
		format: "json-schema",
		requiredFields: ["id", "tenantId", "total"],
		providedFields: ["id", "tenantId", "total", "currency"],
	},
});

const request = {
	subject: { kind: "agent", id: "spiffe://tenant-a/yard/prod/agent/deployer" },
	action: "hobo:delta:promote",
	resource: { kind: "deployment", id: "deployment:checkout-prod" },
	phase: "apply",
	context: { target: "prod" },
};

describe("Gatekeeper -> Contract Engine consumer contract", () => {
	it("returns a compatible can-deploy verdict matching the recorded interaction", () => {
		const pact = loadPact("gatekeeper-contract-engine.pact.json");
		const interaction = pact.interactions[0];
		expect(pact.consumer.name).toBe("Gatekeeper Verify");
		expect(interaction.request.body.target).toBe("prod");

		const result = evaluateCanDeploy({
			target: "prod",
			deployedState: { contracts: [deployedContract] },
			candidate: {
				plan: { objective: "cost", resources: [] },
				contracts: [compatibleCandidate],
			},
		});

		expect(result.ok).toBe(interaction.response.body.ok);
		expect(result.summary).toBe(interaction.response.body.summary);
		expect(Array.isArray(result.matrix)).toBe(true);
	});
});

describe("Gatekeeper -> Policy Engine consumer contract", () => {
	it("produces a require-approval policy decision with evidence + obligations", () => {
		const pact = loadPact("gatekeeper-policy-engine.pact.json");
		const interaction = pact.interactions[0];
		expect(pact.provider.name).toBe("Built-in Policy Engine");

		const pack: PolicyPack = {
			id: "yard-prod-governance",
			version: "1.0.0",
			rules: [
				definePolicyRule({
					id: "prod-deploy-requires-approval",
					when: (candidate) =>
						candidate.action === interaction.request.body.action,
					decide: () => ({
						effect: "require-approval",
						reason: "production deploy requires approval",
						obligations: [
							{
								id: "obl:approval:checkout-prod",
								kind: "require-approval",
								satisfied: false,
							},
						],
					}),
				}),
			],
		};

		const evaluation = evaluatePolicyPack({ request, pack });
		expect(evaluation.decision.effect).toBe(interaction.response.body.effect);
		expect(evaluation.decision.evidence.engine).toBeTruthy();
		expect(evaluation.decision.evidence.policyIds.length).toBeGreaterThan(0);
		expect(evaluation.decision.obligations.length).toBeGreaterThan(0);
	});
});

describe("Policy Engine -> Audit Log consumer contract", () => {
	it("emits a policy.Decided event the audit boundary accepts", () => {
		const pact = loadPact("policy-engine-audit-log.pact.json");
		const interaction = pact.interactions[0];
		expect(interaction.request.body.type).toBe("policy.Decided");

		const evaluation = evaluatePolicyPack({ request });
		expect(evaluation.event.type).toBe(interaction.request.body.type);
		expect(evaluation.event.data.effect).toBeTruthy();
		expect(evaluation.event.data.evidence).toBeTruthy();
	});
});

describe("Gatekeeper -> Obligation Engine + Cost/Quota consumer contracts", () => {
	it("does not block when obligations are satisfied and quota is available", () => {
		const obligationPact = loadPact("gatekeeper-obligation-engine.pact.json");
		const costPact = loadPact("gatekeeper-cost-quota.pact.json");

		const result = evaluateGatekeeper({
			request,
			deployedState: { contracts: [deployedContract] },
			candidate: {
				plan: { objective: "cost", resources: [] },
				contracts: [compatibleCandidate],
			},
			obligations: [
				{
					id: "obl:canary:checkout-prod",
					kind: "require-canary",
					satisfied: true,
				},
			],
			costQuota: {
				quota: costPact.interactions[0].request.body.quota,
				used: 7,
				limit: 20,
			},
		});

		// obligation boundary: recorded blocked:false
		expect(obligationPact.interactions[0].response.body.blocked).toBe(false);
		expect(result.obligations.every((obligation) => obligation.satisfied)).toBe(
			true,
		);
		// cost boundary: recorded ok:true with numeric remaining/limit
		expect(result.costQuota.ok).toBe(true);
		expect(isJsonNumber(result.costQuota.remaining)).toBe(true);
		expect(result.decision).toBe("allow");
	});
});
