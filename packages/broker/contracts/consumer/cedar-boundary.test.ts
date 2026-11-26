import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCedarRequest, createCedarGatePlane } from "../../src/cedar.js";
import type { JsonValue } from "../../src/json.js";
import type { FetchLike } from "../../src/planes.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/broker_policy_cedar.pact.json"),
		"utf8",
	),
);

function mockFetchFor(interaction: {
	request: { path: string };
	response: { status: number; body: JsonValue };
}): FetchLike {
	return async (url) => {
		expect(url.endsWith(interaction.request.path)).toBe(true);
		return {
			status: interaction.response.status,
			json: async () => interaction.response.body,
		};
	};
}

const gateInput = (bindleId: string) => ({
	request: {
		subject: { kind: "service", id: "broker:yard-1" },
		action: "hobo:broker:resolve",
		resource: { kind: "bindle", id: bindleId },
		phase: "plan",
	},
	costQuota: { quota: "deployments/day", used: 2, limit: 20 },
});

describe("Cedar gate-plane boundary (consumer side of the pact)", () => {
	it("maps the Policy IR request onto Cedar entities", () => {
		const request = buildCedarRequest(gateInput("bindle:checkout"));
		expect(request.principal).toBe('Service::"broker:yard-1"');
		expect(request.action).toBe('Action::"hobo:broker:resolve"');
		expect(request.resource).toBe('Bindle::"bindle:checkout"');
	});

	it("lowers a Cedar Allow onto the gate decision with policy ids", async () => {
		const interaction = pact.interactions[0];
		const plane = createCedarGatePlane({
			endpoint: "http://cedar.local:8180",
			fetchFn: mockFetchFor(interaction),
		});
		const decision = await plane.evaluate(gateInput("bindle:checkout"));
		expect(decision.effect).toBe("allow");
		expect(decision.reasons).toHaveLength(0);
		expect(decision.events[0]?.type).toBe("policy.Decided");
		expect(decision.events[0]?.policyIds).toEqual(
			interaction.response.body.diagnostics.reason,
		);
	});

	it("lowers a Cedar Deny onto a policy-plane rejection and fails closed on outage", async () => {
		const interaction = pact.interactions[1];
		const plane = createCedarGatePlane({
			endpoint: "http://cedar.local:8180",
			fetchFn: mockFetchFor(interaction),
		});
		const decision = await plane.evaluate(gateInput("bindle:frozen"));
		expect(decision.effect).toBe("deny");
		expect(decision.reasons[0]?.code).toBe("policy-denied");

		const broken = createCedarGatePlane({
			endpoint: "http://cedar.local:8180",
			fetchFn: async () => {
				throw new Error("connection refused");
			},
		});
		const failed = await broken.evaluate(gateInput("bindle:checkout"));
		expect(failed.effect).toBe("deny");
		expect(failed.reasons[0]?.code).toBe("policy-engine-unavailable");
	});
});
