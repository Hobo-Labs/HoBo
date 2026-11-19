import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromJson, toJson } from "@bufbuild/protobuf";
import { type MessageDescriptor, Verifier } from "@pact-foundation/pact";
import { expect, it } from "vitest";
import { z } from "zod";
import { PromotionDecisionSchema } from "../src/_generated/promotion_decision_pb.js";
import {
	evaluatePromotionGate,
	parseEvalResult,
	parsePromotionThresholds,
} from "../src/gate.js";

const pactPath = fileURLToPath(
	new URL("../contracts/pacts/promotion_gate.pact.json", import.meta.url),
);
const message = z.object({
	contents: z.object({
		contentType: z.literal("application/json"),
		encoded: z.literal(false),
		content: z.json(),
	}),
});
const pactSchema = z.object({
	interactions: z.array(
		z.object({
			description: z.string(),
			type: z.literal("Synchronous/Messages"),
			request: message,
			response: z.tuple([message]),
		}),
	),
});
const requestSchema = z.object({
	candidateId: z.string(),
	conformance: z.boolean(),
	policy: z.boolean(),
	championId: z.string().optional(),
	evalResult: z.json(),
	thresholds: z.json(),
});

function interactions() {
	return pactSchema.parse(JSON.parse(readFileSync(pactPath, "utf8")))
		.interactions;
}

function decide(value: z.infer<typeof requestSchema>) {
	const input = {
		candidateId: value.candidateId,
		conformance: value.conformance,
		policy: value.policy,
		evalResult: parseEvalResult(value.evalResult),
		thresholds: parsePromotionThresholds(value.thresholds),
	};
	return evaluatePromotionGate(
		value.championId === undefined
			? input
			: { ...input, championId: value.championId },
	);
}

it("reads promotion decisions through the protobuf consumer contract", () => {
	const contracts = interactions();
	expect(contracts).toHaveLength(4);
	for (const contract of contracts) {
		const actual = decide(
			requestSchema.parse(contract.request.contents.content),
		);
		const expected = fromJson(
			PromotionDecisionSchema,
			contract.response[0].contents.content,
		);
		expect(actual.candidateId).toBe(expected.candidateId);
		expect(actual.outcome).toBe(expected.outcome);
		expect(actual.passed).toEqual(expected.passed);
		expect(actual.failures).toEqual(expected.failures);
	}
});

it("verifies every promotion interaction against the gate provider", async () => {
	const contracts = interactions();
	const verified = new Set<string>();
	const invoke = (message: MessageDescriptor) => {
		verified.add(message.description);
		return toJson(
			PromotionDecisionSchema,
			decide(requestSchema.parse(message.content)),
			{
				alwaysEmitImplicit: true,
			},
		);
	};
	await new Verifier({
		provider: "PromotionGateProvider",
		pactUrls: [pactPath],
		messageProviders: Object.fromEntries(
			contracts.map(({ description }) => [description, invoke]),
		),
		logLevel: "error",
		failIfNoPactsFound: true,
	}).verifyProvider();
	expect([...verified].sort()).toEqual(
		contracts.map(({ description }) => description).sort(),
	);
}, 30_000);
