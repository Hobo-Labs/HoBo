import { describe, expect, it } from "vitest";

import {
	evaluateCanDeploy,
	replayCanDeployDecision,
} from "../src/can-deploy.js";
import { createBoundaryContract } from "../src/contract-ir.js";

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

const plan = {
	objective: "cost",
	resources: [{ name: "checkout-api", port: "hobo:http/handler" }],
};

describe("can-deploy engine", () => {
	it("accepts a candidate whose contract adds a field (compatible)", () => {
		const candidate = createBoundaryContract({
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

		const result = evaluateCanDeploy({
			target: "prod",
			deployedState: { contracts: [deployedContract] },
			candidate: { plan, contracts: [candidate] },
		});

		expect(result.ok).toBe(true);
		expect(result.summary).toBe("compatible");
		expect(result.matrix[0]?.compatible).toBe(true);
		expect(result.events.at(-1)?.type).toBe("compat.GatePassed");
	});

	it("rejects a candidate that removes a required field, with a machine-readable reason", () => {
		const candidate = createBoundaryContract({
			id: "contract-orders-http",
			version: "3.0.0",
			edge: {
				kind: "event",
				producer: "checkout-api@3.0.0",
				consumer: "checkout-worker@1.7.0",
				channel: "orders.http",
				operation: "order.created",
			},
			requiredLayout: {
				format: "json-schema",
				requiredFields: ["id", "total"],
				providedFields: ["id", "total"],
			},
		});

		const result = evaluateCanDeploy({
			target: "prod",
			deployedState: { contracts: [deployedContract] },
			candidate: { plan, contracts: [candidate] },
		});

		expect(result.ok).toBe(false);
		expect(result.reasons[0]?.code).toBe("required-field-removed");
		expect(result.reasons[0]?.fields).toContain("tenantId");
		expect(result.summary).toMatch(/blocked/);
		expect(result.suggestedFixes.length).toBeGreaterThan(0);
		expect(result.events.at(-1)?.type).toBe("compat.GateFailed");

		// the decision replays deterministically from its event
		const replayed = replayCanDeployDecision(result.events);
		expect(replayed.ok).toBe(false);
		expect(replayed.reasons[0]?.fields).toContain("tenantId");
	});

	it("treats a brand-new channel as compatible", () => {
		const candidate = createBoundaryContract({
			id: "contract-new",
			version: "1.0.0",
			edge: {
				kind: "event",
				producer: "new-svc@1.0.0",
				consumer: "n/a",
				channel: "brand.new",
				operation: "thing.created",
			},
			requiredLayout: {
				format: "json-schema",
				requiredFields: ["id"],
				providedFields: ["id"],
			},
		});
		const result = evaluateCanDeploy({
			target: "prod",
			deployedState: { contracts: [deployedContract] },
			candidate: { plan, contracts: [candidate] },
		});
		expect(result.ok).toBe(true);
		expect(result.matrix[0]?.deployedVersion).toBeNull();
	});
});
