import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	ConfigurationStateSchema,
	ConnectionSchema,
	LeaseSchema,
	OfferSchema,
	route,
	SandboxPricingSchema,
} from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import {
	createSandboxComposition,
	type SandboxCompositionStore,
} from "../src/sandbox-composition.js";

/** A store that answers only what a test sets; anything else is a failure. */
function stubStore(
	overrides: Partial<SandboxCompositionStore> = {},
): SandboxCompositionStore {
	const unreachable = async () => {
		throw new Error("unexpected store operation");
	};
	return {
		configuration: unreachable,
		policySnapshot: unreachable,
		all: unreachable,
		activeLeases: unreachable,
		accountLeases: unreachable,
		pendingJobs: unreachable,
		observe: unreachable,
		queue: unreachable,
		reserve: unreachable,
		cancelAndRequeue: unreachable,
		settleObserved: unreachable,
		get: unreachable,
		transition: unreachable,
		configureSandboxProxy: unreachable,
		configureSandboxEgress: unreachable,
		settleSandboxObserved: unreachable,
		sandboxProxyUsage: unreachable,
		...overrides,
	};
}

describe("Sandbox billing team binding", () => {
	it.each([
		{ offerTeam: "team_other", accepted: false },
		{ offerTeam: "team_real", accepted: true },
	])("checks the offer's billing team before creating a VM: $offerTeam", async ({
		offerTeam,
		accepted,
	}) => {
		const now = Date.now();
		const pricing = create(SandboxPricingSchema, {
			vcpus: 1,
			memoryMb: 2048,
			cpuMicrosPerVcpuHour: 128000,
			memoryMicrosPerGbHour: 21200,
			creationMicros: 1,
			egressMicrosPerGb: 150000,
			maxEgressBytes: 1000000,
			proxyMicrosPerGb: 150000,
			proxyFixedMicros: 1,
			bootstrapFixedMicros: 1,
			networkHeadroomBytes: 1000,
			proxyVmRequired: true,
			proxyVmVcpus: 1,
			proxyVmMemoryMb: 2048,
			proxyVmExtraMs: 120000,
			proxyVmNetworkBytes: 10000000,
			proxyVmNetworkHeadroomBytes: 1000,
			proxyControlMaxCalls: 100,
			proxyControlCallMicros: 1,
			region: "iad1",
			plan: "hobby",
		});
		const offer = create(OfferSchema, {
			id: "vercel",
			provider: "vercel",
			backend: "sandbox",
			providerAccountId: offerTeam,
			enabled: true,
			runsOn: "sandbox",
			bridgeAcknowledged: true,
			budgetMicros: 1000000,
			concurrency: 1,
			sandboxPricing: pricing,
			observedAt: new Date(now - 60_000).toISOString(),
			validUntil: new Date(now + 24 * 60 * 60_000).toISOString(),
		});
		const account = create(AccountSchema, {
			id: "account",
			budgetMicros: 1000000,
			maxRuntimeMinutes: 5,
			startupMinutes: 1,
			offers: [offer],
		});
		const quote = route(account, [], new Date(now).toISOString());
		if (!quote) throw new Error("fixture quote unavailable");
		const connection = create(ConnectionSchema, {
			accountId: "account",
			repository: "owner/repo",
			repositoryId: 1,
			installationId: 2,
			runnerGroupId: 1,
			isolatedOnly: true,
			trustedRepositoryAcknowledged: true,
			publicRepositoryAcknowledged: true,
			acceptAllMatchingRepositoryJobs: true,
		});
		const lease = create(LeaseSchema, {
			id: "c0e6cf50-30ef-4b9b-8e03-6411aaf578cf",
			state: "reserved",
			accountId: "account",
			offerId: "vercel",
			provider: "vercel",
			repository: "owner/repo",
			repositoryId: 1,
			installationId: 2,
			jobId: 3,
			originalRunId: 4,
			runAttempt: 1,
			sandboxPricing: pricing,
			reservedMinutes: quote.minutes,
			reservedPaidMicros: quote.paidMicros,
			sandboxReservedAllowance: quote.sandboxReservedAllowance,
		});
		const transition = vi.fn(async () => undefined);
		const cancelAndRequeue = vi.fn(async () => undefined);
		const store = stubStore({
			get: async () => lease,
			policySnapshot: async () => ({
				state: create(ConfigurationStateSchema, {
					revision: 1,
					configuration: create(ConfigurationSchema, {
						accounts: [account],
						connections: [connection],
					}),
				}),
				policies: [],
			}),
			accountLeases: async () => [],
			transition,
			cancelAndRequeue,
		});
		const composition = createSandboxComposition({
			env: {
				HOBO_CI_SANDBOX_ENABLED: "1",
				HOBO_CI_SANDBOX_TEAM_ID: "team_real",
				HOBO_CI_SANDBOX_PROJECT_ID: "prj_real",
				HOBO_CI_SANDBOX_ISSUER: "https://oidc.vercel.com/team",
				HOBO_CI_SANDBOX_DOMAINS_JSON: '["github.com"]',
			},
			publicOrigin: "https://ci.example.com",
			store,
			github: {
				request: async () => {
					throw new Error("unexpected GitHub call");
				},
			},
		});
		if (!composition) throw new Error("sandbox composition unavailable");
		expect(composition.allowedDomains()).toEqual(["github.com"]);
		composition.allowedDomains().push("example.com");
		expect(composition.allowedDomains()).toEqual(["github.com"]);
		await composition.host.launch(lease.id);
		expect(transition).toHaveBeenCalledTimes(accepted ? 1 : 0);
		expect(cancelAndRequeue).toHaveBeenCalledTimes(accepted ? 0 : 1);
	});
	it.each([
		{ domains: ["https://secret.example/token"] },
		{ domains: [] },
		{ domains: ["github.com", "github.com"] },
		{ domains: Array.from({ length: 101 }, (_, i) => `host${i}.example.com`) },
	])("never reports invalid Sandbox domains %#", async ({ domains }) => {
		const sandbox = createSandboxComposition({
			env: {
				HOBO_CI_SANDBOX_ENABLED: "1",
				HOBO_CI_SANDBOX_TEAM_ID: "team_real",
				HOBO_CI_SANDBOX_PROJECT_ID: "prj_real",
				HOBO_CI_SANDBOX_ISSUER: "https://oidc.vercel.com/team",
				HOBO_CI_SANDBOX_DOMAINS_JSON: JSON.stringify(domains),
			},
			publicOrigin: "https://ci.example.com",
			store: stubStore(),
			github: {
				request: async () => {
					throw new Error("unexpected call");
				},
			},
		});
		expect(() => sandbox?.allowedDomains()).toThrow();
	});
});
