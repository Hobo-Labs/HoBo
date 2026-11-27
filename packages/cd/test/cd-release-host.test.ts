import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Domain from "@alchemy.run/domain";
import type { PoolHost } from "@alchemy.run/rivet/Host";
import { NodeHttpServer } from "@effect/platform-node";
import { createNodeSqliteDriver } from "@hobo/storage-sqlite";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import { setupTest } from "rivetkit/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ApproverId,
	CampTargetId,
	CdCampRealizer,
	CdDeliveryFlow,
	CdFanoutId,
	CdPromotionId,
	CdReleaseApi,
	CdVerificationGate,
	DeliveryFlowTarget,
	DeliveryRunId,
	EpochMs,
	FreightAlias,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	RealizationRef,
	RevisionRef,
	StageId,
	UniqueCampWave,
	UniqueStageList,
	WarehouseId,
} from "../src/domain/index.js";
import {
	type CdPromotionGateEvent,
	type CdPullWatchEvent,
	createCdDeliveryFlowRouterLayer,
	createCdPromotionGateRegistry,
	createCdPullWatchRegistry,
	createCdReleaseInMemoryLayer,
	createCdReleaseRivetLayer,
	createCdReleaseSqliteLayer,
} from "../src/host/index.js";
import { startLocalRivetTestEngine } from "./support/rivet-test-engine.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const RealizerStub = CdCampRealizer.toLayer(
	Effect.succeed({
		realizeCamp: ({ promotionId, campId }) =>
			Effect.succeed({
				realizationRef: RealizationRef.make(`ref:${promotionId}:${campId}`),
			}),
		rollbackCamp: () => Effect.succeed({ rolledBack: true }),
	}),
);

const PassingGateStub = CdVerificationGate.toLayer(
	Effect.succeed({
		evaluate: () =>
			Effect.succeed({
				passed: true,
				summary: NonEmptyReason.make("all slo probes green"),
			}),
	}),
);

describe("@hobo/cd/host portable hosting (InMemory, HTTP, SQLite, Rivet)", () => {
	it("serves CdReleaseApi in-process and over real HTTP transport via NodeHttpServer.layerTest + Domain.protocolHttp", async () => {
		const promoId = CdPromotionId.make("promo-http-1");
		const fanoutId = CdFanoutId.make("fanout-http-1");
		const campId = CampTargetId.make("camp-us-east");
		const digest = FreightDigest.make("sha256:http-v1");

		const InMemoryWorld = createCdReleaseInMemoryLayer(
			RealizerStub,
			PassingGateStub,
		);
		const inProcessView = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* CdReleaseApi.clientInProcess;
				const reqReceipt = yield* client.RequestCdPromotion(promoId, {
					campId,
					freightDigest: digest,
					requiresApproval: true,
				});
				const pending = yield* client.CdPromotionStatusView.get(promoId, {
					atLeast: reqReceipt,
				});
				const fanoutReceipt = yield* client.StartCdFanout(fanoutId, {
					freightDigest: digest,
					campIds: UniqueCampWave.make([campId]),
					maxFailures: NonNegativeCount.make(0),
				});
				const fanout = yield* client.CdFanoutStatusView.get(fanoutId, {
					atLeast: fanoutReceipt,
				});
				return { pending, fanout };
			}).pipe(Effect.scoped, Effect.provide(InMemoryWorld)),
		);
		expect(inProcessView.pending?._tag).toBe("PendingApproval");
		expect(inProcessView.fanout?._tag).toBe("Running");

		const ApiServer = Layer.unwrap(
			Effect.gen(function* () {
				const api = yield* CdReleaseApi;
				return HttpServer.serve()(api.fetch);
			}),
		).pipe(
			Layer.provide(
				createCdReleaseInMemoryLayer(RealizerStub, PassingGateStub),
			),
			Layer.provideMerge(NodeHttpServer.layerTest),
		);

		const HttpWorld = Layer.provideMerge(Domain.protocolHttp(""), ApiServer);

		const httpResult = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* CdReleaseApi.client;
				const reqReceipt = yield* client.RequestCdPromotion(promoId, {
					campId,
					freightDigest: digest,
					requiresApproval: true,
				});
				const pending = yield* client.CdPromotionStatusView.get(promoId, {
					atLeast: reqReceipt,
				});
				const approvedReceipt = yield* client.ApproveCdPromotion(promoId, {
					approver: ApproverId.make("operator-http"),
				});
				const afterApproval = yield* client.CdPromotionStatusView.get(promoId, {
					atLeast: approvedReceipt,
				});
				return { pending, afterApproval };
			}).pipe(Effect.scoped, Effect.provide(HttpWorld)),
		);

		expect(httpResult.pending?._tag).toBe("PendingApproval");
		expect(httpResult.afterApproval?._tag).not.toBe("PendingApproval");
	});

	it("persists CdRelease state and materialized views across SQLite host restarts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-cd-host-sqlite-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "cd-release.sqlite");
		const promoId = CdPromotionId.make("promo-sqlite-1");
		const campId = CampTargetId.make("camp-eu-central");
		const digest = FreightDigest.make("sha256:sqlite-v1");

		const first = createNodeSqliteDriver({ path: dbPath });
		try {
			const FirstWorld = createCdReleaseSqliteLayer(
				first,
				RealizerStub,
				PassingGateStub,
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* CdReleaseApi.clientInProcess;
					const receipt = yield* client.RequestCdPromotion(promoId, {
						campId,
						freightDigest: digest,
						requiresApproval: true,
					});
					yield* client.CdPromotionStatusView.get(promoId, {
						atLeast: receipt,
					});
				}).pipe(Effect.scoped, Effect.provide(FirstWorld)),
			);
		} finally {
			first.close();
		}

		const reopened = createNodeSqliteDriver({ path: dbPath });
		try {
			const ReopenedWorld = createCdReleaseSqliteLayer(
				reopened,
				RealizerStub,
				PassingGateStub,
			);
			const persisted = await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* CdReleaseApi.clientInProcess;
					return yield* client.CdPromotionStatusView.get(promoId);
				}).pipe(Effect.scoped, Effect.provide(ReopenedWorld)),
			);

			expect(persisted).toEqual({
				_tag: "PendingApproval",
				campId,
				freightDigest: digest,
			});
		} finally {
			reopened.close();
		}
	});

	it("composes CdRelease with DomainRivet.layerDurableObjects via createCdReleaseRivetLayer", () => {
		const buildLayer = (pool: Layer.Layer<PoolHost>) =>
			createCdReleaseRivetLayer({
				name: "CdRelease",
				main: import.meta.url,
				handler: "CdReleaseLive",
				pool,
				realizer: RealizerStub,
				verificationGate: PassingGateStub,
			});
		expect(buildLayer).toBeTypeOf("function");
	});

	it("persists CD promotion gates in RivetKit SQLite, broadcasts events, and expires scheduled gates via setupTest", async (testCtx) => {
		const engine = await startLocalRivetTestEngine();
		const registry = createCdPromotionGateRegistry({
			endpoint: engine.endpoint,
			token: engine.token,
			httpHost: engine.httpHost,
			httpPort: engine.httpPort,
			startEngine: false,
			noWelcome: true,
			shutdown: { gracePeriodMs: 2_000, disableSignalHandlers: true },
		});

		try {
			const { client } = await setupTest(testCtx, registry);
			const gateActor = client.promotionGate.getOrCreate(["yard-prod-1"]);
			const conn = gateActor.connect();
			const receivedEvents: CdPromotionGateEvent[] = [];
			conn.on("gateUpdated", (payload: CdPromotionGateEvent) => {
				receivedEvents.push(payload);
			});

			try {
				const opened = await conn.openGate({
					promotionId: CdPromotionId.make("promo-rivet-1"),
					campId: CampTargetId.make("camp-us-west"),
					freightDigest: FreightDigest.make("sha256:rivet-v1"),
					deadlineMs: 10_000,
				});
				const deduped = await conn.openGate({
					promotionId: CdPromotionId.make("promo-rivet-1"),
					campId: CampTargetId.make("camp-different"),
					freightDigest: FreightDigest.make("sha256:rivet-v1"),
					deadlineMs: 10_000,
				});
				expect(deduped.campId).toBe(opened.campId);

				const resolved = await conn.resolveGate({
					promotionId: CdPromotionId.make("promo-rivet-1"),
					passed: true,
					summary: NonEmptyReason.make("slo-green"),
				});
				expect(resolved?.status).toBe("passed");
				expect(resolved?.summary).toBe("slo-green");

				await vi.waitFor(() => {
					expect(
						receivedEvents.some(
							(entry) =>
								entry.action === "resolved" &&
								entry.gate.promotionId === "promo-rivet-1",
						),
					).toBe(true);
				});

				await conn.openGate({
					promotionId: CdPromotionId.make("promo-rivet-premature"),
					campId: CampTargetId.make("camp-ap-south"),
					freightDigest: FreightDigest.make("sha256:rivet-premature"),
					deadlineMs: 60_000,
				});
				const premature = await conn.expireGate(
					CdPromotionId.make("promo-rivet-premature"),
				);
				expect(premature.expired).toBe(false);

				await conn.openGate({
					promotionId: CdPromotionId.make("promo-rivet-expiring"),
					campId: CampTargetId.make("camp-eu-west"),
					freightDigest: FreightDigest.make("sha256:rivet-v2"),
					deadlineMs: 60,
				});

				await expect
					.poll(
						async () => {
							const gates = await conn.listGates();
							return gates.find(
								(entry) => entry.promotionId === "promo-rivet-expiring",
							)?.status;
						},
						{ timeout: 5_000, interval: 25 },
					)
					.toBe("expired");
			} finally {
				await conn.dispose();
			}
		} finally {
			await registry.shutdown();
			await engine.stop();
		}
	}, 20_000);

	it("rejects unvalidated promotion gate open input at the Rivet boundary", async (testCtx) => {
		const engine = await startLocalRivetTestEngine();
		const registry = createCdPromotionGateRegistry({
			endpoint: engine.endpoint,
			token: engine.token,
			httpHost: engine.httpHost,
			httpPort: engine.httpPort,
			startEngine: false,
			noWelcome: true,
			shutdown: { gracePeriodMs: 2_000, disableSignalHandlers: true },
		});
		try {
			const { client } = await setupTest(testCtx, registry);
			const conn = client.promotionGate.getOrCreate(["yard-invalid"]).connect();
			await expect(
				// SAFETY: assertion to `as never` is required at this boundary to exercise Rivet schema rejection.
				conn.openGate({
					promotionId: "",
					campId: "",
					freightDigest: "",
					deadlineMs: -1,
				} as never),
			).rejects.toThrow();
			await conn.dispose();
		} finally {
			await engine.stop();
		}
	});

	it("routes pluggable CD delivery flows by target and fails closed for unregistered targets", async () => {
		const calls: string[] = [];
		const makeStub = (label: string) => ({
			publishRevision: ({
				deliveryRunId,
			}: {
				readonly deliveryRunId: string;
			}) =>
				Effect.sync(() => {
					calls.push(`${label}:publish:${deliveryRunId}`);
					return {
						outcome: {
							_tag: "Committed" as const,
							revision: RevisionRef.make(`${label}-rev-${deliveryRunId}`),
							targetRef: NonEmptyReason.make(`${label}:target`),
						},
					};
				}),
			observePullRequest: () =>
				Effect.succeed({
					observation: {
						_tag: "Merged" as const,
						mergeRevision: RevisionRef.make(`${label}-merged`),
						summary: NonEmptyReason.make(`${label}-pr-merged`),
					},
				}),
			observeConvergence: ({
				targetRevision,
			}: {
				readonly targetRevision: RevisionRef;
			}) =>
				Effect.succeed({
					observation: {
						_tag: "Converged" as const,
						appliedRevision: targetRevision,
						summary: NonEmptyReason.make(`${label}-converged`),
					},
				}),
			rollbackRevision: ({
				targetRevision,
			}: {
				readonly targetRevision: RevisionRef;
			}) =>
				Effect.succeed({
					rolledBack: true,
					rollbackRevision: RevisionRef.make(
						`${label}-revert-${targetRevision}`,
					),
					summary: NonEmptyReason.make(`${label}-rolled-back`),
				}),
		});

		const RouterLayer = createCdDeliveryFlowRouterLayer({
			"gitops-primary": makeStub("gitops-primary"),
			"release-orchestrator": makeStub("release-orchestrator"),
		});

		const primary = await Effect.runPromise(
			Effect.gen(function* () {
				const flow = yield* CdDeliveryFlow;
				return yield* flow.publishRevision({
					deliveryRunId: DeliveryRunId.make("run-router-1"),
					stageId: StageId.make("dev"),
					campId: CampTargetId.make("camp-dev"),
					freightDigest: FreightDigest.make("sha256:router-v1"),
					flowKind: "gitops-pull",
					flowTarget: DeliveryFlowTarget.make("gitops-primary"),
					previousRevision: null,
				});
			}).pipe(Effect.provide(RouterLayer)),
		);
		expect(primary.outcome.revision).toBe("gitops-primary-rev-run-router-1");

		const orchestrator = await Effect.runPromise(
			Effect.gen(function* () {
				const flow = yield* CdDeliveryFlow;
				return yield* flow.publishRevision({
					deliveryRunId: DeliveryRunId.make("run-router-2"),
					stageId: StageId.make("prod"),
					campId: CampTargetId.make("camp-prod"),
					freightDigest: FreightDigest.make("sha256:router-v1"),
					flowKind: "release-orchestrator",
					flowTarget: DeliveryFlowTarget.make("release-orchestrator"),
					previousRevision: null,
				});
			}).pipe(Effect.provide(RouterLayer)),
		);
		expect(orchestrator.outcome.revision).toBe(
			"release-orchestrator-rev-run-router-2",
		);
		expect(calls).toEqual([
			"gitops-primary:publish:run-router-1",
			"release-orchestrator:publish:run-router-2",
		]);

		const missingExit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const flow = yield* CdDeliveryFlow;
				return yield* flow.publishRevision({
					deliveryRunId: DeliveryRunId.make("run-router-missing"),
					stageId: StageId.make("prod"),
					campId: CampTargetId.make("camp-prod"),
					freightDigest: FreightDigest.make("sha256:router-v1"),
					flowKind: "agent-pull",
					flowTarget: DeliveryFlowTarget.make("unregistered-engine"),
					previousRevision: null,
				});
			}).pipe(Effect.provide(RouterLayer)),
		);
		expect(Exit.isFailure(missingExit)).toBe(true);
	});

	it("persists Freight, Stage, and Pull DeliveryRun over real HTTP and SQLite restarts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-cd-kargo-sqlite-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "kargo-pull.sqlite");
		const digest = FreightDigest.make("sha256:kargo-sqlite-v1");
		const stageId = StageId.make("dev");
		const runId = DeliveryRunId.make("run-kargo-sqlite-1");
		const nowMs = EpochMs.make(1_700_000_000_000);
		const flowTarget = DeliveryFlowTarget.make("gitops-primary");

		const FlowLayer = createCdDeliveryFlowRouterLayer({
			"gitops-primary": {
				publishRevision: () =>
					Effect.succeed({
						outcome: {
							_tag: "Committed" as const,
							revision: RevisionRef.make("commit-kargo-1"),
							targetRef: NonEmptyReason.make("gitops:repo@main"),
						},
					}),
				observePullRequest: () =>
					Effect.succeed({
						observation: {
							_tag: "Merged" as const,
							mergeRevision: RevisionRef.make("commit-kargo-1"),
							summary: NonEmptyReason.make("merged"),
						},
					}),
				observeConvergence: ({ targetRevision }) =>
					Effect.succeed({
						observation: {
							_tag: "Converged" as const,
							appliedRevision: targetRevision,
							summary: NonEmptyReason.make("synced-and-healthy"),
						},
					}),
				rollbackRevision: () =>
					Effect.succeed({
						rolledBack: true,
						rollbackRevision: null,
						summary: NonEmptyReason.make("reverted"),
					}),
			},
		});

		const first = createNodeSqliteDriver({ path: dbPath });
		try {
			const ApiServer = Layer.unwrap(
				Effect.gen(function* () {
					const api = yield* CdReleaseApi;
					return HttpServer.serve()(api.fetch);
				}),
			).pipe(
				Layer.provide(
					createCdReleaseSqliteLayer(
						first,
						RealizerStub,
						PassingGateStub,
						undefined,
						FlowLayer,
					),
				),
				Layer.provideMerge(NodeHttpServer.layerTest),
			);
			const HttpWorld = Layer.provideMerge(Domain.protocolHttp(""), ApiServer);

			await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* CdReleaseApi.client;
					yield* client.RecordFreight(digest, {
						warehouseId: WarehouseId.make("wh-core"),
						alias: FreightAlias.make("cedar-finch"),
						artifacts: [
							{
								kind: "oci-image",
								repository: "ghcr.io/hobo/service",
								reference: "1.0.0",
								digest,
							},
						],
						recordedAtMs: nowMs,
					});
					yield* client.ConfigureCdStage(stageId, {
						config: {
							warehouseId: WarehouseId.make("wh-core"),
							upstreamStages: UniqueStageList.make([]),
							availabilityStrategy: "direct",
							quorumCount: null,
							requiredSoakMs: NonNegativeCount.make(0),
							autoPromotion: "newest",
							deliveryFlow: "gitops-pull",
							flowTarget,
							campId: CampTargetId.make("camp-dev"),
							requiresApproval: false,
							implicitHealthVerification: true,
							triggerPullSync: false,
						},
					});
					yield* client.RequestStagePromotion(stageId, {
						deliveryRunId: runId,
						freightDigest: digest,
						nowMs,
						upstreamQualifications: [],
						manualApprovalExpiresAtMs: null,
					});
					yield* Effect.promise(
						() => new Promise((resolve) => setTimeout(resolve, 100)),
					);
				}).pipe(Effect.scoped, Effect.provide(HttpWorld)),
			);
		} finally {
			first.close();
		}

		const reopened = createNodeSqliteDriver({ path: dbPath });
		try {
			const ReopenedWorld = createCdReleaseSqliteLayer(
				reopened,
				RealizerStub,
				PassingGateStub,
				undefined,
				FlowLayer,
			);
			const persisted = await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* CdReleaseApi.clientInProcess;
					const freightView = yield* client.CdFreightCatalogView.get(digest);
					const stageView = yield* client.CdStageStatusView.get(stageId);
					const runView = yield* client.CdDeliveryRunStatusView.get(runId);
					return { freightView, stageView, runView };
				}).pipe(Effect.scoped, Effect.provide(ReopenedWorld)),
			);

			expect(persisted.runView?._tag).toBe("Completed");
			expect(persisted.stageView?._tag).toBe("Idle");
			if (persisted.stageView?._tag === "Idle") {
				expect(persisted.stageView.currentFreightDigest).toBe(digest);
				expect(persisted.stageView.currentVerified).toBe(true);
			}
			expect(persisted.freightView?._tag).toBe("Active");
			if (persisted.freightView?._tag === "Active") {
				expect(
					persisted.freightView.qualifications.some(
						(entry) => entry.stageId === stageId,
					),
				).toBe(true);
			}
		} finally {
			reopened.close();
		}
	});

	it("persists pull-based CD watches in RivetKit SQLite, broadcasts events, guards premature expiry, and times out via setupTest", async (testCtx) => {
		const engine = await startLocalRivetTestEngine();
		const registry = createCdPullWatchRegistry({
			endpoint: engine.endpoint,
			token: engine.token,
			httpHost: engine.httpHost,
			httpPort: engine.httpPort,
			startEngine: false,
			noWelcome: true,
			shutdown: { gracePeriodMs: 2_000, disableSignalHandlers: true },
		});

		try {
			const { client } = await setupTest(testCtx, registry);
			const watchActor = client.pullWatch.getOrCreate(["stage-prod"]);
			const conn = watchActor.connect();
			const receivedEvents: CdPullWatchEvent[] = [];
			conn.on("pullWatchUpdated", (payload: CdPullWatchEvent) => {
				receivedEvents.push(payload);
			});

			try {
				const registered = await conn.registerWatch({
					deliveryRunId: "run-rivet-pr-1",
					stageId: "prod",
					flowTarget: "gitops-primary",
					watchKind: "pull-request",
					targetRef: "pr-42",
					deadlineMs: 10_000,
				});
				expect(registered.status).toBe("watching");

				const deduped = await conn.registerWatch({
					deliveryRunId: "run-rivet-pr-1",
					stageId: "other-stage",
					flowTarget: "gitops-primary",
					watchKind: "pull-request",
					targetRef: "pr-99",
					deadlineMs: 10_000,
				});
				expect(deduped.stageId).toBe("prod");

				const resolved = await conn.recordObservation({
					deliveryRunId: "run-rivet-pr-1",
					status: "pr-merged",
					revision: "merge-sha-42",
					summary: "pull-request-merged",
				});
				expect(resolved?.status).toBe("pr-merged");
				expect(resolved?.revision).toBe("merge-sha-42");

				await vi.waitFor(() => {
					expect(
						receivedEvents.some(
							(entry) =>
								entry.action === "resolved" &&
								entry.watch.deliveryRunId === "run-rivet-pr-1",
						),
					).toBe(true);
				});

				await conn.registerWatch({
					deliveryRunId: "run-rivet-premature",
					stageId: "prod",
					flowTarget: "gitops-primary",
					watchKind: "convergence",
					targetRef: "merge-sha-42",
					deadlineMs: 60_000,
				});
				const premature = await conn.expireWatch("run-rivet-premature");
				expect(premature.expired).toBe(false);

				await conn.registerWatch({
					deliveryRunId: "run-rivet-timeout",
					stageId: "prod",
					flowTarget: "gitops-primary",
					watchKind: "convergence",
					targetRef: "merge-sha-99",
					deadlineMs: 60,
				});

				await expect
					.poll(
						async () => {
							const watches = await conn.listWatches();
							return watches.find(
								(entry) => entry.deliveryRunId === "run-rivet-timeout",
							)?.status;
						},
						{ timeout: 5_000, interval: 25 },
					)
					.toBe("timed-out");
			} finally {
				await conn.dispose();
			}
		} finally {
			await registry.shutdown();
			await engine.stop();
		}
	}, 20_000);
});
