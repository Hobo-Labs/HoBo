import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	allowDecision,
	parseMinAvailabilitySpec,
	parseTenantId,
	type RoutingPlan,
	type TrafficRoutingPort,
} from "@hobo/core";
import { test } from "vitest";
import { executeRoutingCutover } from "../src/traffic-routing/cutover.js";
import { synthesizeRoutingPlan } from "../src/traffic-routing/synthesize.js";

test("executes the supervisor/cutover library boundary Pact under provider faults", async () => {
	// SAFETY: committed Pact fixture is parsed at this test I/O boundary.
	const pact = JSON.parse(
		readFileSync(
			new URL("../contracts/pacts/hosting-cutover.pact.json", import.meta.url),
			"utf8",
		),
	) as {
		consumer: { name: string };
		provider: { name: string };
		interactions: {
			description: string;
			request: {
				operation: string;
				input: { fault: string; minHealthyBackends: number };
			};
			response: {
				ok: boolean;
				refused: boolean;
				rolledBack: boolean;
				recoveryPending: boolean;
			};
		}[];
	};
	assert.equal(pact.consumer.name, "HoboHostingTransitionSupervisor");
	assert.equal(pact.provider.name, "StationRoutingCutover");
	assert.equal(pact.interactions.length, 4);
	const tenantId = parseTenantId("tenant-pact");
	const policyDecision = allowDecision("pact-policy", {
		subject: { identity: "router", tenantId, tags: [] },
		action: "routing.plan",
		resource: { kind: "service", id: "checkout", tenantId },
	});
	for (const interaction of pact.interactions) {
		assert.equal(interaction.request.operation, "executeRoutingCutover");
		const observed = new Map<string, RoutingPlan>();
		let attempts = 0;
		const { fault, minHealthyBackends } = interaction.request.input;
		const port: TrafficRoutingPort = {
			provider: "other",
			status: async (planId) =>
				observed.has(planId)
					? { planId, active: true, realized: "full", notes: [] }
					: null,
			apply: async (plan) => {
				attempts++;
				if (fault === "apply-response-lost") throw new Error("response lost");
				if (fault === "restore-unrealized" && attempts > 1)
					return {
						planId: plan.planId,
						provider: "other",
						realized: "none",
						notes: ["restore failed"],
					};
				observed.set(plan.planId, plan);
				return {
					planId: plan.planId,
					provider: "other",
					realized: "full",
					notes: [],
				};
			},
		};
		const prior = synthesizeRoutingPlan({
			topology: {
				service: "checkout",
				tenantId,
				stationId: "station:pact",
				backends: [
					{ id: "a", service: "checkout", healthy: true, weight: 100 },
				],
			},
			policyDecision,
			planId: "plan:pact:incumbent",
			weightStrategy: "static",
		});
		if (prior.kind !== "plan") throw new Error("invalid Pact baseline");
		observed.set(prior.plan.planId, prior.plan);
		const result = await executeRoutingCutover({
			topology: {
				service: "checkout",
				tenantId,
				stationId: "station:pact",
				costRouting: "stateless",
				backends: [
					{ id: "a", service: "checkout", healthy: true },
					{ id: "b", service: "checkout", healthy: true },
				],
			},
			policyDecision,
			port,
			fromBackendId: "a",
			toBackendId: "b",
			precondition: {
				validation: { status: "validated" },
				mechanism: "weighted",
				incumbentPlanId: prior.plan.planId,
				incumbentPlan: prior.plan,
			},
			healthGate: () => fault !== "restore-unrealized",
			restorationHealthGate: () => true,
			beforeApply: async () => {},
			availability: parseMinAvailabilitySpec({ minHealthyBackends }),
		});
		assert.deepEqual(
			{
				ok: result.ok,
				refused: result.refused,
				rolledBack: result.rolledBack,
				recoveryPending: result.recoveryPending,
			},
			interaction.response,
			interaction.description,
		);
		if (fault === "apply-response-lost") assert.equal(attempts, 1);
	}
});
