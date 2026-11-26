import { expect, it } from "vitest";
import { quoteScenario } from "../src/quote.js";
import {
	allowanceState,
	commitmentState,
	creditState,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

it("rejects agreements whose tenantId differs from financial state", () => {
	const scenario = makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "1", "minute")])],
	});
	const agreement = scenario.state?.agreements[0];
	if (agreement === undefined) throw new Error("missing agreement fixture");
	agreement.tenantId = "tenant-b";

	expect(quoteScenario(rehashScenario(scenario))).toMatchObject({
		code: "INVALID_PRICING_INPUT",
		message: expect.stringContaining("tenant"),
	});
});

it.each([
	"allowance",
	"credit",
	"commitment",
] as const)("rejects a %s owned by another tenant", (kind) => {
	const scenario = makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "1", "minute")])],
		allowances: kind === "allowance" ? [allowanceState("a", "10", "0")] : [],
		credits: kind === "credit" ? [creditState("c", "zero", 0)] : [],
		commitments: kind === "commitment" ? [commitmentState()] : [],
	});
	const state = scenario.state;
	if (state === undefined) throw new Error("missing state fixture");
	const grant =
		kind === "allowance"
			? state.allowances[0]?.grant
			: kind === "credit"
				? state.credits[0]?.grant
				: state.commitments[0]?.commitment;
	if (grant === undefined) throw new Error("missing grant fixture");
	grant.tenantId = "tenant-b";
	expect(quoteScenario(rehashScenario(scenario))).toMatchObject({
		code: "INVALID_PRICING_INPUT",
		message: expect.stringContaining("tenant"),
	});
});
