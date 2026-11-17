import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BrokerRequestSchema } from "../src/_generated/broker_pb.js";
import type { JsonValue } from "../src/json.js";
import { parseBrokerRequest } from "../src/policies.js";

const request = {
	schemaVersion: "hobo.broker/v1",
	requestId: "request",
	scope: { bindleId: "app" },
	requirements: [{ resourceId: "api", port: "hobo:http-service" }],
};

describe("broker estimate presence", () => {
	it("requires an explicit estimate while preserving an explicit free estimate", () => {
		expect(() => parseBrokerRequest(request)).toThrow(/spendEstimateUsd/u);
		expect(() =>
			parseBrokerRequest({ ...request, spendEstimateUsd: null }),
		).toThrow();
		expect(
			parseBrokerRequest({ ...request, spendEstimateUsd: 0 }).spendEstimateUsd,
		).toBe(0);
		expect(
			parseBrokerRequest({ ...request, spend_estimate_usd: 0 })
				.spendEstimateUsd,
		).toBe(0);
	});

	it("rejects conflicting spellings instead of silently choosing one", () => {
		expect(() =>
			parseBrokerRequest({
				...request,
				spendEstimateUsd: 0,
				spend_estimate_usd: 10,
			}),
		).toThrow();
		expect(
			parseBrokerRequest({
				...request,
				spendEstimateUsd: 10,
				spend_estimate_usd: 10,
			}).spendEstimateUsd,
		).toBe(10);
	});

	it("preserves absent and explicit-zero estimates through protobuf wire and JSON", () => {
		const absent = fromBinary(
			BrokerRequestSchema,
			toBinary(BrokerRequestSchema, create(BrokerRequestSchema, request)),
		);
		const zero = fromBinary(
			BrokerRequestSchema,
			toBinary(
				BrokerRequestSchema,
				create(BrokerRequestSchema, { ...request, spendEstimateUsd: 0 }),
			),
		);
		expect(absent.spendEstimateUsd).toBeUndefined();
		expect(zero.spendEstimateUsd).toBe(0);
		expect(toJson(BrokerRequestSchema, absent)).not.toHaveProperty(
			"spendEstimateUsd",
		);
		expect(toJson(BrokerRequestSchema, zero)).toHaveProperty(
			"spendEstimateUsd",
			0,
		);
		// SAFETY: Both values come from protobuf's JSON encoder and parser.
		const absentDocument = JSON.parse(
			JSON.stringify(toJson(BrokerRequestSchema, absent)),
		) as JsonValue;
		// SAFETY: Both values come from protobuf's JSON encoder and parser.
		const zeroDocument = JSON.parse(
			JSON.stringify(toJson(BrokerRequestSchema, zero)),
		) as JsonValue;
		expect(() => parseBrokerRequest(absentDocument)).toThrow(
			/spendEstimateUsd/u,
		);
		expect(parseBrokerRequest(zeroDocument).spendEstimateUsd).toBe(0);
	});

	it("preserves every generated explicit nonnegative cent amount in either spelling", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 1_000_000 }), (cents) => {
				const amount = cents / 100;
				expect(
					parseBrokerRequest({ ...request, spendEstimateUsd: amount })
						.spendEstimateUsd,
				).toBe(amount);
				expect(
					parseBrokerRequest({ ...request, spend_estimate_usd: amount })
						.spendEstimateUsd,
				).toBe(amount);
			}),
			{ seed: 614503, numRuns: 500 },
		);
	});

	it("rejects generated conflicting aliases", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000_000 }),
				fc.integer({ min: 1, max: 10_000 }),
				(cents, delta) => {
					expect(() =>
						parseBrokerRequest({
							...request,
							spendEstimateUsd: cents / 100,
							spend_estimate_usd: (cents + delta) / 100,
						}),
					).toThrow();
				},
			),
			{ seed: 614504, numRuns: 500 },
		);
	});
});
