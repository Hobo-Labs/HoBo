import { inMemoryState, Stack } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createOwnerStoreSecretProvider,
	createSecretlessStackSecrets,
} from "../src/environments/index.js";
import {
	Agent37Sandbox,
	Agent37SandboxProvider,
	Agent37Snapshot,
	Agent37SnapshotProvider,
	Boat,
	declareAgent37CiCdSnapshotAndSandbox,
	declareBoatCiCdSnapshotAndSandbox,
} from "../src/sandbox/index.js";
import { createAlchemyTestHarness } from "../src/test-harness/index.js";

describe("Boat and Boat-shaped Agent37 CI/CD snapshot/fork sandboxes", () => {
	const createdSnapshots: string[] = [];
	const deletedSnapshots: string[] = [];
	const createdSandboxes: Array<{
		readonly id: string;
		readonly provider: "boat" | "agent37";
		readonly snapshotName: string | undefined;
		readonly forkedFrom: string | undefined;
	}> = [];
	const deletedSandboxes: string[] = [];
	const agent37Secret = "ephemeral-agent37-sandbox-key-7788";
	const stateRecords: NonNullable<Parameters<typeof inMemoryState>[0]> = {};

	const agent37Client = {
		async buildSnapshot(input: {
			readonly name: string;
			readonly setupHash: string;
		}) {
			const snapshotId = `a37-snap-${input.name}-${input.setupHash.slice(0, 8)}`;
			createdSnapshots.push(snapshotId);
			return { snapshotId };
		},
		async deleteSnapshot(input: { readonly snapshotId: string }) {
			deletedSnapshots.push(input.snapshotId);
		},
		async createSandbox(input: {
			readonly name: string;
			readonly snapshotName: string | undefined;
			readonly forkFromSandboxId: string | undefined;
		}) {
			const sandboxId = `a37-sbx-${input.name}`;
			createdSandboxes.push({
				id: sandboxId,
				provider: "agent37",
				snapshotName: input.snapshotName,
				forkedFrom: input.forkFromSandboxId,
			});
			return {
				sandboxId,
				endpointUrl: `https://${sandboxId}.agent37.invalid`,
				state: "ready" as const,
			};
		},
		async execSandbox() {
			return { exitCode: 0, stdout: "ok" };
		},
		async deleteSandbox(input: { readonly sandboxId: string }) {
			deletedSandboxes.push(input.sandboxId);
		},
	};

	const boatSnapshotProvider = Provider.succeed(Boat.Snapshot, {
		reconcile: ({ news }) =>
			Effect.sync(() => {
				const name = news.name ?? "boat-golden";
				const snapshotId = `boat-snap-${name}`;
				createdSnapshots.push(snapshotId);
				return {
					name,
					snapshotId,
					type: news.type ?? "default",
					sizeBytes: 1024,
					setupHash: news.run.join("|"),
				};
			}),
		delete: ({ output }) =>
			Effect.sync(() => {
				if (output?.snapshotId !== undefined) {
					deletedSnapshots.push(output.snapshotId);
				}
			}),
	});

	const boatSandboxProvider = Provider.succeed(Boat.Sandbox, {
		reconcile: ({ news }) =>
			Effect.sync(() => {
				const sandboxId = `boat-sbx-${news.name ?? "ci"}`;
				createdSandboxes.push({
					id: sandboxId,
					provider: "boat",
					snapshotName: news.snapshot?.name,
					forkedFrom: undefined,
				});
				return {
					sandboxId,
					name: news.name ?? "ci",
					type: news.type ?? "default",
					state: "ready" as const,
					setupStatus: "done" as const,
					autoStopSeconds: 300,
					snapshots: news.snapshots ?? true,
					noEnv: news.noEnv ?? true,
					monitoring: news.monitoring ?? true,
					environment: "base",
					snapshot: news.snapshot?.name,
					snapshotSetupHash: news.snapshot?.setupHash,
					subdomain: undefined,
					urls: {},
					labels: {},
				};
			}),
		delete: ({ output }) =>
			Effect.sync(() => {
				if (output !== undefined) deletedSandboxes.push(output.sandboxId);
			}),
	});

	const providers = Layer.mergeAll(
		boatSnapshotProvider,
		boatSandboxProvider,
		Agent37SnapshotProvider({ client: agent37Client }),
		Agent37SandboxProvider({ client: agent37Client }),
	);

	const secrets = createSecretlessStackSecrets([
		createOwnerStoreSecretProvider({
			keys: { AGENT37_API_KEY: "owner://AGENT37_FLEET" },
			resolveCredential: () => agent37Secret,
		}),
	]);

	const harness = createAlchemyTestHarness({
		providers,
		state: inMemoryState(stateRecords),
		stage: "test-cicd-sandboxes",
		secrets,
	});

	const stack = Stack(
		"cicd-dual-sandboxes",
		{
			providers,
			state: harness.state,
			secrets: [...secrets],
		},
		Effect.gen(function* () {
			const boatRun = yield* declareBoatCiCdSnapshotAndSandbox({
				snapshot: {
					id: "BoatGolden",
					name: "hobo-ci-golden",
					setupCommands: ["git clone repo ~/repo", "pnpm install"],
				},
				sandbox: {
					id: "BoatPrSandbox",
					name: "pr-42-boat",
					noEnv: true,
				},
			});
			const agent37Run = yield* declareAgent37CiCdSnapshotAndSandbox({
				snapshot: {
					id: "Agent37Golden",
					name: "hobo-ci-golden",
					setupCommands: ["git clone repo ~/repo", "pnpm install"],
					region: "us",
				},
				sandbox: {
					id: "Agent37PrSandbox",
					name: "pr-42-agent37",
					noEnv: true,
					labels: ["hobo-fleet", "agent37", "ci-fork"],
				},
			});
			return {
				boatSnapshot: boatRun.snapshotName,
				boatSandboxId: boatRun.sandboxId,
				agent37Snapshot: agent37Run.snapshotName,
				agent37SandboxId: agent37Run.sandboxId,
			};
		}),
	);

	let outputs: {
		readonly boatSnapshot: string;
		readonly boatSandboxId: string;
		readonly agent37Snapshot: string;
		readonly agent37SandboxId: string;
	};

	beforeAll(async () => {
		outputs = await harness.deploy(stack);
	});

	afterAll(async () => {
		await harness.destroy(stack);
	});

	it("builds golden snapshots and forks isolated CI/CD sandboxes on both Boat and Agent37 without persisting secrets", () => {
		expect(outputs).toEqual({
			boatSnapshot: "hobo-ci-golden",
			boatSandboxId: "boat-sbx-pr-42-boat",
			agent37Snapshot: "hobo-ci-golden",
			agent37SandboxId: "a37-sbx-pr-42-agent37",
		});
		expect(
			createdSandboxes.map((entry) => ({
				provider: entry.provider,
				snapshotName: entry.snapshotName,
			})),
		).toEqual([
			{ provider: "boat", snapshotName: "hobo-ci-golden" },
			{ provider: "agent37", snapshotName: "hobo-ci-golden" },
		]);
		expect(JSON.stringify(stateRecords)).not.toContain(agent37Secret);
	});

	it("supports incremental snapshot caching and live sandbox forks in provider sessions", async () => {
		await harness.withProviderSession(async (session) => {
			const beforeSnapCount = createdSnapshots.length;
			const first = await session.deploy(
				"agent37-fork-session",
				Effect.gen(function* () {
					const snap = yield* Agent37Snapshot("GoldenBase", {
						name: "warm-base",
						run: ["pnpm fetch"],
					});
					const parent = yield* Agent37Sandbox("ParentBox", {
						name: "parent-box",
						snapshot: snap,
					});
					const fork = yield* Agent37Sandbox("ForkBox", {
						name: "fork-box",
						snapshot: snap,
						forkFromSandboxId: "a37-sbx-parent-box",
					});
					return {
						snapHash: snap.setupHash,
						parentId: parent.sandboxId,
						forkId: fork.sandboxId,
						forkedFrom: fork.forkedFrom,
					};
				}),
			);
			expect(first.outputs.forkedFrom).toBe("a37-sbx-parent-box");
			expect(createdSnapshots.length).toBe(beforeSnapCount + 1);
			await first.destroy();
			expect(deletedSandboxes).toContain("a37-sbx-fork-box");
			expect(deletedSandboxes).toContain("a37-sbx-parent-box");
		});
	});
});
