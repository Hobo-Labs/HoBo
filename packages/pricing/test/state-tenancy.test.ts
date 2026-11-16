import { expect, it } from "vitest";
import { quoteScenario } from "../src/quote.js";
import {
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
