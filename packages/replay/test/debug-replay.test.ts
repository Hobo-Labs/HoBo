import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	buildCorrelation,
	createDebugReplayRecorder,
	createDebugTrackEnvelope,
	createFilesystemDualFixtures,
	createMemoryDualFixtures,
	DEBUG_REPLAY_TRACKS,
	loadPlayerPayload,
	REPLAY_EVENTS,
	resolveDebugReplayLevel,
} from "../src/index.js";

describe("debug replay contract", () => {
	it("defaults to observable and keeps the kill switch authoritative", () => {
		expect(resolveDebugReplayLevel()).toBe("observable");
		expect(resolveDebugReplayLevel({ level: "diagnostic" })).toBe("diagnostic");
		expect(
			resolveDebugReplayLevel({
				level: "diagnostic",
				env: { HOBO_REPLAY: "0" },
			}),
		).toBe("off");
	});

	it("builds level-scoped envelopes and redacts diagnostic secrets", () => {
		const observable = createDebugTrackEnvelope({
			track: "agent",
			sequence: 4,
			timestamp: 123,
			metadata: { tool: "exec" },
			observable: { result: "ok" },
			diagnostic: { trace: "verbose" },
		});
		expect(observable?.data).toMatchObject({
			track: "agent",
			sequence: 4,
			level: "observable",
			payload: {
				metadata: { tool: "exec" },
				observable: { result: "ok" },
			},
		});
		expect(JSON.stringify(observable)).not.toContain("verbose");
		const metadata = createDebugTrackEnvelope({
			track: "test",
			sequence: 5,
			timestamp: 124,
			level: "metadata",
			metadata: { status: "failed" },
			observable: { output: "private test output" },
		});
		expect(metadata?.data.payload).toEqual({
			metadata: { status: "failed" },
		});

		const diagnostic = createDebugTrackEnvelope({
			track: "approval",
			sequence: 6,
			timestamp: 125,
			level: "diagnostic",
			metadata: { action: "apply" },
			diagnostic: {
				password: "hunter2",
				reasoning: "hidden chain of thought",
				headers: { Authorization: "Bearer secret-token" },
			},
		});
		const serialized = JSON.stringify(diagnostic);
		expect(serialized).not.toContain("hunter2");
		expect(serialized).not.toContain("hidden chain of thought");
		expect(serialized).not.toContain("secret-token");
	});

	it("stores ordered track chunks and exposes a read-only player timeline", async () => {
		const fixtures = createMemoryDualFixtures();
		const lifecycle: string[] = [];
		const recorder = createDebugReplayRecorder({
			sessionId: "debug-1",
			correlation: buildCorrelation({ stationId: "station:local" }),
			store: fixtures.blobs,
			index: fixtures.index,
			level: "diagnostic",
			batchSize: 2,
			onEvent: (event) => lifecycle.push(event.type),
		});

		for (const [index, track] of DEBUG_REPLAY_TRACKS.entries()) {
			expect(
				recorder.record({
					track,
					timestamp: 1_000 + index,
					metadata: { label: `${track}:${index}` },
					observable: { visible: true },
					diagnostic: { detail: index },
				}),
			).toBe(true);
		}

		const recording = await recorder.stop();
		expect(recording?.chunks).toHaveLength(4);
		expect(
			recording?.chunks.every((chunk) =>
				chunk.contentHash.startsWith("sha256:"),
			),
		).toBe(true);
		expect(recording?.session.chunkCount).toBe(4);
		expect(lifecycle[0]).toBe(REPLAY_EVENTS.Started);
		expect(lifecycle.at(-1)).toBe(REPLAY_EVENTS.Ended);

		const player = await loadPlayerPayload({
			sessionId: "debug-1",
			index: fixtures.index,
			blobs: fixtures.blobs,
			stationId: "station:local",
			blobRefs: recording?.chunks.map((chunk) => chunk.blobRef),
		});
		expect(player.debugTimeline.map((item) => item.sequence)).toEqual([
			0, 1, 2, 3, 4, 5, 6,
		]);
		expect(player.debugTimeline.map((item) => item.track)).toEqual(
			DEBUG_REPLAY_TRACKS,
		);
		expect(player.openUi.readOnly).toBe(true);
		expect(JSON.stringify(player.debugTimeline)).not.toContain("detail");
	});

	it("records nothing when the hard kill switch is set", async () => {
		const fixtures = createMemoryDualFixtures();
		const lifecycle: string[] = [];
		const recorder = createDebugReplayRecorder({
			sessionId: "debug-off",
			correlation: buildCorrelation({ stationId: "station:local" }),
			store: fixtures.blobs,
			index: fixtures.index,
			level: "diagnostic",
			env: { HOBO_REPLAY: "0" },
			onEvent: (event) => lifecycle.push(event.type),
		});
		expect(recorder.enabled).toBe(false);
		expect(
			recorder.record({ track: "terminal", metadata: { command: "pwd" } }),
		).toBe(false);
		expect(await recorder.stop()).toBeUndefined();
		expect(await fixtures.index.get("debug-off")).toBeUndefined();
		expect(lifecycle).toEqual([REPLAY_EVENTS.Disabled]);
	});

	it("reloads persisted debug timelines without process-local blob refs", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-debug-replay-"));
		try {
			const fixtures = createFilesystemDualFixtures(root);
			const recorder = createDebugReplayRecorder({
				sessionId: "debug-persisted",
				correlation: buildCorrelation({ stationId: "station:local" }),
				store: fixtures.blobs,
				index: fixtures.index,
				batchSize: 1,
			});
			recorder.record({
				track: "terminal",
				metadata: { paneId: "pane-1" },
			});
			await recorder.stop();

			const restarted = createFilesystemDualFixtures(root);
			const player = await loadPlayerPayload({
				sessionId: "debug-persisted",
				index: restarted.index,
				blobs: restarted.blobs,
				stationId: "station:local",
			});
			expect(player.debugTimeline).toEqual([
				expect.objectContaining({ track: "terminal", sequence: 0 }),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps read-only flushes immutable and resumes persisted sequences", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-debug-resume-"));
		try {
			const fixtures = createFilesystemDualFixtures(root);
			const first = createDebugReplayRecorder({
				sessionId: "debug-resumed",
				correlation: buildCorrelation({ stationId: "station:local" }),
				store: fixtures.blobs,
				index: fixtures.index,
				batchSize: 1,
			});
			first.record({ track: "terminal", metadata: { command: "pwd" } });
			await first.stop();

			const beforeRead = await fixtures.index.get("debug-resumed");
			const reader = createDebugReplayRecorder({
				sessionId: "debug-resumed",
				correlation: buildCorrelation({ stationId: "station:local" }),
				store: fixtures.blobs,
				index: fixtures.index,
			});
			await reader.flush();
			expect(await fixtures.index.get("debug-resumed")).toEqual(beforeRead);

			const resumed = createDebugReplayRecorder({
				sessionId: "debug-resumed",
				correlation: buildCorrelation({ stationId: "station:local" }),
				store: fixtures.blobs,
				index: fixtures.index,
				batchSize: 1,
			});
			resumed.record({ track: "git", metadata: { operation: "commit" } });
			await resumed.stop();

			const chunks = await fixtures.index.listChunks("debug-resumed");
			expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1]);
			const player = await loadPlayerPayload({
				sessionId: "debug-resumed",
				index: fixtures.index,
				blobs: fixtures.blobs,
				stationId: "station:local",
			});
			expect(player.debugTimeline.map((item) => item.sequence)).toEqual([0, 1]);
			expect(await fixtures.index.get("debug-resumed")).toMatchObject({
				status: "ended",
				chunkCount: 2,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
