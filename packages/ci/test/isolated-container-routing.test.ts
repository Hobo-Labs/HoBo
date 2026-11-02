import { create, toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ConfigurationSchema,
	OfferSchema,
	SandboxPricingSchema,
} from "../src/_generated/ci_pb.js";
import { parseConfiguration } from "../src/config.js";
import { route } from "../src/routing.js";

const now = "2026-11-02T12:00:00Z";
const sandboxPricing = () =>
	create(SandboxPricingSchema, {
		vcpus: 2,
		memoryMb: 4096,
		cpuMicrosPerVcpuHour: 1_000_000,
		memoryMicrosPerGbHour: 1_000_000,
		creationMicros: 610_000,
		egressMicrosPerGb: 1_000_000,
		maxEgressBytes: 1_000_000_000,
		proxyMicrosPerGb: 2_000_000,
		proxyFixedMicros: 50,
		networkHeadroomBytes: 100,
		bootstrapFixedMicros: 20,
		proxyVmRequired: true,
		proxyVmVcpus: 1,
		proxyVmMemoryMb: 2048,
		proxyVmExtraMs: 60_000,
		proxyVmNetworkBytes: 2_000_000_000,
		proxyVmNetworkHeadroomBytes: 100,
		region: "iad1",
		proxyControlMaxCalls: 100,
		proxyControlCallMicros: 1,
		plan: "hobby",
	});

describe("isolated-container budget fallback", () => {
	it("selects zero-price kubernetes worker when vercel sandbox budget is exhausted", () => {
		const config = create(ConfigurationSchema, {
			accounts: [
				{
					id: "hobo-labs",
					budgetMicros: 10_000_000,
					spentMicros: 0,
					maxRuntimeMinutes: 60,
					startupMinutes: 5,
					offers: [
						create(OfferSchema, {
							id: "vercel-sandbox",
							provider: "vercel",
							providerAccountId: "team_abc",
							enabled: true,
							runsOn: "sandbox",
							backend: "sandbox",
							freeMinutes: 0,
							priceMicrosPerMinute: 0,
							budgetMicros: 166_000,
							spentMicros: 0,
							concurrency: 2,
							observedAt: now,
							validUntil: "2026-11-03T12:00:00Z",
							sourceUrl: "https://example.test/evidence",
							bridgeAcknowledged: true,
							sandboxPricing: sandboxPricing(),
						}),
						create(OfferSchema, {
							id: "free-worker",
							provider: "kubernetes",
							providerAccountId: "oracle-free-vm",
							enabled: true,
							runsOn: "hobo-isolated-worker",
							backend: "isolated-container",
							freeMinutes: 0,
							priceMicrosPerMinute: 0,
							budgetMicros: 0,
							spentMicros: 0,
							concurrency: 1,
							observedAt: now,
							validUntil: "2026-11-03T12:00:00Z",
							sourceUrl: "https://example.test/worker",
							bridgeAcknowledged: true,
						}),
					],
				},
			],
		});
		parseConfiguration(toJsonString(ConfigurationSchema, config));
		const account = config.accounts[0];
		if (!account) throw new Error("missing account");
		const isolatedOffers = account.offers.filter(
			(offer) =>
				(offer.provider === "vercel" && offer.backend === "sandbox") ||
				(offer.provider === "kubernetes" &&
					offer.backend === "isolated-container"),
		);
		const choice = route({ ...account, offers: isolatedOffers }, [], now);
		expect(choice?.offer.id).toBe("free-worker");
		expect(choice?.paidMicros).toBe(0);
	});
});
