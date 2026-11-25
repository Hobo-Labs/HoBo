import * as AlchemySecrets from "alchemy/Secrets";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { createOwnerStoreSecretProvider } from "../src/environments/index.js";
import { createAlchemyTestHarness } from "../src/test-harness/index.js";
import {
	DualCloudBudgetRouterError,
	declareVercelServiceStack,
	DualCloudBudgetRouterError,
	selectDualCloudBudgetTarget,
	type VercelCloudApiClient,
	VercelCloudProviders,
} from "../src/vercel/index.js";

describe("@hobo/iac-alchemy/vercel custom cloud provider & Cloudflare budget routing", () => {
	it("deploys an intentionally unlinked-Git Vercel service stack via Alchemy Test harness and cleans up on destroy", async () => {
		const events: string[] = [];
		const client: VercelCloudApiClient = {
			upsertProject: async (input) => {
				expect(input.gitLink).toBe("disabled");
				expect(input.authorizationHeader).toBe("Bearer vercel-synthetic-key");
				events.push(`project:upsert:${input.name}`);
				return { projectId: `prj_${input.name}` };
			},
			deleteProject: async (input) => {
				events.push(`project:delete:${input.projectId}`);
			},
			deployService: async (input) => {
				events.push(`deploy:${input.serviceName}:${input.artifactDigest}`);
				return {
					deploymentId: `dpl_${input.serviceName}_1`,
					url: `https://${input.serviceName}.vercel.example.test`,
					state: "READY" as const,
				};
			},
			deleteDeployment: async (input) => {
				events.push(`deploy:delete:${input.deploymentId}`);
			},
			assignAlias: async (input) => {
				events.push(`alias:assign:${input.domain}`);
				return {
					aliasId: `als_${input.domain}`,
					url: `https://${input.domain}`,
				};
			},
			removeAlias: async (input) => {
				events.push(`alias:remove:${input.aliasId}`);
			},
		};

		const ownerSecrets = createOwnerStoreSecretProvider({
			keys: {
				VERCEL_DEPLOY_KEY: "owner://VERCEL_DEPLOY_KEY",
			},
			resolveCredential: async (locator) => {
				if (locator === "owner://VERCEL_DEPLOY_KEY") {
					return "vercel-synthetic-key";
				}
				throw new Error(`unknown locator ${locator}`);
			},
		});

		const harness = createAlchemyTestHarness({
			providers: VercelCloudProviders({ client }),
			stage: "prod",
			secrets: [AlchemySecrets.ProcessEnv({ disabled: true }), ownerSecrets],
		});

		await harness.withProviderSession(async (session) => {
			const deployed = await session.deploy(
				"hobo-ci-relay-vercel",
				Effect.gen(function* () {
					return yield* declareVercelServiceStack({
						projectId: "HoboRelay",
						projectName: "hobo-ci-relay",
						serviceName: "ci-relay",
						artifactDigest: "sha256:abc123",
						domain: "relay.hobo.example.test",
						credentialConfigKey: "VERCEL_DEPLOY_KEY",
					});
				}),
			);
			expect(deployed.outputs.provider).toBe("vercel");
			expect(deployed.outputs.gitLink).toBe("disabled");
			expect(deployed.outputs.url).toBe("https://relay.hobo.example.test");
			await deployed.destroy();
		});

		expect(events).toEqual([
			"project:upsert:hobo-ci-relay",
			"deploy:ci-relay:sha256:abc123",
			"alias:assign:relay.hobo.example.test",
			"alias:remove:als_relay.hobo.example.test",
			"deploy:delete:dpl_ci-relay_1",
			"project:delete:prj_hobo-ci-relay",
		]);
	});

	it("routes and migrates between Vercel and Cloudflare using budget, credits, and switching hysteresis", () => {
		const initialVercel = selectDualCloudBudgetTarget({
			budgetCeilingMicros: 50_000_000,
			offers: [
				{
					provider: "vercel",
					backendId: "vercel-iad1",
					endpointUrl: "https://relay.vercel.example.test",
					remainingCreditsMicros: 40_000_000,
					estimatedMonthlyCostMicros: 35_000_000,
					healthy: true,
				},
				{
					provider: "cloudflare",
					backendId: "cf-workers-global",
					endpointUrl: "https://relay.workers.example.test",
					remainingCreditsMicros: 0,
					estimatedMonthlyCostMicros: 12_000_000,
					healthy: true,
				},
			],
		});
		expect(initialVercel.selectedProvider).toBe("vercel");
		expect(initialVercel.fallbackProvider).toBe("cloudflare");
		expect(initialVercel.reason).toBe("credits-preferred");

		const afterVercelCreditsBurned = selectDualCloudBudgetTarget({
			budgetCeilingMicros: 50_000_000,
			incumbentProvider: "vercel",
			minSavingsToSwitchMicros: 5_000_000,
			offers: [
				{
					provider: "vercel",
					backendId: "vercel-iad1",
					endpointUrl: "https://relay.vercel.example.test",
					remainingCreditsMicros: 0,
					estimatedMonthlyCostMicros: 35_000_000,
					healthy: true,
				},
				{
					provider: "cloudflare",
					backendId: "cf-workers-global",
					endpointUrl: "https://relay.workers.example.test",
					remainingCreditsMicros: 0,
					estimatedMonthlyCostMicros: 12_000_000,
					healthy: true,
				},
			],
		});
		expect(afterVercelCreditsBurned.selectedProvider).toBe("cloudflare");
		expect(afterVercelCreditsBurned.netCostMicros).toBe(12_000_000);
		expect(afterVercelCreditsBurned.reason).toBe("lowest-cost-within-budget");

		const heldByHysteresis = selectDualCloudBudgetTarget({
			budgetCeilingMicros: 50_000_000,
			incumbentProvider: "cloudflare",
			minSavingsToSwitchMicros: 5_000_000,
			offers: [
				{
					provider: "vercel",
					backendId: "vercel-iad1",
					endpointUrl: "https://relay.vercel.example.test",
					remainingCreditsMicros: 0,
					estimatedMonthlyCostMicros: 10_000_000,
					healthy: true,
				},
				{
					provider: "cloudflare",
					backendId: "cf-workers-global",
					endpointUrl: "https://relay.workers.example.test",
					remainingCreditsMicros: 0,
					estimatedMonthlyCostMicros: 12_000_000,
					healthy: true,
				},
			],
		});
		expect(heldByHysteresis.selectedProvider).toBe("cloudflare");
		expect(heldByHysteresis.reason).toBe("incumbent-held-hysteresis");

		expect(() =>
			selectDualCloudBudgetTarget({
				budgetCeilingMicros: 1_000_000,
				offers: [
					{
						provider: "vercel",
						backendId: "vercel-iad1",
						endpointUrl: "https://relay.vercel.example.test",
						remainingCreditsMicros: 0,
						estimatedMonthlyCostMicros: 35_000_000,
						healthy: true,
					},
				],
			}),
		).toThrow(DualCloudBudgetRouterError);

		expect(() =>
			selectDualCloudBudgetTarget({
				budgetCeilingMicros: 50_000_000,
				offers: [
					{
						provider: "vercel",
						backendId: "vercel-iad1",
						endpointUrl: "https://relay.vercel.example.test",
						remainingCreditsMicros: 0,
						estimatedMonthlyCostMicros: 10_000_000,
						healthy: false,
					},
				],
			}),
		).toThrow(DualCloudBudgetRouterError);
	});
});
