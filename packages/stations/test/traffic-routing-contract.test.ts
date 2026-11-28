import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	type PolicyDecision,
	parseMinAvailabilitySpec,
	parseTenantId,
} from "@hobo/core";
import { test } from "vitest";
import type { JsonValue } from "../src/json.js";

import { synthesizeRoutingPlan } from "../src/traffic-routing/synthesize.js";

type Interaction = Readonly<{
	request: Readonly<{
		method: string;
		path: string;
		body: Readonly<{
			topology: Readonly<{
				service: string;
				tenantId: string;
				stationId?: string;
				backends: readonly Readonly<{
					id: string;
					service: string;
				}>[];
			}>;
			availability?: unknown;
			policyDecision: Omit<PolicyDecision, "audit"> & {
				readonly audit: Omit<PolicyDecision["audit"], "tenantId"> & {
					readonly tenantId: string;
				};
			};
			planId?: string;
			now?: string;
		}>;
	}>;
	response: Readonly<{ status: number; body: JsonValue }>;
}>;

test("executes the TrafficRouting synthesis Pact fixture", () => {
	// SAFETY: assertion required at this I/O or test boundary.
	const pact = JSON.parse(
		readFileSync(
			new URL(
				"../contracts/pacts/traffic-routing-synthesis.pact.json",
				import.meta.url,
			),
			"utf8",
		),
	) as {
		consumer: { name: string };
		provider: { name: string };
		interactions: Interaction[];
	};
	assert.equal(pact.consumer.name, "HoboStations");
	assert.equal(pact.provider.name, "TrafficRoutingSynthesis");

	for (const interaction of pact.interactions) {
		assert.equal(interaction.request.method, "POST");
		assert.equal(interaction.request.path, "/traffic-routing/synthesize");
		const body = interaction.request.body;
		const tenantId = parseTenantId(body.topology.tenantId);
		const result = synthesizeRoutingPlan({
			topology: { ...body.topology, tenantId },
			...(body.availability === undefined
				? undefined
				: { availability: parseMinAvailabilitySpec(body.availability) }),
			policyDecision: {
				...body.policyDecision,
				audit: { ...body.policyDecision.audit, tenantId },
			},
			...(body.planId === undefined ? undefined : { planId: body.planId }),
			...(body.now === undefined ? undefined : { now: body.now }),
		});
		assert.deepEqual(
			{ status: result.kind === "plan" ? 200 : 403, body: result },
			interaction.response,
		);
	}
});
