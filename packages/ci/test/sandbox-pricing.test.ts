import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	AccountSchema,
	LeaseSchema,
	OfferSchema,
	SandboxAllowanceSchema,
	SandboxPricingSchema,
} from "../src/_generated/ci_pb.js";
import { route } from "../src/routing.js";
import {
	sandboxProxyOnlyUsageQuote,
	sandboxReservationMicros,
	sandboxUsageMicros,
	sandboxUsageQuote,
} from "../src/sandbox-pricing.js";

const pricing = () =>
	create(SandboxPricingSchema, {
		vcpus: 2,
		memoryMb: 4096,
		cpuMicrosPerVcpuHour: 1_000_000,
		memoryMicrosPerGbHour: 1_000_000,
		creationMicros: 100,
		egressMicrosPerGb: 1_000_000,
		maxEgressBytes: 1_000_000_000,
		proxyMicrosPerGb: 2_000_000,
		proxyFixedMicros: 50,
		networkHeadroomBytes: 100,
		bootstrapFixedMicros: 20,
	});
const at = "2026-10-26T12:00:00Z";
function account() {
	return create(AccountSchema, {
		id: "account",
		budgetMicros: 20_000_000,
		maxRuntimeMinutes: 59,
		startupMinutes: 1,
		offers: [
			create(OfferSchema, {
				id: "sandbox",
				provider: "vercel",
				providerAccountId: "vercel",
				backend: "sandbox",
				enabled: true,
				bridgeAcknowledged: true,
				priceMicrosPerMinute: 10,
				budgetMicros: 20_000_000,
				concurrency: 1,
				observedAt: "2026-10-26T11:00:00Z",
				validUntil: "2026-10-26T14:00:00Z",
				sandboxPricing: pricing(),
			}),
		],
	});
}
describe("Sandbox composite costs", () => {
	it("reserves the full CPU, memory, creation, proxy, network and host charges", () => {
		expect(sandboxReservationMicros(pricing(), 60, 10)).toBe(9_096_771);
		const picked = route(account(), [], at);
		expect(picked?.paidMicros).toBe(9_096_771);
		expect(picked?.freeMinutes).toBe(0);
	});
	it("computes actual usage from the frozen rate card and rounds each charge upwards", () => {
		expect(
			sandboxUsageMicros(pricing(), {
				cpuVcpuMs: 3_600_000,
				memoryMb: 4096,
				durationMs: 3_600_000,
				egressBytes: 1_000_000_000,
				proxyBytes: 1_000_000_000,
				hostMicros: 600,
			}),
		).toBe(8_096_770);
		const p = pricing();
		p.cpuMicrosPerVcpuHour = 1;
		p.memoryMicrosPerGbHour = 1;
		p.egressMicrosPerGb = 1;
		p.proxyMicrosPerGb = 1;
		p.creationMicros = 1;
		p.proxyFixedMicros = 1;
		p.bootstrapFixedMicros = 1;
		expect(
			sandboxUsageMicros(p, {
				cpuVcpuMs: 1,
				memoryMb: 1,
				durationMs: 0,
				egressBytes: 1,
				proxyBytes: 1,
				hostMicros: 0,
			}),
		).toBe(7);
	});
	it("fails closed for missing, underprovisioned or stale rate cards and unknown credit accounting", () => {
		const a = account();
		const o = a.offers[0];
		if (!o) throw new Error("missing fixture");
		o.sandboxPricing = undefined;
		expect(route(a, [], at)).toBeUndefined();
		o.sandboxPricing = pricing();
		o.sandboxPricing.memoryMb = 1024;
		expect(route(a, [], at)).toBeUndefined();
		o.sandboxPricing = pricing();
		o.freeMinutes = 60;
		expect(route(a, [], at)).toBeUndefined();
		o.freeMinutes = 0;
		o.validUntil = "2026-10-26T12:30:00Z";
		expect(route(a, [], at)).toBeUndefined();
	});
	it("applies the total composite reservation to the account and provider budgets", () => {
		const a = account();
		a.budgetMicros = 9_096_770;
		expect(route(a, [], at)).toBeUndefined();
		a.budgetMicros = 20_000_000;
		const offer = a.offers[0];
		if (!offer) throw new Error("missing fixture");
		offer.budgetMicros = 9_096_770;
		expect(route(a, [], at)).toBeUndefined();
	});
	it("requires evidence to cover the extra proxy VM duration", () => {
		const a = account();
		const offer = a.offers[0];
		if (!offer?.sandboxPricing) throw new Error("missing fixture");
		Object.assign(offer.sandboxPricing, {
			proxyVmRequired: true,
			proxyVmVcpus: 1,
			proxyVmMemoryMb: 2048,
			proxyVmExtraMs: 60_000,
			proxyVmNetworkBytes: 2_000_000_000,
			proxyVmNetworkHeadroomBytes: 100,
			region: "iad1",
			plan: "pro",
			proxyControlMaxCalls: 100,
			proxyControlCallMicros: 3,
		});
		offer.priceMicrosPerMinute = 0;
		offer.validUntil = "2026-10-26T13:00:59.999Z";
		expect(route(a, [], at)).toBeUndefined();
		offer.validUntil = "2026-10-26T13:01:00Z";
		expect(route(a, [], at)?.offer.id).toBe("sandbox");
	});
	it("rejects values whose total cannot be represented as safe integer micros", () => {
		const p = pricing();
		p.cpuMicrosPerVcpuHour = Number.MAX_SAFE_INTEGER;
		expect(() => sandboxReservationMicros(p, 60, 0)).toThrow(
			"unsafe sandbox quantity or charge",
		);
	});
	it("reserves independent free buckets once across concurrent jobs and settled usage", () => {
		const a = account();
		const offer = a.offers[0];
		if (!offer) throw new Error("missing offer");
		offer.priceMicrosPerMinute = 0;
		offer.concurrency = 2;
		offer.sandboxAllowance = create(SandboxAllowanceSchema, {
			cpuVcpuMs: 7_200_000,
			memoryMbMs: 14_745_600_000,
			egressBytes: 1_000_000_100,
			creations: 1,
			proxyBytes: 1_000_000_000,
			proxySessions: 1,
		});
		const first = route(a, [], at);
		expect(first?.paidMicros).toBe(20);
		expect(first?.sandboxReservedAllowance?.cpuVcpuMs).toBe(7_200_000);
		const active = create(LeaseSchema, {
			id: "one",
			accountId: a.id,
			offerId: offer.id,
			state: "reserved",
			sandboxReservedAllowance: first?.sandboxReservedAllowance,
		});
		const second = route(a, [active], at);
		expect(second?.paidMicros).toBe(9_096_171);
		expect(second?.sandboxReservedAllowance?.cpuVcpuMs).toBe(0);
		const settlement = sandboxUsageQuote(
			pricing(),
			{
				cpuVcpuMs: 3_600_000,
				memoryMb: 4096,
				durationMs: 3_600_000,
				egressBytes: 500_000_000,
				proxyBytes: 500_000_000,
				hostMicros: 0,
			},
			first?.sandboxReservedAllowance,
		);
		expect(settlement.paidMicros).toBe(20);
		expect(settlement.usedAllowance.cpuVcpuMs).toBe(3_600_000);
		const complete = create(LeaseSchema, {
			id: "one",
			accountId: a.id,
			offerId: offer.id,
			state: "completed",
			sandboxUsedAllowance: settlement.usedAllowance,
			usageCompletedAt: "2026-10-26T11:30:00Z",
		});
		const after = route(a, [complete], at);
		expect(after?.sandboxReservedAllowance?.cpuVcpuMs).toBe(3_600_000);
		expect(after?.sandboxReservedAllowance?.creations).toBe(0);
	});
	it("never consumes free units beyond the reservation or an absent snapshot", () => {
		const quote = sandboxUsageQuote(
			pricing(),
			{
				cpuVcpuMs: 3_600_000,
				memoryMb: 4096,
				durationMs: 3_600_000,
				egressBytes: 1_000_000_000,
				proxyBytes: 1_000_000_000,
				hostMicros: 0,
			},
			create(SandboxAllowanceSchema, { cpuVcpuMs: 1, creations: 1 }),
		);
		expect(quote.usedAllowance.cpuVcpuMs).toBe(1);
		expect(quote.usedAllowance.creations).toBe(1);
		expect(quote.usedAllowance.memoryMbMs).toBe(0);
		expect(quote.paidMicros).toBe(8_096_070);
	});
	it("quotes runner and proxy VMs, shared free buckets, and bounded control calls", () => {
		const p = pricing();
		Object.assign(p, {
			proxyVmRequired: true,
			proxyVmVcpus: 1,
			proxyVmMemoryMb: 2048,
			proxyVmExtraMs: 60_000,
			proxyVmNetworkBytes: 2_000_000_000,
			proxyVmNetworkHeadroomBytes: 100,
			region: "iad1",
			plan: "pro",
			proxyControlMaxCalls: 100,
			proxyControlCallMicros: 3,
		});
		expect(sandboxReservationMicros(p, 60, 10)).toBe(14_195_972);
		const a = account();
		const offer = a.offers[0];
		if (!offer) throw new Error("missing offer");
		offer.sandboxPricing = p;
		offer.priceMicrosPerMinute = 0;
		offer.concurrency = 2;
		offer.sandboxAllowance = create(SandboxAllowanceSchema, {
			cpuVcpuMs: 10_860_000,
			memoryMbMs: 22_241_280_000,
			egressBytes: 3_000_000_200,
			creations: 2,
			proxyBytes: 1_000_000_000,
			proxySessions: 1,
			proxyControlCalls: 100,
		});
		const first = route(a, [], at);
		expect(first?.paidMicros).toBe(20);
		expect(first?.sandboxReservedAllowance?.creations).toBe(2);
		expect(first?.sandboxReservedAllowance?.proxyControlCalls).toBe(100);
		const active = create(LeaseSchema, {
			id: "one",
			accountId: a.id,
			offerId: offer.id,
			state: "reserved",
			sandboxReservedAllowance: first?.sandboxReservedAllowance,
			reservedPaidMicros: 20,
		});
		const second = route(a, [active], at);
		expect(second?.paidMicros).toBe(14_195_372);
		expect(second?.sandboxReservedAllowance?.creations).toBe(0);
		expect(second?.sandboxReservedAllowance?.proxyControlCalls).toBe(0);
	});
	it("prioritizes remaining proxy control call allowance and accounts for reservations", () => {
		const a = account();
		const sandbox = a.offers[0];
		if (!sandbox?.sandboxPricing) throw new Error("missing fixture");
		Object.assign(sandbox.sandboxPricing, {
			proxyVmRequired: true,
			proxyVmVcpus: 1,
			proxyVmMemoryMb: 2048,
			proxyVmExtraMs: 60_000,
			proxyVmNetworkBytes: 2_000_000_000,
			proxyVmNetworkHeadroomBytes: 100,
			region: "iad1",
			plan: "pro",
			proxyControlMaxCalls: 100,
			proxyControlCallMicros: 3,
		});
		sandbox.priceMicrosPerMinute = 0;
		a.routingStrategy = "maximize-credits";
		sandbox.concurrency = 2;
		sandbox.sandboxAllowance = create(SandboxAllowanceSchema, {
			proxyControlCalls: 100,
		});
		a.offers.push(
			create(OfferSchema, {
				id: "paid",
				provider: "github",
				providerAccountId: "gh",
				enabled: true,
				bridgeAcknowledged: true,
				priceMicrosPerMinute: 1,
				budgetMicros: 20_000_000,
				concurrency: 2,
				observedAt: "2026-10-26T11:00:00Z",
				validUntil: "2026-10-26T14:00:00Z",
			}),
		);
		const first = route(a, [], at);
		expect(first?.offer.id).toBe("sandbox");
		expect(first?.sandboxReservedAllowance?.proxyControlCalls).toBe(100);
		const held = create(LeaseSchema, {
			accountId: a.id,
			offerId: sandbox.id,
			state: "reserved",
			sandboxReservedAllowance: first?.sandboxReservedAllowance,
			reservedPaidMicros: first?.paidMicros,
		});
		expect(route(a, [held], at)?.offer.id).toBe("paid");
	});
	it("settles both sessions and refuses missing proxy usage", () => {
		const p = pricing();
		Object.assign(p, {
			proxyVmRequired: true,
			proxyVmVcpus: 1,
			proxyVmMemoryMb: 2048,
			proxyVmExtraMs: 60_000,
			proxyVmNetworkBytes: 2_000_000_000,
			proxyVmNetworkHeadroomBytes: 100,
			region: "iad1",
			plan: "pro",
			proxyControlMaxCalls: 100,
			proxyControlCallMicros: 3,
		});
		const usage = {
			cpuVcpuMs: 7_200_000,
			memoryMb: 4096,
			durationMs: 3_600_000,
			egressBytes: 1_000_000_000,
			proxyBytes: 1_000_000_000,
			hostMicros: 600,
			proxyControlCalls: 40,
			proxyVm: {
				cpuVcpuMs: 3_600_000,
				memoryMb: 2048,
				durationMs: 3_600_000,
				ingressBytes: 500_000_000,
				egressBytes: 500_000_000,
			},
		};
		expect(sandboxUsageQuote(p, usage).paidMicros).toBe(13_144_990);
		expect(() =>
			sandboxUsageQuote(p, { ...usage, proxyVm: undefined }),
		).toThrow("verified proxy VM usage");
		expect(() =>
			sandboxUsageQuote(p, { ...usage, proxyControlCalls: undefined }),
		).toThrow("verified proxy VM usage");
	});
	it("charges only the proxy if guest creation provably never started", () => {
		const p = pricing();
		Object.assign(p, {
			proxyVmRequired: true,
			proxyVmVcpus: 1,
			proxyVmMemoryMb: 2048,
			proxyVmExtraMs: 60_000,
			proxyVmNetworkBytes: 2_000_000_000,
			proxyVmNetworkHeadroomBytes: 100,
			region: "iad1",
			plan: "pro",
			proxyControlMaxCalls: 100,
			proxyControlCallMicros: 3,
		});
		const usage = {
			proxyVm: {
				cpuVcpuMs: 1_800_000,
				memoryMb: 2048,
				durationMs: 1_800_000,
				ingressBytes: 1_000_000,
				egressBytes: 2_000_000,
			},
			proxyBytes: 2_000_000,
			proxyControlCalls: 5,
			hostMicros: 0,
		};
		expect(sandboxProxyOnlyUsageQuote(p, usage).paidMicros).toBe(1_531_165);
		const free = create(SandboxAllowanceSchema, { creations: 1 });
		const quoted = sandboxProxyOnlyUsageQuote(p, usage, free);
		expect(quoted.usedAllowance.creations).toBe(1);
		expect(quoted.paidMicros).toBe(1_531_065);
	});
	it("rejects underquoted or unbounded proxy VM configurations", () => {
		for (const patch of [
			{ proxyVmVcpus: 0 },
			{ proxyVmMemoryMb: 1024 },
			{ proxyVmExtraMs: 0 },
			{ proxyVmNetworkBytes: 1_999_999_999 },
			{ proxyVmNetworkHeadroomBytes: 0 },
			{ proxyControlMaxCalls: 0 },
			{ proxyControlCallMicros: 0 },
			{ region: "" },
		]) {
			const p = pricing();
			Object.assign(
				p,
				{
					proxyVmRequired: true,
					proxyVmVcpus: 1,
					proxyVmMemoryMb: 2048,
					proxyVmExtraMs: 60_000,
					proxyVmNetworkBytes: 2_000_000_000,
					proxyVmNetworkHeadroomBytes: 100,
					region: "iad1",
					plan: "pro",
					proxyControlMaxCalls: 100,
					proxyControlCallMicros: 3,
				},
				patch,
			);
			expect(() => sandboxReservationMicros(p, 60, 0)).toThrow();
		}
		const legacy = pricing();
		legacy.proxyVmVcpus = 1;
		expect(() => sandboxReservationMicros(legacy, 60, 0)).toThrow(
			"requires proxy VM",
		);
	});
	it("enforces the plan's proxy lifetime and vCPU limits before reservation", () => {
		const p = pricing();
		Object.assign(p, {
			proxyVmRequired: true,
			proxyVmVcpus: 1,
			proxyVmMemoryMb: 2048,
			proxyVmExtraMs: 60_000,
			proxyVmNetworkBytes: 2_000_000_000,
			proxyVmNetworkHeadroomBytes: 100,
			region: "iad1",
			plan: "hobby",
			proxyControlMaxCalls: 100,
			proxyControlCallMicros: 3,
		});
		expect(() => sandboxReservationMicros(p, 44, 0)).not.toThrow();
		expect(() => sandboxReservationMicros(p, 45, 0)).toThrow(
			"duration exceeds plan limit",
		);
		p.proxyVmVcpus = 8;
		p.proxyVmMemoryMb = 16_384;
		expect(() => sandboxReservationMicros(p, 10, 0)).toThrow(
			"resources exceed plan limits",
		);
		p.plan = "invalid";
		expect(() => sandboxReservationMicros(p, 10, 0)).toThrow(
			"resources exceed plan limits",
		);
	});
});
