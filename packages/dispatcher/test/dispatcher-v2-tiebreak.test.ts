import { describe, expect, it } from "vitest";
import { decideDispatchV2 } from "../src/dispatcher-v2.js";
import { zeroCostCommitmentDispatchScenario } from "./dispatcher-v2-fixtures.js";

describe("dispatcher v2 tie-break (§10.11 / §7.4)", () => {
	it("10.11 prefers sooner projected waste expiry among zero incremental ties", () => {
		const decision = decideDispatchV2({
			dispatchId: "dispatch-tie",
			category: "runner",
			candidates: [
				{
					providerId: "provider-later",
					scenario: zeroCostCommitmentDispatchScenario(
						"provider-later",
						"2026-01-31T23:59:59Z",
					),
				},
				{
					providerId: "provider-sooner",
					scenario: zeroCostCommitmentDispatchScenario(
						"provider-sooner",
						"2026-01-15T00:00:00Z",
					),
				},
			],
		});
		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.selectedProvider).toBe("provider-sooner");
	});
});
