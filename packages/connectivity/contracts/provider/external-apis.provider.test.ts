/**
 * Provider verification for external HTTP boundaries.
 *
 * Live Cloudflare / Route53 / Tailscale / Netbird / Stripe / OPA endpoints
 * require credentials and are not exercised in CI. Offline verification:
 *   1. each pact loads with PascalCase provider identity
 *   2. createMockProviderFromPact self-satisfies verifyPact (contract integrity)
 *   3. inventory drift gate covers every pact file
 *
 * Consumer tests drive the real clients through createPactFetch against these
 * same documents — that is the integration-boundary enforcement path.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPactInventory,
	createMockProviderFromPact,
	loadPactDirectory,
	verifyPact,
} from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import { requirePact } from "../helpers/pact-fetch.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

const EXTERNAL_PROVIDERS = [
	{ provider: "CloudflareDnsApi", consumer: "HoboConnectivity" },
	{
		provider: "CloudflareLoadBalancingApi",
		consumer: "HoboConnectivity",
	},
	{
		provider: "VercelTrafficRoutingApi",
		consumer: "HoboConnectivity",
	},
	{ provider: "Route53DnsApi", consumer: "HoboConnectivity" },
	{ provider: "TailscaleControlApi", consumer: "HoboConnectivity" },
	{ provider: "NetbirdManagementApi", consumer: "HoboConnectivity" },
	{ provider: "StripeBillingApi", consumer: "HoboConnectivity" },
	{ provider: "OpaPolicyApi", consumer: "HoboConnectivity" },
] as const;

describe("external API provider contracts (offline)", () => {
	it("inventory and every external pact are consistent", async () => {
		const inventory = await checkPactInventory(contractsDir);
		expect(inventory.ok, inventory.problems.join("; ")).toBe(true);

		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		for (const { provider, consumer } of EXTERNAL_PROVIDERS) {
			const pact = requirePact(pacts, provider);
			if (!pact) throw new Error(`missing pact for ${provider}`);
			expect(pact.consumer.name).toBe(consumer);
			expect(pact.provider.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
			expect(pact.interactions.length).toBeGreaterThan(0);

			const mock = createMockProviderFromPact(pact);
			expect(mock.name).toBe(provider);
			const report = await verifyPact(pact, mock);
			expect(report.ok, `${provider}: ${JSON.stringify(report.failures)}`).toBe(
				true,
			);
		}
	});

	it("no external pact uses live network in provider suite", async () => {
		// Guard: this suite must never call real endpoints — only pact mocks.
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		for (const { provider } of EXTERNAL_PROVIDERS) {
			const pact = requirePact(pacts, provider);
			if (!pact) throw new Error(`missing pact for ${provider}`);
			const mock = createMockProviderFromPact(pact);
			for (const interaction of pact.interactions) {
				const actual = await mock.handle(interaction.request);
				expect(actual.status, interaction.description).toBe(
					interaction.response.status,
				);
			}
		}
	});
});
