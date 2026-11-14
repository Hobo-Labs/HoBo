import { describe, expect, it } from "vitest";

import {
	matchResource,
	type PlannerRegistry,
	type ResourceDefinition,
	type ResourceIntent,
} from "../src/index.js";

// Routing, not refusal: a provider that is not answering is routed around,
// and the resource lands on the next cheapest provider that satisfies it.
// Neon being down never stops a deployment that has another vendor configured.

function postgres(
	providerId: string,
	marginalPrice: string,
): ResourceDefinition {
	return {
		id: `${providerId}:sql`,
		providerId,
		port: "sql",
		features: [],
		regions: ["us-east-1"],
		specificity: 10,
		priority: 0,
		cost: { sku: "sql-standard", unit: "gb", marginalPrice },
		satisfies: (req) =>
			req.port === "sql" ? { kind: "full" } : { kind: "none" },
	};
}

const registry: PlannerRegistry = {
	catalogHash: "sha256:availability-test",
	definitions: () => [
		postgres("neon", "0.001"),
		postgres("supabase", "0.002"),
		postgres("prisma", "0.003"),
	],
	providers: () => ["neon", "supabase", "prisma"],
};

const intent: ResourceIntent = {
	name: "db",
	port: "sql",
	require: [],
	prefer: [],
	negotiation: "require",
	deps: [],
	objective: "min-cost",
};

describe("availability-aware matching", () => {
	it("chooses the cheapest provider when all are up", () => {
		const outcome = matchResource(intent, registry);
		expect(outcome.ok && outcome.decision.providerId).toBe("neon");
	});

	it("routes to the next cheapest when Neon is unavailable", () => {
		const outcome = matchResource(
			intent,
			registry,
			undefined,
			undefined,
			new Set(["neon"]),
		);
		expect(outcome.ok && outcome.decision.providerId).toBe("supabase");
		expect(outcome.ok && outcome.decision.rejectedCandidates).toContainEqual({
			definitionId: "neon:sql",
			reason: "provider-unavailable",
		});
	});

	it("keeps routing as more providers go down", () => {
		const outcome = matchResource(
			intent,
			registry,
			undefined,
			undefined,
			new Set(["neon", "supabase"]),
		);
		expect(outcome.ok && outcome.decision.providerId).toBe("prisma");
	});

	it("says every satisfying provider is down only when none is left", () => {
		const outcome = matchResource(
			intent,
			registry,
			undefined,
			undefined,
			new Set(["neon", "supabase", "prisma"]),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.remediation.code).toBe("placement.providers-unavailable");
		expect(outcome.remediation.remediation).toMatch(/neon, prisma, supabase/);
	});
});
