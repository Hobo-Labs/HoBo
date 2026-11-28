import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { CommitmentAmountSchema } from "../src/_generated/pricing_pb.js";
import { quoteScenario } from "../src/quote.js";
import {
	commitmentState,
	makeScenario,
	perUnitCharge,
	rehashScenario,
	usage,
	workload,
} from "./fixtures.js";

function scenarioWithCommitment() {
	return makeScenario({
		charges: [perUnitCharge("runtime", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		commitments: [commitmentState()],
	});
}

describe("spend commitment currency", () => {
	it.each([
		"amount",
		"remaining",
		"used",
	] as const)("rejects a different currency in %s even when not selected", (field) => {
		const scenario = scenarioWithCommitment();
		const commitment = scenario.state?.commitments[0];
		if (!commitment?.commitment?.scope)
			throw new Error("missing commitment fixture");
		commitment.commitment.scope.dimensions = ["other"];
		const value =
			field === "amount"
				? commitment.commitment.amount?.value
				: field === "remaining"
					? commitment.remaining?.value
					: commitment.used?.value;
		if (value?.case !== "money") throw new Error("missing money fixture");
		value.value.currency = "EUR";
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({ code: "CROSS_CURRENCY" });
	});

	it.each([
		"amount",
		"used",
	] as const)("rejects a quantity in the spend commitment %s", (field) => {
		const scenario = scenarioWithCommitment();
		const commitment = scenario.state?.commitments[0];
		if (!commitment?.commitment) throw new Error("missing commitment fixture");
		const quantity = create(CommitmentAmountSchema, {
			value: { case: "quantity", value: { decimal: "1", unit: "minute" } },
		});
		if (field === "amount") commitment.commitment.amount = quantity;
		else commitment.used = quantity;
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});

	it("rates a consistently denominated spend commitment", () => {
		expect(quoteScenario(scenarioWithCommitment())).toMatchObject({
			consumption: [
				{ kind: "commitment", quantity: { decimal: "4", unit: "USD" } },
			],
		});
	});

	it.each([
		"usage",
		"unknown",
	])("rejects commitment kind %s with a money amount when not selected", (kind) => {
		const scenario = scenarioWithCommitment();
		const commitment = scenario.state?.commitments[0]?.commitment;
		if (!commitment?.scope) throw new Error("missing commitment fixture");
		commitment.scope.dimensions = ["other"];
		commitment.kind = kind;
		rehashScenario(scenario);
		expect(quoteScenario(scenario)).toMatchObject({
			code: "INVALID_PRICING_INPUT",
		});
	});
});
