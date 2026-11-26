import pg from "pg";
import { expect, it } from "vitest";
import {
	createPostgresEventStore,
	remediationFor,
	STORAGE_POSTGRES_METRICS,
	type StoreMetricPoint,
} from "../src/index.js";
import { describeLive, liveStore, OPTS, POSTGRES_URL } from "./support/live.js";

function recordingSink() {
	const points: StoreMetricPoint[] = [];
	return {
		points,
		sink: {
			async metrics(batch: readonly StoreMetricPoint[]) {
				points.push(...batch);
			},
		},
	};
}

describeLive("operations: telemetry, health, timeouts", () => {
	it("emits commit, event, conflict, lease and checkpoint metrics through the TelemetrySink", async () => {
		const { points, sink } = recordingSink();
		const store = liveStore({ telemetry: sink });
		await store.append(
			"m",
			[
				{ type: "m.A", data: {} },
				{ type: "m.B", data: {} },
			],
			{ ...OPTS, expectedSeq: 0 },
		);
		await store
			.append("m", [{ type: "m.C", data: {} }], { ...OPTS, expectedSeq: 0 })
			.catch(() => undefined);
		const lease = await store.claimSubscription({
			subscriptionId: "s",
			partitionId: "p",
			holderId: "a",
		});
		await store
			.claimSubscription({
				subscriptionId: "s",
				partitionId: "p",
				holderId: "b",
			})
			.catch(() => undefined);
		await store.commitCheckpoint({
			subscriptionId: "s",
			partitionId: "p",
			position: 1n,
			fenceToken: lease.fenceToken,
		});
		await store.flushTelemetry();
		const named = (name: string) =>
			points.filter((point) => point.name === name);
		expect(named(STORAGE_POSTGRES_METRICS.migrationsApplied)).toHaveLength(1);
		expect(named(STORAGE_POSTGRES_METRICS.eventsAppended)[0]).toMatchObject({
			value: 2,
			kind: "counter",
		});
		expect(
			named(STORAGE_POSTGRES_METRICS.conflicts).map((p) => p.attributes.code),
		).toEqual(["OPTIMISTIC_SEQUENCE_CONFLICT", "SUBSCRIPTION_LEASE_CONFLICT"]);
		expect(
			named(STORAGE_POSTGRES_METRICS.leaseClaims).map(
				(p) => p.attributes.outcome,
			),
		).toEqual(["granted", "held"]);
		expect(
			named(STORAGE_POSTGRES_METRICS.checkpointCommits)[0]?.attributes.outcome,
		).toBe("advanced");
		const duration = named(STORAGE_POSTGRES_METRICS.commitDuration)[0];
		expect(duration).toMatchObject({
			kind: "histogram",
			unit: "ms",
			atMs: Date.parse("2026-11-12T00:00:00.000Z"),
		});
		expect(duration?.attributes).toMatchObject({
			"db.system": "postgresql",
			"hobo.storage.schema": store.schema,
		});
	});

	it("never fails an operation because the telemetry sink fails", async () => {
		const store = liveStore({
			telemetry: {
				metrics: async () => {
					throw new Error("collector down");
				},
			},
		});
		await expect(
			store.append("m", [{ type: "m.A", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			}),
		).resolves.toMatchObject({ lastPosition: 1n });
	});

	it("reports health with server and schema versions", async () => {
		const health = await liveStore().health();
		expect(health.ok).toBe(true);
		expect(health.checks.map((check) => check.name)).toEqual([
			"server-version",
			"schema-version",
		]);
	});

	it("turns a statement blocked past statement_timeout into a typed statement-timeout failure", async () => {
		const store = liveStore({ config: { statementTimeoutMs: 200 } });
		await store.append("locked", [{ type: "l.A", data: {} }], {
			...OPTS,
			expectedSeq: 0,
		});
		const blocker = new pg.Client({ connectionString: POSTGRES_URL });
		await blocker.connect();
		try {
			await blocker.query("BEGIN");
			await blocker.query(
				`SELECT 1 FROM "${store.schema}".streams WHERE stream_id = 'locked' FOR UPDATE`,
			);
			const error = await store
				.append("locked", [{ type: "l.B", data: {} }], {
					...OPTS,
					expectedSeq: 1,
				})
				.catch((caught) => caught);
			expect(error).toMatchObject({
				code: "PERSISTENCE_UNAVAILABLE",
				failure: "statement-timeout",
			});
			expect(error).toBeInstanceOf(Error);
			expect(
				error instanceof Error ? remediationFor(error) : undefined,
			).toContain("pg_stat_activity");
		} finally {
			await blocker.query("ROLLBACK");
			await blocker.end();
		}
		// The connection is reusable and the write succeeds once the lock is gone.
		await expect(
			store.append("locked", [{ type: "l.B", data: {} }], {
				...OPTS,
				expectedSeq: 1,
			}),
		).resolves.toMatchObject({ lastPosition: 2n });
	});

	it("refuses every operation after close", async () => {
		const store = createPostgresEventStore({
			config: { connectionString: POSTGRES_URL, schema: "hobo_t_closed" },
		});
		await store.end();
		await expect(
			store.append("x", [{ type: "x.Y" }], { ...OPTS, expectedSeq: 0 }),
		).rejects.toMatchObject({
			code: "PERSISTENCE_UNAVAILABLE",
			failure: "closed",
		});
	});
});
