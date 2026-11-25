import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Domain from "@alchemy.run/domain";
import type { PoolHost } from "@alchemy.run/rivet/Host";
import { NodeHttpServer } from "@effect/platform-node";
import { createNodeSqliteDriver } from "@hobo/storage-sqlite";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import { setupTest } from "rivetkit/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EpochMs,
	GhAccountId,
	GhActorId,
	GhAdvertKeyId,
	GhLintSandbox,
	GhMachineId,
	GhRelayApi,
	GhRelayJobId,
	GhRelayNodeId,
	GhRepoSlug,
	GhRunnerLabel,
	GhRunnerProtocol,
	NonEmptyReason,
	NonNegativeCount,
	PositiveRunId,
	PositiveSlots,
} from "../src/domain/index.js";
import {
	createGhPickRunnerRegistry,
	createGhRelayInMemoryLayer,
	createGhRelayRivetLayer,
	createGhRelaySqliteLayer,
	type GhPickRunnerEvent,
} from "../src/host/index.js";
import { startLocalRivetTestEngine } from "./support/rivet-test-engine.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const RunnerProtocolStub = GhRunnerProtocol.toLayer(
	Effect.succeed({
		answerJob: () => Effect.succeed({ accepted: true }),
		rerunFailedJobs: () => Effect.succeed({ triggered: true }),
	}),
);

const LintSandboxStub = GhLintSandbox.toLayer(
	Effect.succeed({
		runTool: () =>
			Effect.succeed({
				passed: true,
				summary: NonEmptyReason.make("passed"),
				findingCount: NonNegativeCount.make(0),
			}),
	}),
);

const EXTERNALS = {
	runnerProtocol: RunnerProtocolStub,
	lintSandbox: LintSandboxStub,
};

const ACCOUNT = GhAccountId.make("acct-host-1");
const REPO = GhRepoSlug.make("octo/app");
const ACTOR = GhActorId.make("42");
const T0 = EpochMs.make(1_763_400_000_000);

describe("@hobo/ci-gh-actions/host portable hosting (InMemory, HTTP, SQLite, Rivet)", () => {
	it("serves GhRelayApi in-process and over real HTTP transport via NodeHttpServer.layerTest + Domain.protocolHttp", async () => {
		const jobId = GhRelayJobId.make("job-http-1");

		const InMemoryWorld = createGhRelayInMemoryLayer(EXTERNALS);
		const inProcessStatus = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* GhRelayApi.clientInProcess;
				const receipt = yield* client.ConnectGhMachine(ACCOUNT, {
					machineId: GhMachineId.make("m-http-1"),
					name: "http-box",
					runsOnLabel: GhRunnerLabel.make("hobo-machine-m-http-1"),
					labels: [GhRunnerLabel.make("self-hosted")],
					slots: PositiveSlots.make(2),
					sharing: "only_me",
					ownerId: ACTOR,
					advertKeyId: GhAdvertKeyId.make("key-http-1"),
					isolatedContainer: false,
					adopted: false,
					nowMs: T0,
				});
				return yield* client.GhAccountStatusView.get(ACCOUNT, {
					atLeast: receipt,
				});
			}).pipe(Effect.scoped, Effect.provide(InMemoryWorld)),
		);
		expect(inProcessStatus?.machines).toHaveLength(1);
		expect(inProcessStatus?.routedCount).toBe(0);

		const ApiServer = Layer.unwrap(
			Effect.gen(function* () {
				const api = yield* GhRelayApi;
				return HttpServer.serve()(api.fetch);
			}),
		).pipe(
			Layer.provide(createGhRelayInMemoryLayer(EXTERNALS)),
			Layer.provideMerge(NodeHttpServer.layerTest),
		);

		const HttpWorld = Layer.provideMerge(Domain.protocolHttp(""), ApiServer);

		const httpActivity = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* GhRelayApi.client;
				yield* client.ConfigureGhRunnerOrder(ACCOUNT, {
					repository: REPO,
					order: {
						steps: [
							{
								key: "depot",
								minutesLimitPercent: null,
								spendLimitCents: null,
							},
							{
								key: "github",
								minutesLimitPercent: null,
								spendLimitCents: null,
							},
						],
						skipUnhealthy: true,
						autoSizeVcpus: 4,
						retry: null,
					},
				});
				yield* client.QueueGhRelayJob(jobId, {
					context: {
						accountId: ACCOUNT,
						repository: REPO,
						runId: PositiveRunId.make(55),
						runAttempt: PositiveRunId.make(1),
						jobName: "test",
						matrixLeg: null,
						isPrivate: true,
						isFork: false,
						actorId: ACTOR,
						runsOn: [GhRunnerLabel.make("hobo/depot=auto/github=ubuntu-24.04")],
						candidates: [],
						first: null,
						size: 8,
						checkSteps: [],
						hasNonCheckSteps: false,
						pullRequestTitle: null,
						nowMs: T0,
						claimNodeId: GhRelayNodeId.make("hobo-relay-node"),
					},
				});

				for (let attempt = 0; attempt < 30; attempt += 1) {
					const activity = yield* client.GhRelayActivityView.get(jobId);
					if (activity?._tag === "Routed") return activity;
					yield* Effect.sleep("20 millis");
				}
				return yield* client.GhRelayActivityView.get(jobId);
			}).pipe(Effect.scoped, Effect.provide(HttpWorld)),
		);

		expect(httpActivity?._tag).toBe("Routed");
		if (httpActivity?._tag === "Routed") {
			expect(httpActivity.step).toBe("depot");
			expect(httpActivity.runnerLabel).toBe("depot-ubuntu-24.04-8");
		}
	});

	it("persists GhRelay state and materialized views across SQLite host restarts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-gh-relay-sqlite-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "gh-relay.sqlite");
		const jobId = GhRelayJobId.make("job-sqlite-1");

		const firstDriver = createNodeSqliteDriver({ path: dbPath });
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* GhRelayApi.clientInProcess;
					yield* client.QueueGhRelayJob(jobId, {
						context: {
							accountId: ACCOUNT,
							repository: REPO,
							runId: PositiveRunId.make(99),
							runAttempt: PositiveRunId.make(1),
							jobName: "pr-check",
							matrixLeg: null,
							isPrivate: true,
							isFork: false,
							actorId: ACTOR,
							runsOn: [GhRunnerLabel.make("hobo-relay")],
							candidates: [],
							first: null,
							size: null,
							checkSteps: [
								{
									check: "pr-title",
									types: ["feat", "fix"],
									tools: [],
									paths: [],
								},
							],
							hasNonCheckSteps: false,
							pullRequestTitle: "feat: durable check",
							nowMs: T0,
							claimNodeId: GhRelayNodeId.make("hobo-relay-node"),
						},
					});
					for (let attempt = 0; attempt < 30; attempt += 1) {
						const view = yield* client.GhRelayActivityView.get(jobId);
						if (view?._tag === "CheckPassed") break;
						yield* Effect.sleep("20 millis");
					}
				}).pipe(
					Effect.scoped,
					Effect.provide(createGhRelaySqliteLayer(firstDriver, EXTERNALS)),
				),
			);
		} finally {
			firstDriver.close();
		}

		const restartedDriver = createNodeSqliteDriver({ path: dbPath });
		try {
			const restored = await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* GhRelayApi.clientInProcess;
					return yield* client.GhRelayActivityView.get(jobId);
				}).pipe(
					Effect.scoped,
					Effect.provide(createGhRelaySqliteLayer(restartedDriver, EXTERNALS)),
				),
			);
			expect(restored?._tag).toBe("CheckPassed");
		} finally {
			restartedDriver.close();
		}
	});

	it("composes GhRelay onto Rivet Durable Objects via createGhRelayRivetLayer", () => {
		const buildLayer = (pool: Layer.Layer<PoolHost>) =>
			createGhRelayRivetLayer({
				main: "./dist/host/rivet.js",
				pool,
				...EXTERNALS,
			});
		expect(buildLayer).toBeTypeOf("function");
	});

	it("persists pick-runner jobs in RivetKit SQLite, broadcasts relayUpdated events, and rescues stale queued jobs via setupTest", async (testCtx) => {
		const engine = await startLocalRivetTestEngine();
		try {
			const registry = createGhPickRunnerRegistry({
				endpoint: engine.endpoint,
				token: engine.token,
				httpHost: engine.httpHost,
				httpPort: engine.httpPort,
				startEngine: false,
				noWelcome: true,
				shutdown: {
					gracePeriodMs: 2_000,
					disableSignalHandlers: true,
				},
			});

			const { client } = await setupTest(testCtx, registry);
			const handle = client.ghPickRunner.getOrCreate(["acct-rivet-1"]);
			const conn = handle.connect();
			const events: GhPickRunnerEvent[] = [];
			conn.on("relayUpdated", (event: GhPickRunnerEvent) => {
				events.push(event);
			});

			const queued = await conn.enqueueJob({
				jobId: GhRelayJobId.make("gh-job-1"),
				repository: REPO,
				runsOn: GhRunnerLabel.make("hobo/depot=auto/github=ubuntu-24.04"),
				rescueAfterMs: 60_000,
			});
			expect(queued.status).toBe("queued");

			const claimed = await conn.claimJob({
				jobId: GhRelayJobId.make("gh-job-1"),
				nodeId: "relay-node-a",
			});
			expect(claimed?.status).toBe("claimed");
			expect(claimed?.nodeId).toBe("relay-node-a");

			const raced = await conn.claimJob({
				jobId: GhRelayJobId.make("gh-job-1"),
				nodeId: "relay-node-b",
			});
			expect(raced?.status).toBe("claimed");
			expect(raced?.nodeId).toBe("relay-node-a");

			const wrongNodeAnswer = await conn.answerJob({
				jobId: GhRelayJobId.make("gh-job-1"),
				nodeId: "relay-node-b",
				chosenRunner: GhRunnerLabel.make("depot-ubuntu-24.04"),
			});
			expect(wrongNodeAnswer).toBeNull();

			const answered = await conn.answerJob({
				jobId: GhRelayJobId.make("gh-job-1"),
				nodeId: "relay-node-a",
				chosenRunner: GhRunnerLabel.make("depot-ubuntu-24.04"),
			});
			expect(answered?.status).toBe("answered");
			expect(answered?.chosenRunner).toBe("depot-ubuntu-24.04");

			await conn.enqueueJob({
				jobId: GhRelayJobId.make("gh-job-stale"),
				repository: REPO,
				runsOn: GhRunnerLabel.make("hobo-relay"),
				rescueAfterMs: 80,
			});

			await expect
				.poll(
					async () => {
						const jobs = await conn.listJobs();
						return jobs.find((item) => item.jobId === "gh-job-stale")?.status;
					},
					{ timeout: 5_000, interval: 40 },
				)
				.toBe("rescued");

			await vi.waitFor(() => {
				expect(events.map((event) => event.action)).toEqual(
					expect.arrayContaining(["queued", "claimed", "answered", "rescued"]),
				);
			});

			await conn.dispose();
		} finally {
			await engine.stop();
		}
	}, 25_000);
});
