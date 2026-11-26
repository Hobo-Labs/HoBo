/**
 * Technical proof surface: re-export contract constants + dual-fixture golden path.
 */
import {
	HOBO_REPLAY_PACKAGE,
	REPLAY_CONTRACT_VERSION,
	REPLAY_EVENTS,
	REPLAY_SCHEMA_VERSION,
	createMemoryDualFixtures,
	createTracker,
	buildCorrelation,
	createFixtureRecordEngine,
	createReplayEvent,
} from "@hobo/replay";

export async function proveRecordStorePlay(): Promise<{
	ok: boolean;
	package: string;
	sessionId: string;
	chunkCount: number;
	eventTypes: readonly string[];
}> {
	const fixtures = createMemoryDualFixtures();
	const events: ReturnType<typeof createReplayEvent>[] = [];
	const tracker = createTracker({
		sessionId: "sess-proof-1",
		correlation: buildCorrelation({ stationId: "station:local" }),
		store: fixtures.blobs,
		index: fixtures.index,
		engine: createFixtureRecordEngine([
			{ type: 2, timestamp: 1, data: { tagName: "html" } },
			{ type: 3, timestamp: 2, data: { source: 1 } },
		]),
		onEvent: (e) => {
			events.push(e);
		},
	});
	await tracker.flush();
	const ended = await tracker.stop();
	return {
		ok: ended?.status === "ended" && (ended?.chunkCount ?? 0) > 0,
		package: HOBO_REPLAY_PACKAGE,
		sessionId: tracker.sessionId,
		chunkCount: ended?.chunkCount ?? 0,
		eventTypes: events.map((e) => e.type),
	};
}

export const CONTRACT = Object.freeze({
	package: HOBO_REPLAY_PACKAGE,
	schema: REPLAY_SCHEMA_VERSION,
	contract: REPLAY_CONTRACT_VERSION,
	lifecycle: REPLAY_EVENTS,
});
