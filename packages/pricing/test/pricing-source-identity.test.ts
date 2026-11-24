import { clone } from "@bufbuild/protobuf";
import fc from "fast-check";
import { expect, it } from "vitest";
import {
	ProviderAgreementSchema,
	type QuoteScenario,
} from "../src/_generated/pricing_pb.js";
import { quoteScenario } from "../src/quote.js";
import { isQuoteVector } from "../src/types.js";
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

type Kind = "allowance" | "credit" | "commitment";
function sourceScenario(kind: Kind, count: number): QuoteScenario {
	const source =
		kind === "allowance"
			? allowanceState("source", "10", "0")
			: kind === "credit"
				? creditState("source", "zero", 0)
				: commitmentState();
	const entries = Array.from({ length: count }, () => source);
	return makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "20", "minute")])],
		allowances: kind === "allowance" ? entries : [],
		credits: kind === "credit" ? entries : [],
		commitments: kind === "commitment" ? entries : [],
	});
}
function sources(scenario: QuoteScenario, kind: Kind) {
	if (!scenario.state) throw new Error("missing state");
	const entries =
		kind === "allowance"
			? scenario.state.allowances.map((item) => item.grant)
			: kind === "credit"
				? scenario.state.credits.map((item) => item.grant)
				: scenario.state.commitments.map((item) => item.commitment);
	return entries.map((entry) => {
		if (!entry) throw new Error("missing source");
		return entry;
	});
}
function expectRejected(scenario: QuoteScenario) {
	const result = quoteScenario(rehashScenario(scenario));
	expect(isQuoteVector(result)).toBe(false);
	if (isQuoteVector(result)) throw new Error("unsafe quote accepted");
	expect(result.code).toBe("INVALID_PRICING_INPUT");
}

it("rejects duplicated credit rather than spending the same $10 twice", () => {
	const scenario = sourceScenario("credit", 2);
	expectRejected(scenario);
	const prior = quoteScenario(scenario, {
		ratingAlgorithmVersion: "pricing-rating/v3",
	});
	if (!isQuoteVector(prior)) throw new Error("legacy quote rejected");
	expect(prior.incremental?.billed?.decimal).toBe("0");
	expect(prior.consumption.map((item) => item.sourceId)).toEqual([
		"source",
		"source",
	]);
});

it("rejects duplicate or foreign sources for every financial source kind", () => {
	const name = fc
		.array(fc.constantFrom("a", "b", "z", "0", "9"), {
			minLength: 1,
			maxLength: 8,
		})
		.map((parts) => parts.join(""));
	fc.assert(
		fc.property(
			fc.constantFrom<Kind>("allowance", "credit", "commitment"),
			name,
			fc.boolean(),
			(kind, id, duplicate) => {
				const scenario = sourceScenario(kind, duplicate ? 2 : 1);
				for (const entry of sources(scenario, kind)) {
					entry.id = id;
					entry.tenantId = duplicate ? "tenant-a" : "foreign-tenant";
				}
				expectRejected(scenario);
				const prior = quoteScenario(scenario, {
					ratingAlgorithmVersion: "pricing-rating/v3",
				});
				expect(isQuoteVector(prior)).toBe(true);
			},
		),
		{ seed: 614485, numRuns: 300 },
	);
});

it.each([
	"allowance",
	"credit",
	"commitment",
] as const)("rejects a missing %s source ID", (kind) => {
	const scenario = sourceScenario(kind, 1);
	const source = sources(scenario, kind)[0];
	if (!source) throw new Error("missing source");
	source.id = "";
	expectRejected(scenario);
});

it("allows a shared ID across different source kinds for the same tenant", () => {
	const scenario = makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
		candidate: [workload("agreement-a", [usage("minute", "20", "minute")])],
		allowances: [allowanceState("shared", "10", "0")],
		credits: [creditState("shared", "zero", 0)],
		commitments: [commitmentState()],
	});
	const commitment = sources(scenario, "commitment")[0];
	if (!commitment) throw new Error("missing commitment");
	commitment.id = "shared";
	expect(isQuoteVector(quoteScenario(rehashScenario(scenario)))).toBe(true);
});

it("rejects a financial state without a tenant", () => {
	const scenario = makeScenario({
		charges: [perUnitCharge("usage", "minute", "1")],
	});
	if (!scenario.state) throw new Error("missing state");
	scenario.state.tenantId = "";
	for (const agreement of scenario.state.agreements) agreement.tenantId = "";
	expectRejected(scenario);
});

function addAccount(scenario: QuoteScenario, account: string) {
	const state = scenario.state;
	if (!state?.agreements[0]) throw new Error("missing agreement");
	const agreement = clone(ProviderAgreementSchema, state.agreements[0]);
	agreement.id = "agreement-b";
	agreement.providerAccountRef = account;
	state.agreements.push(agreement);
}

it.each([
	"allowance",
	"credit",
	"commitment",
] as const)("rejects an unscoped %s in a multi-account state", (kind) => {
	const scenario = sourceScenario(kind, 1);
	addAccount(scenario, "account-b");
	expectRejected(scenario);
	const prior = quoteScenario(scenario, {
		ratingAlgorithmVersion: "pricing-rating/v3",
	});
	expect(isQuoteVector(prior)).toBe(true);
});

it("allows multiple accounts when no financial source is present", () => {
	const scenario = sourceScenario("credit", 0);
	addAccount(scenario, "account-b");
	expect(isQuoteVector(quoteScenario(rehashScenario(scenario)))).toBe(true);
});

it("allows multiple agreements for the same account with a financial source", () => {
	const scenario = sourceScenario("credit", 1);
	addAccount(scenario, "account-a");
	expect(isQuoteVector(quoteScenario(rehashScenario(scenario)))).toBe(true);
});

it("rejects an agreement with a missing provider account", () => {
	const scenario = sourceScenario("credit", 0);
	const agreement = scenario.state?.agreements[0];
	if (!agreement) throw new Error("missing agreement");
	agreement.providerAccountRef = "";
	expectRejected(scenario);
});
