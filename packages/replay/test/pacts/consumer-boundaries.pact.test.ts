/**
 * Consumer-side exercises: drive real package APIs that own each boundary and
 * assert the HTTP surface (provider) matches the pact-declared contract shape.
 */
import { describe, expect, it } from "vitest";

import { evaluateReplayAccess } from "../../src/access.js";
import {
	deriveBindleSessionReplayPlan,
	sessionReplayAnnotation,
	wrapBindleWebHandler,
} from "../../src/bindle-integration.js";
import { buildCorrelation } from "../../src/correlation.js";
import { createReplayEvent, REPLAY_EVENTS } from "../../src/events.js";
import { buildEvidencePack } from "../../src/evidence.js";
import {
	createReplayHttpSurface,
	REPLAY_BOUNDARIES,
	seedReplayFixture,
} from "../../src/http-surface.js";
import { createMemoryMeterSink, meterIngest } from "../../src/metering.js";
import { evaluateRecordingPolicy } from "../../src/policy.js";
import { maskRrwebEvents } from "../../src/privacy.js";
import { applyRetention } from "../../src/retention.js";
import { createReplayService } from "../../src/service.js";
import { createMemoryDualFixtures } from "../../src/storage.js";
import { createFixtureRecordEngine, createTracker } from "../../src/tracker.js";
import { defaultPrivacyPolicy, parseSessionRecord } from "../../src/types.js";

describe("consumer boundaries (real APIs ↔ HTTP surface)", () => {
	it("REPLAY_BOUNDARIES catalogs every internal and external edge", () => {
		const ids = REPLAY_BOUNDARIES.map((b) => b.id);
		for (const required of [
			"tracker-ingest",
			"player-store-get",
			"privacy-mask",
			"policy-evaluate",
			"access-evaluate",
			"retention-apply",
			"metering-record",
			"evidence-pack",
			"correlation-build",
			"events-emit",
			"blob-put",
			"bindle-wrap-html",
			"cli-summarize",
			"doctor",
		]) {
			expect(ids).toContain(required);
		}
		expect(REPLAY_BOUNDARIES.some((b) => b.internal)).toBe(true);
		expect(REPLAY_BOUNDARIES.some((b) => !b.internal)).toBe(true);
	});

	it("tracker consumer: mask → put chunk → lifecycle event", async () => {
		const surface = createReplayHttpSurface({ stationId: "station:local" });
		const events = maskRrwebEvents([
			{
				type: 3,
				timestamp: 1,
				data: {
					tagName: "input",
					type: "password",
					attributes: { type: "password" },
					value: "hunter2",
					textContent: "hunter2",
				},
			},
		]);
		expect(JSON.stringify(events)).not.toContain("hunter2");

		const ingest = await surface.handle({
			method: "POST",
			path: "/replay/sessions/sess-consumer-1/chunks",
			headers: { "x-hobo-station": "station:local" },
			body: { seq: 0, events },
		});
		expect(ingest.status).toBe(202);
		expect((ingest.body as { ok: boolean }).ok).toBe(true);

		const evt = createReplayEvent(REPLAY_EVENTS.ChunkIngested, {
			sessionId: "sess-consumer-1",
			stationId: "station:local",
			seq: 0,
			data: {
				blobRef: (ingest.body as { blobRef: string }).blobRef,
				bytes: 1,
			},
		});
		expect(evt.type).toBe("replay.ChunkIngested");
	});

	it("player consumer: open/list against seeded index", async () => {
		const surface = createReplayHttpSurface({ stationId: "station:local" });
		await seedReplayFixture(surface.store, {
			sessionId: "sess-local-1",
			errorId: "err-42",
		});
		const listed = await surface.handle({
			method: "GET",
			path: "/replay/sessions?errorId=err-42",
		});
		expect(listed.status).toBe(200);
		const sessions = (listed.body as { sessions: { id: string }[] }).sessions;
		expect(sessions.some((s) => s.id === "sess-local-1")).toBe(true);

		const got = await surface.handle({
			method: "GET",
			path: "/replay/sessions/sess-local-1",
			headers: { "x-hobo-station": "station:local" },
		});
		expect(got.status).toBe(200);

		const denied = await surface.handle({
			method: "GET",
			path: "/replay/sessions/sess-local-1",
			headers: { "x-hobo-station": "station:other" },
		});
		expect(denied.status).toBe(403);
	});

	it("policy + access + retention + metering consumers", async () => {
		expect(
			evaluateRecordingPolicy({ isolationClass: "local-dev" }).enabled,
		).toBe(true);
		expect(evaluateRecordingPolicy({ env: { HOBO_REPLAY: "0" } }).enabled).toBe(
			false,
		);

		const session = parseSessionRecord({
			id: "sess-1",
			status: "ended",
			startedAt: "2026-01-01T00:00:00.000Z",
			correlation: {
				stationId: "station:local",
				tenant: "local",
				env: "local-dev",
				isolationClass: "local-dev",
				harnessFlagKeys: [],
			},
			privacy: defaultPrivacyPolicy(),
			chunkCount: 0,
			totalBytes: 0,
		});
		expect(
			evaluateReplayAccess({
				session,
				viewerStationId: "station:local",
			}).allowed,
		).toBe(true);

		const store = createMemoryDualFixtures();
		await store.index.upsert({
			...session,
			endedAt: "2020-01-01T00:00:00.000Z",
		});
		const retention = await applyRetention({
			index: store.index,
			stationId: "station:local",
			policy: { maxAgeDays: 30, eraseOnRequest: true },
			now: new Date("2026-01-01T00:00:00.000Z"),
		});
		expect(retention.erased).toBe(1);

		const sink = createMemoryMeterSink();
		meterIngest(sink, {
			sessionId: "sess-1",
			stationId: "station:local",
			tenant: "local",
			bytes: 100,
		});
		expect(sink.events[0]?.kind).toBe("ingest-bytes");
	});

	it("correlation + evidence consumers refuse PII and build packs", () => {
		const corr = buildCorrelation({
			stationId: "station:local",
			principalRef: "principal:dual-1",
			errorId: "err-1",
			harnessFlagKeys: ["hobo.session-replay"],
		});
		expect(corr.principalRef).toBe("principal:dual-1");
		expect(() =>
			buildCorrelation({
				stationId: "station:local",
				principalRef: "user@example.com",
			}),
		).toThrow(/PII/);

		const pack = buildEvidencePack({
			session: parseSessionRecord({
				id: "sess-e",
				status: "ended",
				startedAt: "2026-01-01T00:00:00.000Z",
				correlation: {
					stationId: "station:local",
					tenant: "local",
					env: "local-dev",
					isolationClass: "local-dev",
					harnessFlagKeys: [],
				},
				privacy: defaultPrivacyPolicy(),
				chunkCount: 0,
				totalBytes: 0,
			}),
			recording: [{ type: 2, timestamp: 1, data: {} }],
			playwrightRefs: ["trace.zip"],
		});
		expect(pack.schemaVersion).toBe("hobo.replay-evidence/v1");
	});

	it("bindle host consumer: plan + wrap HTML + service doctor", async () => {
		const plan = deriveBindleSessionReplayPlan({
			name: "shop",
			resources: {
				web: {
					kind: "web",
					name: "web",
					annotations: [sessionReplayAnnotation()],
				},
			},
		});
		expect(plan.enabled).toBe(true);

		const surface = wrapBindleWebHandler(
			async () =>
				new Response("<html><body>hi</body></html>", {
					headers: { "content-type": "text/html" },
				}),
			{ bindleName: "shop", resourceName: "web", enabled: true },
		);
		const page = await surface.handler(new Request("http://x/"));
		expect(await page.text()).toContain("data-hobo-replay");

		const service = createReplayService({ memory: true });
		const tracker = service.startRecording({
			sessionId: "sess-svc-1",
			seedEvents: [{ type: 2, timestamp: 1, data: { tagName: "div" } }],
		});
		await tracker.flush();
		await tracker.stop();
		expect(await service.summarize("sess-svc-1")).toContain("sess-svc-1");
		expect(service.doctor().package).toBe("@hobo/replay");
	});

	it("end-to-end tracker consumer through dual fixtures", async () => {
		const fixtures = createMemoryDualFixtures();
		const tracker = createTracker({
			sessionId: "sess-e2e-1",
			correlation: buildCorrelation({ stationId: "station:local" }),
			store: fixtures.blobs,
			index: fixtures.index,
			engine: createFixtureRecordEngine([
				{ type: 2, timestamp: 1, data: { tagName: "html" } },
			]),
			batchSize: 1,
		});
		await tracker.flush();
		const ended = await tracker.stop();
		expect(ended?.chunkCount).toBeGreaterThan(0);
		const surface = createReplayHttpSurface({
			store: fixtures,
			stationId: "station:local",
		});
		const summary = await surface.handle({
			method: "GET",
			path: "/replay/sessions/sess-e2e-1/summarize",
		});
		expect(summary.status).toBe(200);
	});
});
