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
	ApproverId,
	CampTargetId,
	CdCampRealizer,
	CdFanoutId,
	CdPromotionId,
	CdReleaseApi,
	CdVerificationGate,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	RealizationRef,
	UniqueCampWave,
} from "../src/domain/index.js";
import {
	type CdPromotionGateEvent,
	createCdPromotionGateRegistry,
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
});
