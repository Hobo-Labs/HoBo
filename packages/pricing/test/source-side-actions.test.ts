import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { MoneySchema } from "../src/_generated/pricing_pb.js";
import { quoteScenario } from "../src/quote.js";
import {
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

describe("source-side pricing actions", () => {
	it.each([
		"place",
		"dispatch",
	] as const)("refuses a %s candidate that removes an existing workload", (action) => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			baseline: [workload("agreement-a", [usage("minute", "4", "minute")])],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		scenario.action = action;
		const candidate = scenario.candidate[0];
		if (!candidate) throw new Error("missing workload fixture");
		candidate.direction = "remove";
		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it.each([
		"place",
		"dispatch",
	] as const)("refuses a %s scenario with source agreement references", (action) => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		scenario.action = action;
		scenario.sourceProviderAgreementIds = ["agreement-a"];
		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("refuses rebalancing even when the supplied candidate only adds usage", () => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		scenario.action = "rebalance";
		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("rates explicit non-canceling destroy costs", () => {
		const scenario = Object.assign(
			makeScenario({
				charges: [perUnitCharge("teardown", "minute", "0.25")],
				candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
			}),
			{ action: "destroy", destroyCancelsAgreement: false },
		);
		expect(quoteScenario(scenario)).toMatchObject({
			ratingAlgorithmVersion: "pricing-rating/v1",
			incremental: { billed: { decimal: "1", currency: "USD" } },
		});
	});

	it("accepts a declared zero destroy charge without treating absence as zero", () => {
		const scenario = Object.assign(
			makeScenario({
				charges: [perUnitCharge("teardown", "minute", "0")],
				candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
			}),
			{ action: "destroy", destroyCancelsAgreement: false },
		);
		expect(quoteScenario(scenario)).toMatchObject({
			incremental: { billed: { decimal: "0", currency: "USD" } },
		});
	});

	it.each([
		["absent cancellation declaration", undefined, false],
		["an agreement cancellation", true, false],
		["a removed workload", false, true],
	] as const)("refuses destroy with %s", (_label, cancellation, remove) => {
		const scenario = Object.assign(
			makeScenario({
				charges: [perUnitCharge("teardown", "minute", "0.25")],
				candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
			}),
			{ action: "destroy" },
		);
		if (cancellation !== undefined)
			Object.assign(scenario, { destroyCancelsAgreement: cancellation });
		if (remove) {
			const candidate = scenario.candidate[0];
			if (!candidate) throw new Error("missing workload fixture");
			candidate.direction = "remove";
		}
		expect(quoteScenario(scenario)).toMatchObject({
			code:
				cancellation === undefined
					? "INCOMPLETE_FINANCIAL_STATE"
					: "PRICING_MODEL_UNSUPPORTED",
		});
	});

	it("refuses destroy source agreements and misplaced destroy declarations", () => {
		const scenario = Object.assign(
			makeScenario({
				charges: [perUnitCharge("teardown", "minute", "0.25")],
				candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
			}),
			{ action: "destroy", destroyCancelsAgreement: false },
		);
		scenario.sourceProviderAgreementIds = ["agreement-a"];
		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
		scenario.sourceProviderAgreementIds = [];
		scenario.action = "place";
		expect(quoteScenario(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});

	it.each([
		"migrate",
		"cancel",
	] as const)("refuses %s until cancellation and source-side costs can be rated completely", (action) => {
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "1")],
			baseline: [workload("agreement-a", [usage("minute", "4", "minute")])],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		const removed = scenario.candidate[0];
		if (!removed) throw new Error("missing workload fixture");
		removed.direction = "remove";
		scenario.action = action;
		scenario.sourceProviderAgreementIds = ["agreement-a"];
		if (!scenario.options) throw new Error("missing options fixture");
		scenario.options.allowCancellation = true;
		const policy = scenario.state?.agreements[0]?.cancellation;
		if (!policy) throw new Error("missing cancellation fixture");
		policy.allowed = true;
		policy.fee = create(MoneySchema, { decimal: "5", currency: "USD" });
		rehashScenario(scenario);

		expect(quoteScenario(scenario)).toMatchObject({
			code: "PRICING_MODEL_UNSUPPORTED",
		});
	});
});
