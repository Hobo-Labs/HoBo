/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-chained-type-assertions, anti-slop/no-object-parameters -- SAFETY: test journal payloads are deliberately untyped Station events. */
import { describe, expect, it } from "vitest";
import {
	createJournalRailCatalog,
	createJournalRailEventReader,
	createRailDeliveryReader,
	parseRailDelivery,
	RAIL_EVENT_TYPES,
	RAIL_READER_METRICS,
} from "../../src/compose/rails.js";
import type { CampPolicy } from "../../src/ports.js";
import {
	asCamp,
	camp,
	DIGEST_A,
	DIGEST_B,
	fakeStore,
	fakeTopology,
	recordingSink,
	staticCatalog,
} from "./fakes.js";

function rail(digest: string, stationId = "st1", delivery?: object) {
	return {
		id: "rail-1",
		stationId,
		contentHash: digest,
		...(delivery ? { delivery } : undefined),
	};
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of it) out.push(x);
	return out;
}

describe("journal rail catalog", () => {
	it("folds published → approved → activated → retired per Station", async () => {
		const store = fakeStore();
		const catalog = createJournalRailCatalog({ store });
		store.push("station-st1", RAIL_EVENT_TYPES.published, {
			rail: rail(DIGEST_A),
		});
		expect((await catalog.byDigest(DIGEST_A))?.status).toBe("published");
		expect(await catalog.active("st1")).toBeUndefined();
		store.push("station-st1", RAIL_EVENT_TYPES.approved, {
			rail: rail(DIGEST_A, "st1", { campSets: ["prod"] }),
			contentHash: DIGEST_A,
		});
		store.push("station-st1", RAIL_EVENT_TYPES.activated, {
			contentHash: DIGEST_A,
		});
		const active = await catalog.active("st1");
		expect(active?.railDigest).toBe(DIGEST_A);
		expect(active?.delivery).toEqual({ campSets: ["prod"] });
		store.push("station-st1", RAIL_EVENT_TYPES.approved, {
			rail: rail(DIGEST_B),
		});
		store.push("station-st1", RAIL_EVENT_TYPES.activated, {
			contentHash: DIGEST_B,
		});
		expect((await catalog.active("st1"))?.railDigest).toBe(DIGEST_B);
		expect((await catalog.byDigest(DIGEST_A))?.status).toBe("approved");
		store.push("station-st1", RAIL_EVENT_TYPES.retired, {
			contentHash: DIGEST_B,
		});
		expect(await catalog.active("st1")).toBeUndefined();
	});

	it("skips malformed Rail events (no digest, no station)", async () => {
		const store = fakeStore();
		store.push("s", RAIL_EVENT_TYPES.approved, {
			rail: { id: "x", contentHash: "nope" },
		});
		store.push("s", RAIL_EVENT_TYPES.activated, { contentHash: DIGEST_A });
		const catalog = createJournalRailCatalog({ store });
		expect(await catalog.active("st1")).toBeUndefined();
	});
});

describe("journal RailEventReader (HOBO_RAIL driver input)", () => {
	it("reports approvals, activations and retirements forward from the cursor", async () => {
		const store = fakeStore();
		store.push("s", RAIL_EVENT_TYPES.published, { rail: rail(DIGEST_A) });
		store.push("s", RAIL_EVENT_TYPES.approved, {
			rail: rail(DIGEST_A),
			contentHash: DIGEST_A,
		});
		store.push("s", "unrelated.Event", {});
		store.push("s", RAIL_EVENT_TYPES.activated, { contentHash: DIGEST_A });
		const read = createJournalRailEventReader({ store });
		const all = await collect(read(undefined, new AbortController().signal));
		expect(all.map((e) => e.status)).toEqual(["approved", "active"]);
		expect(all[0]).toMatchObject({
			railId: "rail-1",
			railDigest: DIGEST_A,
			stationId: "st1",
		});
		const cursor = all[0]?.cursor;
		store.push("s", RAIL_EVENT_TYPES.retired, { contentHash: DIGEST_A });
		const after = await collect(read(cursor, new AbortController().signal));
		expect(after.map((e) => e.status)).toEqual(["active", "retired"]);
		// A retirement names the Rail even though its event carries only the digest.
		expect(after[1]?.railId).toBe("rail-1");
	});

	it("stops when aborted", async () => {
		const store = fakeStore();
		store.push("s", RAIL_EVENT_TYPES.approved, { rail: rail(DIGEST_A) });
		const abort = new AbortController();
		abort.abort();
		const read = createJournalRailEventReader({ store });
		expect(await collect(read(undefined, abort.signal))).toEqual([]);
	});
});

describe("RailDeliveryReader", () => {
	const noBinding: CampPolicy = {
		binding: async () => undefined,
		bind: async () => {
			throw new Error("unused");
		},
		restore: async () => {
			throw new Error("unused");
		},
	};

	it("parses the opaque delivery object as RailDeliveryRecord (parse, don't validate)", () => {
		const parsed = parseRailDelivery(DIGEST_A, {
			campSets: ["prod"],
			failover: { automatic: true, maxConcurrent: 1 },
			maxFanoutCamps: 400,
		});
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.value.railDigest).toBe(DIGEST_A);
			expect(parsed.value.failover?.automatic).toBe(true);
			expect(parsed.value.maxFanoutCamps).toBe(400);
		}
	});

	it("refuses an unparsable delivery object with rail-delivery-invalid", () => {
		const parsed = parseRailDelivery(DIGEST_A, { campSets: "prod", bogus: 1 });
		expect(parsed.ok).toBe(false);
		if (!parsed.ok)
			expect(parsed.reasons[0]?.code).toBe("rail-delivery-invalid");
	});

	it("an invalid delivery object binds nothing and is counted, never silent", async () => {
		const sink = recordingSink();
		const reader = createRailDeliveryReader({
			catalog: staticCatalog([
				{
					railId: "r",
					railDigest: DIGEST_A,
					stationId: "st1",
					status: "active",
					delivery: { campSets: 7 },
				},
			]),
			campPolicy: noBinding,
			topology: fakeTopology([camp("c1")]),
			telemetry: sink,
			now: () => 5,
		});
		const record = await reader.forStation("st1");
		expect(record?.campSets).toEqual([]);
		expect(record?.failover?.automatic ?? false).toBe(false);
		await Promise.resolve();
		expect(sink.points.map((p) => p.name)).toContain(
			RAIL_READER_METRICS.deliveryInvalid,
		);
	});

	it("an unbound Camp uses its Station's active Rail (D24: behavior unchanged)", async () => {
		const reader = createRailDeliveryReader({
			catalog: staticCatalog([
				{
					railId: "r",
					railDigest: DIGEST_A,
					stationId: "st1",
					status: "active",
					delivery: { campSets: ["a"] },
				},
			]),
			campPolicy: noBinding,
			topology: fakeTopology([camp("c1")]),
			now: () => 5,
		});
		expect((await reader.forCamp(asCamp("c1")))?.campSets).toEqual(["a"]);
		expect(await reader.forCamp(asCamp("missing"))).toBeUndefined();
	});

	it("an enforced Rail unknown to the journal binds nothing; it never falls back to the Station Rail", async () => {
		const reader = createRailDeliveryReader({
			catalog: staticCatalog([
				{
					railId: "r",
					railDigest: DIGEST_A,
					stationId: "st1",
					status: "active",
					delivery: { campSets: ["a"] },
				},
			]),
			campPolicy: {
				...noBinding,
				binding: async () => ({ enforcedRailDigest: DIGEST_B }) as never,
			},
			topology: fakeTopology([camp("c1")]),
			now: () => 5,
		});
		const record = await reader.forCamp(asCamp("c1"));
		expect(record?.railDigest).toBe(DIGEST_B);
		expect(record?.campSets).toEqual([]);
	});
});
