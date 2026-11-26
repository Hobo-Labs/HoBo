/**
 * Advisory bench: dual-fixture flush throughput (not a CI gate threshold).
 */
import { performance } from "node:perf_hooks";

import {
	buildCorrelation,
	createFixtureRecordEngine,
	createMemoryDualFixtures,
	createTracker,
} from "@hobo/replay";

const fixtures = createMemoryDualFixtures();
const events = Array.from({ length: 200 }, (_, i) => ({
	type: 3,
	timestamp: i,
	data: { i },
}));
const t0 = performance.now();
const tracker = createTracker({
	correlation: buildCorrelation({ stationId: "station:local" }),
	store: fixtures.blobs,
	index: fixtures.index,
	engine: createFixtureRecordEngine(events),
	batchSize: 50,
});
await tracker.flush();
await tracker.stop();
const ms = performance.now() - t0;
console.log(
	JSON.stringify({
		events: events.length,
		ms: Math.round(ms * 100) / 100,
		eventsPerMs: Math.round((events.length / ms) * 100) / 100,
		advisory: true,
	}),
);
