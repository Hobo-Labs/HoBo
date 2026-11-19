import { stateHashOf } from "@hobo/pricing";
import { describe, expect, it } from "vitest";
import { decideDispatchV2 } from "../src/dispatcher-v2.js";
import { zeroCostCommitmentDispatchScenario } from "./dispatcher-v2-fixtures.js";

describe("dispatcher v2 tie-break (§10.11 / §7.4)", () => {
	it.each([
		["10.1", "10.09"],
		["9007199254741002.02", "9007199254741002.01"],
	])("compares remaining commitments exactly: %s versus %s", (higher, lower) => {
		function scenario(providerId: string, remaining: string) {
			const value = zeroCostCommitmentDispatchScenario(
				providerId,
				"2026-01-31T23:59:59Z",
			);
			const state = value.state;
			const commitment = state?.commitments[0];
			const available = commitment?.remaining?.value;
			const amount = commitment?.commitment?.amount?.value;
			const used = commitment?.used?.value;
			if (
				!state ||
				available?.case !== "money" ||
				amount?.case !== "money" ||
				used?.case !== "money"
			) {
				throw new Error("missing money commitment fixture");
			}
			available.value.decimal = remaining;
			amount.value.decimal = remaining;
			used.value.decimal = "0";
			state.stateHash = stateHashOf(state);
			return value;
		}
		const decision = decideDispatchV2({
			dispatchId: "dispatch-waste",
			category: "runner",
			candidates: [
				{ providerId: "a-higher", scenario: scenario("a-higher", higher) },
				{ providerId: "b-lower", scenario: scenario("b-lower", lower) },
			],
		});
		expect(decision.ok).toBe(true);
		if (!decision.ok) throw new Error(decision.reason);
		expect(decision.selectedProvider).toBe("b-lower");
	});

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
