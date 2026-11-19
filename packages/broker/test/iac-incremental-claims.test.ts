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
			{ bucketId: "allowance-a", unit: "minute", units: 2, kind: "allowance" },
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
			{
				bucketId: "allowance-a",
				unit: "minute",
				units: 100_000,
				kind: "allowance",
			},
			{
				bucketId: "credit-a",
				unit: "USD.micros",
				units: 1_500_000,
				kind: "credit",
			},
		]);
	});

	it("fails closed on unsupported consumption kinds in full", () => {
		for (const kind of ["grant", "", "ALLOWANCE"]) {
			const unsupported = create(ConsumptionSchema, {
				kind,
				sourceId: "mystery-a",
				quantity: { decimal: "1", unit: "minute" },
			});
			expect(
				incrementalEntitlementClaims([unsupported], [], "USD"),
			).toBeUndefined();
			expect(
				incrementalEntitlementClaims(
					[row("allowance", "allowance-a", "1", "minute"), unsupported],
					[],
					"USD",
				),
			).toBeUndefined();
		}
	});

	it("fails closed on unsupported consumption kinds in base", () => {
		const unsupported = create(ConsumptionSchema, {
			kind: "waiver",
			sourceId: "mystery-a",
			quantity: { decimal: "1", unit: "minute" },
		});
		expect(
			incrementalEntitlementClaims(
				[row("allowance", "allowance-a", "2", "minute")],
				[unsupported],
				"USD",
			),
		).toBeUndefined();
	});

	it("keeps credit and commitment rows with the same source id separate", () => {
		const full = [
			row("credit", "wallet-a", "1", "USD"),
			row("commitment", "wallet-a", "2", "USD"),
		];
		const claims = incrementalEntitlementClaims(full, [], "USD");
		expect(claims).toEqual([
			{
				bucketId: "wallet-a",
				unit: "USD.micros",
				units: 2_000_000,
				kind: "commitment",
			},
			{
				bucketId: "wallet-a",
				unit: "USD.micros",
				units: 1_000_000,
				kind: "credit",
			},
		]);
		expect(
			incrementalEntitlementClaims([...full].reverse(), [], "USD"),
		).toEqual(claims);
	});
});
