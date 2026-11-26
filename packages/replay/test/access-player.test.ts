import { describe, expect, it } from "vitest";

import { evaluateReplayAccess } from "../src/access.js";
import { isReplayAutoWired, webReplayAutowire } from "../src/autowire.js";
import { createReplayEvent, REPLAY_EVENTS } from "../src/events.js";
import {
	createMemoryMeterSink,
	meterIngest,
	meterPlayerAccess,
} from "../src/metering.js";
import {
	createFixtureReplayEngine,
	loadPlayerPayload,
	summarizeSession,
} from "../src/player.js";
import { defaultPrivacyPolicy } from "../src/privacy.js";
import { applyRetention } from "../src/retention.js";
import { createMemoryDualFixtures } from "../src/storage.js";
import {
	parseSessionCorrelation,
	REPLAY_CORRELATION_SCHEMA,
	REPLAY_PRIVACY_SCHEMA,
	REPLAY_SCHEMA_VERSION,
} from "../src/types.js";

function sampleSession(
	overrides: Partial<{
		stationId: string;
		isolationClass: "local-dev" | "production";
		status: "ended" | "erased" | "recording";
	}> = {},
) {
	return {
		schemaVersion: REPLAY_SCHEMA_VERSION,
		id: "sess-1",
		status: overrides.status ?? ("ended" as const),
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:01:00.000Z",
		correlation: {
			schemaVersion: REPLAY_CORRELATION_SCHEMA,
			stationId: overrides.stationId ?? "station:local",
			harnessFlagKeys: Object.freeze(["hobo.session-replay"] as string[]),
			isolationClass: overrides.isolationClass ?? ("local-dev" as const),
			tenant: "local",
			env: "local-dev",
			errorId: "err-1",
		},
		privacy: defaultPrivacyPolicy(),
		chunkCount: 1,
		totalBytes: 128,
		summary: "demo",
	};
}

describe("access + player + retention", () => {
	it("same-station local view allowed; production needs elevation", () => {
		const local = evaluateReplayAccess({
			session: sampleSession(),
			viewerStationId: "station:local",
		});
		expect(local.allowed).toBe(true);

		const prod = evaluateReplayAccess({
			session: sampleSession({ isolationClass: "production" }),
			viewerStationId: "station:local",
		});
		expect(prod.allowed).toBe(false);
		expect(prod.reason).toBe("production-requires-elevation");

		const elevated = evaluateReplayAccess({
			session: sampleSession({ isolationClass: "production" }),
			viewerStationId: "station:local",
			elevatedCapability: {
				scope: "replay.view",
				stationId: "station:local",
				expiresAt: "2099-01-01T00:00:00.000Z",
			},
		});
		expect(elevated.allowed).toBe(true);
	});

	it("cross-station fails closed without federation", () => {
		const denied = evaluateReplayAccess({
			session: sampleSession({ stationId: "station:a" }),
			viewerStationId: "station:b",
		});
		expect(denied.allowed).toBe(false);
		expect(denied.reason).toBe("station-mismatch");

		const fed = evaluateReplayAccess({
			session: sampleSession({ stationId: "station:a" }),
			viewerStationId: "station:b",
			federationGrant: {
				fromStationId: "station:a",
				toStationId: "station:b",
				scope: "replay.view",
			},
		});
		expect(fed.allowed).toBe(true);
	});

	it("player reconstructs fixture events and OpenUI descriptor", async () => {
		const fixtures = createMemoryDualFixtures();
		const session = sampleSession();
		await fixtures.index.upsert(session);
		const chunk = await fixtures.blobs.put("sess-1", 0, [
			{ type: 2, timestamp: 1, data: { tagName: "html" } },
			{ type: 3, timestamp: 50, data: { source: 2 } },
		]);
		const payload = await loadPlayerPayload({
			sessionId: "sess-1",
			index: fixtures.index,
			blobs: fixtures.blobs,
			stationId: "station:local",
			blobRefs: [chunk.blobRef],
		});
		expect(payload.events).toHaveLength(2);
		expect(payload.openUi.kind).toBe("hobo.replay.player");
		expect(payload.openUi.mutationSurface).toBe("cli-only");
		expect(payload.openUi.controlYardZone).toBe("session-replay");
		expect(payload.deepLink).toContain("sess-1");

		const recon = createFixtureReplayEngine().reconstruct(payload.events);
		expect(recon.ok).toBe(true);
		expect(recon.durationMs).toBe(49);
		expect(summarizeSession(session)).toContain("err-1");
	});

	it("player refuses foreign station", async () => {
		const fixtures = createMemoryDualFixtures();
		await fixtures.index.upsert(sampleSession({ stationId: "station:a" }));
		await expect(
			loadPlayerPayload({
				sessionId: "sess-1",
				index: fixtures.index,
				blobs: fixtures.blobs,
				stationId: "station:b",
			}),
		).rejects.toMatchObject({ code: "REPLAY_STATION_BOUNDARY" });
	});

	it("retention GC erases aged sessions", async () => {
		const fixtures = createMemoryDualFixtures();
		const old = {
			...sampleSession(),
			id: "sess-old",
			endedAt: "2020-01-01T00:00:00.000Z",
		};
		await fixtures.index.upsert(old);
		const result = await applyRetention({
			index: fixtures.index,
			stationId: "station:local",
			policy: { maxAgeDays: 30, eraseOnRequest: true },
			now: new Date("2026-01-01T00:00:00.000Z"),
		});
		expect(result.erased).toBe(1);
		const after = await fixtures.index.get("sess-old");
		expect(after?.status).toBe("erased");
	});

	it("metering records ingest and player access", () => {
		const sink = createMemoryMeterSink();
		meterIngest(sink, {
			sessionId: "s1",
			stationId: "station:local",
			tenant: "local",
			bytes: 2048,
		});
		meterPlayerAccess(sink, {
			sessionId: "s1",
			stationId: "station:local",
			tenant: "local",
		});
		expect(sink.events).toHaveLength(2);
		expect(sink.events[0]?.kind).toBe("ingest-bytes");
	});

	it("lifecycle events refuse embedded rrweb streams", () => {
		expect(() =>
			createReplayEvent(REPLAY_EVENTS.ChunkIngested, {
				sessionId: "s1",
				stationId: "station:local",
				seq: 0,
				data: { events: [{ type: 1 }] },
			}),
		).toThrow(/blob_ref/);
	});

	it("refuses PII in principalRef", () => {
		expect(() =>
			parseSessionCorrelation({
				stationId: "station:local",
				tenant: "t",
				env: "local-dev",
				isolationClass: "local-dev",
				principalRef: "user@example.com",
			}),
		).toThrow(/PII/);
	});

	it("autowire snippet present and respects kill env", () => {
		const wire = webReplayAutowire();
		expect(wire.bindleFeature.localDefault).toBe(true);
		expect(wire.bindleFeature.productionDefault).toBe(false);
		expect(wire.performanceBudget.mainThreadBudgetMs).toBe(16);
		expect(isReplayAutoWired({})).toBe(true);
		expect(isReplayAutoWired({ HOBO_REPLAY: "0" })).toBe(false);
	});

	it("privacy schema constant is stable", () => {
		expect(REPLAY_PRIVACY_SCHEMA).toBe("hobo.replay-privacy/v1");
	});
});
