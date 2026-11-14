// The CD chaos lane (plan 0024 WP20): kill a reconciler mid-converge,
// partition an agent, store failover, source registry outage, an agent
// flapping conditions (never NO_RUN) and mass lease loss (failover budget
// holds; nothing purged early). Chaos never ends wedged.
import { CD_CHAOS_FAULTS, runCdChaos } from "@hobo/conformance";
import { describe, expect, it } from "vitest";
import { type ChaosMutant, refChaosHarness } from "../src/index.js";
import { failed, summary } from "./report.js";

describe("CD chaos lane", () => {
	it("every fault keeps its invariants and recovers (never wedged)", async () => {
		const report = await runCdChaos(refChaosHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toHaveLength(CD_CHAOS_FAULTS.length * 2);
	});
	it.each<[ChaosMutant, string]>([
		["reapplies-after-crash", "reconciler-killed-mid-converge:invariants"],
		["lost-checkpoint", "store-failover:invariants"],
		["trusts-flapping-agent", "agent-flapping-conditions:invariants"],
		["failover-storm", "mass-lease-loss:invariants"],
		["purges-early", "mass-lease-loss:invariants"],
		["wedges-after-outage", "source-registry-outage:recovers"],
		["trusts-payload", "source-registry-outage:invariants"],
	])("catches a system that %s (%s)", async (mutant, assertion) => {
		expect(failed(await runCdChaos(refChaosHarness(mutant)))).toContain(assertion);
	});
});
