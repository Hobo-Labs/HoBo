import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AccountSchema, OfferSchema } from "../src/_generated/ci_pb.js";
import { providerFreeRunnerMinutes } from "../src/provider-allocation.js";
import { route } from "../src/routing.js";

describe("provider allocation conversion", () => {
	it("converts shared base-vCPU minutes into usable minutes for each supported SKU", () => {
		expect(
			providerFreeRunnerMinutes({
				provider: "blacksmith",
				runsOn: "blacksmith-4vcpu-ubuntu-2404",
				remainingBaseMinutes: 20,
			}),
		).toBe(10);
		expect(
			providerFreeRunnerMinutes({
				provider: "depot",
				runsOn: "depot-ubuntu-24.04-8",
				remainingBaseMinutes: 20,
			}),
		).toBe(5);
		expect(
			providerFreeRunnerMinutes({
				provider: "depot",
				runsOn: "depot-ubuntu-24.04",
				remainingBaseMinutes: 20,
			}),
		).toBe(20);
	});
	it("does not round a fractional conversion up past the actual allocation", () => {
		const available = 1.0000000000000004;
		const result = providerFreeRunnerMinutes({
			provider: "blacksmith",
			runsOn: "blacksmith-32vcpu-ubuntu-2404",
			remainingBaseMinutes: available,
		});
		expect(result).toBeLessThan(available / 16);
	});
	it("uses the converted balance in the actual provider comparison", () => {
		const common = {
			enabled: true,
			bridgeAcknowledged: true,
			budgetMicros: 100000,
			concurrency: 1,
			observedAt: "2026-10-26T00:00:00Z",
			validUntil: "2026-10-27T00:00:00Z",
		};
		const blacksmith = create(OfferSchema, {
			...common,
			id: "blacksmith",
			provider: "blacksmith",
			runsOn: "blacksmith-8vcpu-ubuntu-2404",
			freeMinutes: providerFreeRunnerMinutes({
				provider: "blacksmith",
				runsOn: "blacksmith-8vcpu-ubuntu-2404",
				remainingBaseMinutes: 8,
			}),
			priceMicrosPerMinute: 1000,
		});
		const depot = create(OfferSchema, {
			...common,
			id: "depot",
			provider: "depot",
			freeMinutes: 0,
			priceMicrosPerMinute: 500,
		});
		const account = create(AccountSchema, {
			id: "example",
			routingStrategy: "maximize-credits",
			budgetMicros: 100000,
			maxRuntimeMinutes: 9,
			startupMinutes: 1,
			offers: [blacksmith, depot],
		});
		// Eight base minutes cover two minutes on the 8-vCPU host. Consume
		// those minutes first, even though Depot's paid reservation is cheaper.
		const choice = route(account, [], "2026-10-26T12:00:00Z");
		expect(choice?.offer.id).toBe("blacksmith");
		expect(choice?.freeMinutes).toBe(2);
		expect(choice?.paidMicros).toBe(8000);
	});
	it("does not guess conversion for unsupported SKUs or invalid balances", () => {
		for (const runsOn of [
			"blacksmith-8vcpu-ubuntu-2404-arm",
			"blacksmith-8vcpu-windows-2025",
			"blacksmith-6vcpu-ubuntu-2404",
			"hobo",
		])
			expect(() =>
				providerFreeRunnerMinutes({
					provider: "blacksmith",
					runsOn,
					remainingBaseMinutes: 10,
				}),
			).toThrow();
		for (const remainingBaseMinutes of [
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		])
			expect(() =>
				providerFreeRunnerMinutes({
					provider: "depot",
					runsOn: "depot-ubuntu-24.04",
					remainingBaseMinutes,
				}),
			).toThrow();
	});
});
