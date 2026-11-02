import { defineCiPolicy, DesiredCiPolicySchema } from "@hobo/ci";
import { toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { defineCiProjectConfig } from "../src/project-config.js";
import {
	collectAllowedRelayOrigins,
	resolveEngineRelayOrigin,
	resolveEnvironmentEngines,
} from "../src/engine-relay-routing.js";
import {
	inventoryCiEnginesFromRepository,
	normalizeCiEngineSelection,
} from "../src/ci-engine-inventory.js";
import {
	parseCiProjectSelection,
	relayWebhookPath,
	resolveCiRelayRoute,
	type CiWebhookRoutingContext,
} from "../src/relay-routing.js";
import { fileURLToPath } from "node:url";

const basePolicy = () =>
	JSON.parse(
		toJsonString(
			DesiredCiPolicySchema,
			defineCiPolicy({
				accountId: "ci",
				tenantId: "ci",
				pool: { label: "hobo", os: "linux", architecture: "x64" },
				providers: [
					{
						id: "gh",
						kind: "github",
						connectionRef: "gh",
						runsOn: "ubuntu-24.04",
					},
				],
				budget: {
					scope: "ci-account",
					currency: "USD",
					period: "manual",
					timeZone: "UTC",
					limitMicros: 1_000_000,
				},
				routing: {
					strategy: "lowest-total-incremental-cost",
					noEligibleProvider: "queue",
					unknownAllocation: "zero",
				},
				thresholds: [],
			}),
		),
	);

describe("engine-aware CI routing", () => {
	it("routes webhooks under /engines/<engine>/github/webhooks", () => {
		expect(relayWebhookPath("gh-actions")).toBe(
			"/engines/gh-actions/github/webhooks",
		);
	});

	it("resolves per-engine relay overrides", () => {
		const config = defineCiProjectConfig({
			defaultEnvironment: "dev",
			environments: {
				dev: {
					relayOrigin: "https://relay.example.com",
					engineRelays: {
						vercel: { relayOrigin: "https://vercel-relay.example.com" },
					},
					policy: basePolicy(),
				},
			},
		});
		const env = config.environments.dev!;
		expect(resolveEngineRelayOrigin(env, "gh-actions")).toBe(
			"https://relay.example.com",
		);
		expect(resolveEngineRelayOrigin(env, "vercel")).toBe(
			"https://vercel-relay.example.com",
		);
		expect([...collectAllowedRelayOrigins(env)].sort()).toEqual(
			[
				"https://relay.example.com",
				"https://vercel-relay.example.com",
			].sort(),
		);
	});

	it("filters served engines with --engine selection", () => {
		const inventory = ["gh-actions", "vercel", "dagger"] as const;
		expect(
			normalizeCiEngineSelection({
				inventory,
				cli: ["gh-actions"],
			}),
		).toEqual(["gh-actions"]);
		expect(() =>
			normalizeCiEngineSelection({
				inventory,
				cli: ["cf"],
			}),
		).toThrow(/unavailable CI engine/);
	});

	it("includes repo ci-* packages in inventory", async () => {
		const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
		const engines = await inventoryCiEnginesFromRepository(repoRoot);
		expect(engines).toContain("gh-actions");
		expect(engines.length).toBeGreaterThan(1);
	});

	it("resolveCiRelayRoute carries engine id and override origin", () => {
		const config = defineCiProjectConfig({
			defaultEnvironment: "dev",
			environments: {
				dev: {
					relayOrigin: "https://relay.example.com",
					engineRelays: {
						"gh-actions": { relayOrigin: "http://127.0.0.1:8787" },
					},
					allowInsecureLoopback: true,
					policy: basePolicy(),
				},
			},
		});
		const context: CiWebhookRoutingContext = {
			repositoryFullName: "org/repo",
			repositoryId: 1,
			installationId: 1,
			workflowRunId: 1,
			eventName: "push",
			headBranch: "main",
			headRef: "refs/heads/main",
			isForkPullRequest: false,
			configRef: "a".repeat(40),
		};
		const route = resolveCiRelayRoute({
			config,
			selection: parseCiProjectSelection({}),
			context,
			engine: "gh-actions",
		});
		expect(route.engine).toBe("gh-actions");
		expect(route.relayOrigin).toBe("http://127.0.0.1:8787");
	});

	it("resolveEnvironmentEngines prefers CLI over profile list", () => {
		const config = defineCiProjectConfig({
			defaultEnvironment: "dev",
			environments: {
				dev: {
					relayOrigin: "https://relay.example.com",
					engines: ["gh-actions", "vercel"],
					policy: basePolicy(),
				},
			},
		});
		expect(
			resolveEnvironmentEngines({
				environment: config.environments.dev!,
				inventory: ["gh-actions", "vercel", "dagger"],
				cliEngines: ["gh-actions"],
			}),
		).toEqual(["gh-actions"]);
	});
});
