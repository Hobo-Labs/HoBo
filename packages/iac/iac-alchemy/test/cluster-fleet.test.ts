import * as AlchemySecrets from "alchemy/Secrets";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	createHoboClusterProviders,
	describeFleetClusterTopology,
	resolveClusterDatabaseBinding,
} from "../src/cluster/index.js";
import { createOwnerStoreSecretProvider } from "../src/environments/index.js";
import { createAlchemyTestHarness } from "../src/test-harness/index.js";

describe("@hobo/iac-alchemy/cluster (@alchemy.run/effect-cluster)", () => {
	it("provisions Cluster.Database.fromUrl via OwnerStore redacted secret provider and Test harness", async () => {
		const ownerSecrets = createOwnerStoreSecretProvider({
			keys: {
				CLUSTER_DATABASE_URL: "owner://CLUSTER_DATABASE_URL",
			},
			resolveCredential: async (locator) => {
				if (locator === "owner://CLUSTER_DATABASE_URL") {
					return "postgres://cluster:redacted@db.internal:5432/hobo_cluster";
				}
				throw new Error(`unknown locator ${locator}`);
			},
		});

		const harness = createAlchemyTestHarness({
			providers: createHoboClusterProviders(),
			stage: "staging",
			secrets: [AlchemySecrets.ProcessEnv({ disabled: true }), ownerSecrets],
		});

		await harness.withProviderSession(async (session) => {
			const deployed = await session.deploy(
				"hobo-ci-fleet-cluster",
				Effect.gen(function* () {
					return yield* resolveClusterDatabaseBinding("CLUSTER_DATABASE_URL");
				}),
			);
			expect(deployed.outputs.hasUrl).toBe(true);
			expect(deployed.outputs.hasShardGroups).toBe(true);
			await deployed.destroy();
		});
	});

	it("validates swappable cluster topology specs across cloud pool backends", () => {
		const topology = describeFleetClusterTopology({
			stage: "prod",
			target: "cloudflare-durable-object",
			shardGroup: "ci-fleet",
			replicas: 4,
		});
		expect(topology.entities).toEqual(["StationFleetCoordinator"]);
		expect(topology.singletons).toEqual(["hobo-ci-fleet-lease-reaper"]);
		expect(topology.crons).toEqual(["hobo-ci-fleet-health-sweep"]);
		expect(() =>
			describeFleetClusterTopology({
				stage: "prod",
				target: "docker",
				replicas: 0,
			}),
		).toThrow();
	});
});
