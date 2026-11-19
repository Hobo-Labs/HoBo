import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ConsumptionSchema } from "../../pricing/src/_generated/pricing_pb.js";
import { incrementalEntitlementClaims } from "../src/iac-incremental-claims.js";

const row = (
	kind: "allowance" | "credit" | "commitment",
	sourceId: string,
	decimal: string,
	unit: string,
) =>
	create(ConsumptionSchema, {
		kind,
		sourceId,
		quantity: { decimal, unit },
	});

describe("incrementalEntitlementClaims", () => {
	it("rejects commitment consumption not denominated in the billing currency", () => {
		expect(
			incrementalEntitlementClaims(
				[row("commitment", "commitment-a", "1", "EUR")],
				[],
				"USD",
			),
		).toBeUndefined();
	});

	it("reserves whole native allowance units for fractional consumption", () => {
		const claims = incrementalEntitlementClaims(
			[row("allowance", "allowance-a", "1.5", "minute")],
			[],
			"USD",
		);
		expect(claims).toEqual([
			{ bucketId: "allowance-a", unit: "minute", units: 2 },
		]);
	});

	it("keeps allowance and money claims in separate buckets and scales", () => {
		const full = [
			row("allowance", "allowance-a", "500000", "minute"),
			row("credit", "credit-a", "1.5", "USD"),
		];
		const base = [row("allowance", "allowance-a", "400000", "minute")];
		const claims = incrementalEntitlementClaims(full, base, "USD");
		expect(claims).toEqual([
			{ bucketId: "allowance-a", unit: "minute", units: 100_000 },
			{ bucketId: "credit-a", unit: "USD.micros", units: 1_500_000 },
		]);
	});
});
