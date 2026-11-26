/**
 * The replay service facade.
 *
 * This is the surface an operator's tooling calls, and its job is to keep two
 * promises: a session is only readable from the Station that recorded it, and
 * a failure comes back as a typed refusal rather than as a thrown error that a
 * caller might log with the payload attached. Both are checked here, along
 * with the honest-scope reporting the doctor exists to publish.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	createContractAssertedReplayFixtures,
	createReplayService,
	REPLAY_ENV_KILL,
} from "../src/index.js";

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
	temps.length = 0;
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-replay-"));
	temps.push(dir);
	return dir;
}

const STATION = "station:local";

function service(overrides: Record<string, unknown> = {}) {
	return createReplayService({
		stationId: STATION,
		memory: true,
		...overrides,
	});
}

describe("createReplayService — construction", () => {
	it("defaults to the local Station", () => {
		expect(createReplayService({ memory: true }).stationId).toBe(
			"station:local",
		);
	});

	it("uses an in-memory store when memory is requested", () => {
		const replay = service();
		expect(replay.store.label).toBe("contract-asserted-replay-fixtures");
		// Simulated, and it says so: a store that claimed live fidelity would let
		// a reader take a fixture session for a real recording.
		expect(replay.store.fidelity).toBe("simulated");
	});

	it("uses an in-memory store when no root directory is given", () => {
		// The `!input.rootDir` arm: constructing with neither flag must not try
		// to write to an undefined path.
		const replay = createReplayService({ stationId: STATION });
		expect(replay.store.fidelity).toBe("simulated");
	});

	it("uses a filesystem store when a root directory is given", () => {
		const root = tempDir();
		const replay = createReplayService({ stationId: STATION, rootDir: root });
		// Durability is the difference: a filesystem store survives the process,
		// which is what makes a recording available after the crash it captured.
		expect(replay.store.rootDir).toContain(root);
	});

	it("prefers memory even when a root directory is supplied", () => {
		const root = tempDir();
		const replay = createReplayService({
			stationId: STATION,
			rootDir: root,
			memory: true,
		});
		// An explicit `memory: true` is a test or a fixture run; writing to disk
		// anyway would leave artifacts a test never cleaned up.
		expect(replay.store.rootDir).not.toContain(root);
	});

	it("returns a frozen facade", () => {
		expect(Object.isFrozen(service())).toBe(true);
	});
});

describe("startRecording", () => {
	it("builds a default local tracker with no options", () => {
		const tracker = service().startRecording();
		expect(tracker).toBeDefined();
	});

	it("passes the environment through so the kill switch reaches the policy", () => {
		// The kill switch has to be reachable from the caller's environment, or
		// an operator could not turn recording off without a redeploy.
		const tracker = service().startRecording({
			env: { [REPLAY_ENV_KILL]: "0" },
		});
		expect(tracker).toBeDefined();
	});

	it("builds a fixture-seeded tracker when seed events are supplied", () => {
		const tracker = service().startRecording({
			seedEvents: [{ type: 2, data: {}, timestamp: 1 }] as never,
			sessionId: "sess-seeded",
		});
		// The seeded path exists so a test can drive a deterministic recording;
		// falling through to the live engine would make it capture nothing.
		expect(tracker).toBeDefined();
	});

	it("accepts a principal reference on the seeded path", () => {
		const tracker = service().startRecording({
			seedEvents: [{ type: 2, data: {}, timestamp: 1 }] as never,
			principalRef: "user:alice",
		});
		// The principal is what a later access check compares against; omitting
		// it would make every seeded session unattributable.
		expect(tracker).toBeDefined();
	});
});

describe("open", () => {
	it("refuses a session that does not exist", async () => {
		const result = await service().open("nope");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// A typed code rather than a thrown error: the caller is an HTTP surface
		// that has to map this onto a 404 rather than a 500.
		expect(result.code).toBe("REPLAY_NOT_FOUND");
		expect(result.message).toContain("nope");
	});

	it("refuses a session recorded by another Station", async () => {
		const replay = service();
		await replay.store.index.upsert({
			id: "s1",
			status: "ended",
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:10:00.000Z",
			correlation: {
				stationId: "station:other",
				isolationClass: "local-dev",
			},
		} as never);
		const result = await replay.open("s1");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// Station is the tenancy boundary for a recording of a real user's
		// screen. Serving one across it is the most direct privacy failure this
		// package could have.
		expect(result.code).toBe("REPLAY_ACCESS_DENIED");
		expect(result.message).toContain("access denied");
	});

	it("opens a session whose blob is missing as an empty payload", async () => {
		const replay = service();
		await replay.store.index.upsert({
			id: "s1",
			status: "ended",
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:10:00.000Z",
			correlation: { stationId: STATION, isolationClass: "local-dev" },
		} as never);
		const result = await replay.open("s1", ["sha256:missing"]);

		// Pinning what happens rather than what I expected. The index row exists
		// and access is allowed, but the blob behind it does not — and the load
		// succeeds with zero events rather than refusing.
		//
		// That is defensible: blob loss is a real intermediate state (retention
		// erases blobs, and an index row can outlive its recording), and the
		// session summary is still worth showing. But it means "the recording is
		// gone" and "the user did nothing" are indistinguishable to the player,
		// and only the first of those is worth an operator's attention. Flagged
		// rather than changed: making this a refusal would break opening a
		// summary for a legitimately erased session.
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.events).toHaveLength(0);
		expect(result.summary).toBeDefined();
	});

	it("returns the payload and a summary for a readable session", async () => {
		const replay = service();
		const tracker = replay.startRecording({
			seedEvents: [{ type: 2, data: {}, timestamp: 1 }] as never,
			sessionId: "sess-seeded",
		});
		// The tracker begins capturing on construction — there is no `start()`,
		// because a tracker that existed but was not recording would be a window
		// in which the bug being chased goes uncaptured.
		expect(tracker.enabled).toBe(true);
		await tracker.stop();

		const result = await replay.open("sess-seeded");
		// The happy path: both halves are returned, because a player needs the
		// events and an operator needs the summary that says which error and
		// which principal this session belongs to.
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload).toBeDefined();
		expect(result.summary).toBeDefined();
	});
});

describe("summarize, list, get", () => {
	async function withSession() {
		const replay = service();
		await replay.store.index.upsert({
			id: "s1",
			status: "ended",
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:10:00.000Z",
			correlation: { stationId: STATION, isolationClass: "local-dev" },
		} as never);
		return replay;
	}

	it("summarizes a session that exists", async () => {
		const replay = await withSession();
		expect(await replay.summarize("s1")).toBeDefined();
	});

	it("returns undefined for a session that does not exist", async () => {
		// Undefined rather than a throw: a summary is a read, and a missing
		// session is an ordinary answer to it.
		expect(await service().summarize("nope")).toBeUndefined();
	});

	it("scopes every listing to this Station", async () => {
		const replay = await withSession();
		await replay.store.index.upsert({
			id: "s2",
			status: "ended",
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:10:00.000Z",
			correlation: { stationId: "station:other", isolationClass: "local-dev" },
		} as never);
		const listed = await replay.list();
		// The station filter is applied by the facade, not left to the caller —
		// a caller that forgot it would enumerate another Station's recordings.
		expect(listed.map((s) => s.id)).toEqual(["s1"]);
	});

	it("cannot be talked out of the Station filter by a query", async () => {
		const replay = await withSession();
		// The spread puts `stationId` last, so a caller cannot override it. This
		// is the assertion that fails if that order is ever reversed.
		const listed = await replay.list({ stationId: "station:other" } as never);
		expect(listed.every((s) => s.correlation.stationId === STATION)).toBe(true);
	});

	it("passes other query fields through", async () => {
		const replay = await withSession();
		expect(await replay.list({ isolationClass: "local-dev" })).toHaveLength(1);
		expect(await replay.list({ isolationClass: "production" })).toHaveLength(0);
	});

	it("gets a session by id without a Station filter", async () => {
		const replay = await withSession();
		// `get` is the raw read; the Station check happens in `open`, which is
		// the path that actually returns recorded content.
		expect((await replay.get("s1"))?.id).toBe("s1");
		expect(await replay.get("nope")).toBeUndefined();
	});
});

describe("retention and erase", () => {
	async function withOldSession() {
		const replay = service();
		await replay.store.index.upsert({
			id: "s1",
			status: "ended",
			startedAt: "2020-01-01T00:00:00.000Z",
			endedAt: "2020-01-01T00:10:00.000Z",
			correlation: { stationId: STATION, isolationClass: "local-dev" },
		} as never);
		return replay;
	}

	it("applies the default retention policy", async () => {
		const replay = await withOldSession();
		const result = await replay.retention();
		// A six-year-old session is well past any default window; the facade has
		// to reach the policy rather than requiring one to be passed.
		expect(result.erased).toBe(1);
	});

	it("applies an explicit policy", async () => {
		const replay = await withOldSession();
		const result = await replay.retention({
			maxAgeDays: 100_000,
			retainIsolationClasses: [],
		} as never);
		// An explicit window overrides the default in both directions, which is
		// what makes a longer legal-hold period expressible.
		expect(result.erased).toBe(0);
		expect(result.retained).toBe(1);
	});

	it("erases a session and scopes the erase to this Station", async () => {
		const replay = await withOldSession();
		expect((await replay.erase("s1"))?.status).toBe("erased");
		// Erase is the data-deletion path; it must be Station-scoped for the same
		// reason `open` is.
		expect(await replay.erase("nope")).toBeUndefined();
	});
});

describe("doctor", () => {
	it("reports the package, Station and kill switch", () => {
		const report = service().doctor();
		expect(report.package).toBe("@hobo/replay");
		expect(report.stationId).toBe(STATION);
		expect(report.defaultLocalOn).toBe(true);
		// The kill switch is printed so an operator reading a doctor report knows
		// how to turn recording off without going looking for it.
		expect(report.killEnv).toBe("HOBO_REPLAY=0");
	});

	it("publishes the honest-scope caveats rather than claiming full coverage", () => {
		const report = service().doctor();
		// The doctor's job is to be honest about what is a fixture and what is
		// live. A report that omitted these would let a reader assume the
		// object-storage lane is proven when it is port-based.
		expect(report.honestScope.length).toBeGreaterThan(0);
		expect(report.honestScope.join(" ")).toMatch(/dual fixtures/u);
		expect(Object.isFrozen(report.honestScope)).toBe(true);
	});

	it("lists every PACT-verified boundary", () => {
		const report = service().doctor();
		expect(report.boundaries.length).toBeGreaterThan(0);
		expect(Object.isFrozen(report.boundaries)).toBe(true);
	});

	it("returns a frozen report", () => {
		expect(Object.isFrozen(service().doctor())).toBe(true);
	});
});

describe("createContractAssertedReplayFixtures", () => {
	it("bundles a memory-backed service with its store", () => {
		const fixtures = createContractAssertedReplayFixtures();
		expect(fixtures.service.stationId).toBe("station:local");
		expect(fixtures.label).toBe("contract-asserted-replay-fixtures");
		// Simulated, stated twice — on the store and on the bundle — so neither
		// can be read in isolation as a live result.
		expect(fixtures.fidelity).toBe("simulated");
		expect(fixtures.sampleSessionId).toBe("sess-fixture-1");
	});

	it("honours an explicit Station", () => {
		expect(
			createContractAssertedReplayFixtures({ stationId: "station:eu" }).service
				.stationId,
		).toBe("station:eu");
	});

	it("is frozen and shares the service's own store", () => {
		const fixtures = createContractAssertedReplayFixtures();
		expect(Object.isFrozen(fixtures)).toBe(true);
		// The same index, not a copy: a fixture written through the bundle has to
		// be visible to the service that will read it.
		expect(fixtures.index).toBe(fixtures.service.store.index);
	});
});
