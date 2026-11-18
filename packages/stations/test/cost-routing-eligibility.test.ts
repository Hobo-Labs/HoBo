import assert from "node:assert/strict";
import { allowDecision, parseTenantId } from "@hobo/core";
import { test } from "vitest";
import {
	type RoutingTopology,
	synthesizeRoutingPlan,
} from "../src/traffic-routing/synthesize.js";

const tenantId = parseTenantId("tenant-a");
const policyDecision = allowDecision("test", {
	subject: { identity: "router", tenantId, tags: [] },
	action: "routing.plan",
	resource: { kind: "service", id: "checkout", tenantId },
});
const topology: RoutingTopology = {
	service: "checkout",
	tenantId,
	stationId: "station:prod",
	backends: [
		{ id: "primary", service: "checkout", costRouting: "stateless" },
		{ id: "replica", service: "checkout", costRouting: "pinned-with-replica" },
	],
};

test("cost routing accepts explicit eligibility on each backend", () => {
	assert.equal(
		synthesizeRoutingPlan({ topology, policyDecision, purpose: "cost" }).kind,
		"plan",
	);
});

test("cost routing refuses missing or single-writer backend evidence", () => {
	for (const costRouting of [undefined, "single-writer"] as const) {
		const replica =
			costRouting === undefined
				? { id: "replica", service: "checkout" }
				: { id: "replica", service: "checkout", costRouting };
		const result = synthesizeRoutingPlan({
			topology: {
				...topology,
				backends: [
					{ id: "primary", service: "checkout", costRouting: "stateless" },
					replica,
				],
			},
			policyDecision,
			purpose: "cost",
		});
		assert.equal(result.kind, "denied");
		if (result.kind === "denied") {
			assert.equal(result.reasons[0]?.code, "cost-routing-ineligible");
			assert.match(result.reasons[0]?.message ?? "", /replica/u);
		}
	}
});

test("ordinary routing does not require cost-routing evidence", () => {
	assert.equal(
		synthesizeRoutingPlan({
			topology: { ...topology, costRouting: "single-writer" },
			policyDecision,
		}).kind,
		"plan",
	);
});
