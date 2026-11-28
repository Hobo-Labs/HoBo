import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import {
	createNodeSqliteDriver,
	createSqliteDomainPlatform,
	initSqliteDomainTables,
} from "../src/index.js";

const CounterId = Schema.String.pipe(Schema.brand("CounterId"));

class Incremented extends Domain.Event("Incremented", {
	delta: Schema.Int,
}) {}

class IncrementCounter extends Domain.Command("IncrementCounter", {
	target: CounterId,
	input: {
		delta: Schema.Int,
	},
	events: [Incremented],
	rejects: [],
}) {}

class CounterAggregate extends Domain.Aggregate("CounterAggregate", {
	id: CounterId,
	state: Schema.Struct({ total: Schema.Int }),
	initial: { total: 0 },
	commands: [IncrementCounter],
	decide: {
		IncrementCounter: (_state, cmd) => [new Incremented({ delta: cmd.delta })],
	},
	evolve: {
		Incremented: (state, event) => ({ total: state.total + event.delta }),
	},
}) {}

class CounterSummaryView extends Domain.View("CounterSummaryView", {
	from: [CounterAggregate],
	key: CounterAggregate,
	state: Schema.Struct({
		total: Schema.Int,
		updates: Schema.Int,
	}),
	initial: { total: 0, updates: 0 },
	evolve: {
		Incremented: (state, event) => ({
			total: state.total + event.delta,
			updates: state.updates + 1,
		}),
	},
}) {}

class CounterDomain extends Domain.Model("CounterDomain", {
	aggregates: [CounterAggregate],
	views: [CounterSummaryView],
}) {}

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

describe("@hobo/storage-sqlite createSqliteDomainPlatform", () => {
	it("persists aggregate state, materialized views, and idempotent command receipts across full SQLite restarts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sqlite-domain-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "domain.sqlite");
		const counterId = CounterId.make("station-counter-1");

		const firstDriver = createNodeSqliteDriver({ path: dbPath });
		try {
			const firstLayer = CounterDomain.layer(Layer.empty).pipe(
				Layer.provide(createSqliteDomainPlatform(firstDriver)),
			);
			const firstReceipt = await Effect.runPromise(
				Effect.gen(function* () {
					const counters = yield* CounterAggregate;
					const views = yield* CounterSummaryView;
					const r1 = yield* counters.send(
						counterId,
						new IncrementCounter({ delta: 5 }),
						{ commandId: "cmd-1" },
					);
					const r2 = yield* counters.send(
						counterId,
						new IncrementCounter({ delta: 7 }),
						{ commandId: "cmd-2" },
					);
					const snapshot = Option.getOrThrow(yield* views.get(counterId));
					return { r1, r2, snapshot };
				}).pipe(Effect.provide(firstLayer)),
			);
			expect(firstReceipt.r1.version).toBe(1);
			expect(firstReceipt.r2.version).toBe(2);
			expect(firstReceipt.snapshot).toEqual({ total: 12, updates: 2 });
		} finally {
			firstDriver.close();
		}

		const reopenedDriver = createNodeSqliteDriver({ path: dbPath });
		try {
			const reopenedLayer = CounterDomain.layer(Layer.empty).pipe(
				Layer.provide(createSqliteDomainPlatform(reopenedDriver)),
			);
			const afterRestart = await Effect.runPromise(
				Effect.gen(function* () {
					const counters = yield* CounterAggregate;
					const views = yield* CounterSummaryView;
					const duplicate = yield* counters.send(
						counterId,
						new IncrementCounter({ delta: 7 }),
						{ commandId: "cmd-2" },
					);
					const r3 = yield* counters.send(
						counterId,
						new IncrementCounter({ delta: 3 }),
						{ commandId: "cmd-3" },
					);
					const snapshot = Option.getOrThrow(yield* views.get(counterId));
					return { duplicate, r3, snapshot };
				}).pipe(Effect.provide(reopenedLayer)),
			);
			expect(afterRestart.duplicate.version).toBe(2);
			expect(afterRestart.r3.version).toBe(3);
			expect(afterRestart.snapshot).toEqual({ total: 15, updates: 3 });
		} finally {
			reopenedDriver.close();
		}
	});

	it("drains pending outbox rows when aggregate store boots", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sqlite-domain-outbox-drain-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "domain.sqlite");
		const counterId = CounterId.make("station-counter-outbox-drain");
		const driver = createNodeSqliteDriver({ path: dbPath });
		try {
			initSqliteDomainTables(driver);
			driver
				.prepare(
					"INSERT INTO domain_outbox (model_name, delivery_json) VALUES (?, ?)",
				)
				.run(
					"CounterDomain",
					JSON.stringify({
						target: { kind: "view", name: "CounterSummaryView" },
						key: counterId,
						source: `CounterAggregate/${counterId}`,
						seq: 1,
						origin: "CounterAggregate",
						tag: "Incremented",
						event: { _tag: "Incremented", delta: 3 },
						envelope: {
							id: `CounterAggregate/${counterId}/1`,
							stream: `CounterAggregate/${counterId}`,
							seq: 1,
							commandId: "cmd-drain-boot",
							at: Date.now(),
						},
					}),
				);
			driver
				.prepare(
					"INSERT INTO domain_aggregates (model_name, aggregate_name, instance_id, state_json, version) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					"CounterDomain",
					"CounterAggregate",
					counterId,
					JSON.stringify({ total: 3 }),
					1,
				);
			const layer = CounterDomain.layer(Layer.empty).pipe(
				Layer.provide(createSqliteDomainPlatform(driver)),
			);
			const snapshot = await Effect.runPromise(
				Effect.gen(function* () {
					const counters = yield* CounterAggregate;
					const views = yield* CounterSummaryView;
					yield* counters.send(counterId, new IncrementCounter({ delta: 0 }), {
						commandId: "drain-boot-touch",
					});
					return Option.getOrThrow(yield* views.get(counterId));
				}).pipe(Effect.provide(layer)),
			);
			expect(snapshot).toEqual({ total: 3, updates: 2 });
			const remaining = driver
				.prepare("SELECT COUNT(*) AS n FROM domain_outbox WHERE model_name = ?")
				.get("CounterDomain");
			expect(Number(remaining?.n)).toBe(0);
		} finally {
			driver.close();
		}
	});

	it("clears transactional outbox rows after aggregate commits deliver view updates", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sqlite-domain-outbox-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "domain.sqlite");
		const counterId = CounterId.make("station-counter-outbox");
		const driver = createNodeSqliteDriver({ path: dbPath });
		try {
			const layer = CounterDomain.layer(Layer.empty).pipe(
				Layer.provide(createSqliteDomainPlatform(driver)),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const counters = yield* CounterAggregate;
					yield* counters.send(counterId, new IncrementCounter({ delta: 2 }), {
						commandId: "cmd-outbox-1",
					});
				}).pipe(Effect.provide(layer)),
			);
			const remaining = driver
				.prepare("SELECT COUNT(*) AS n FROM domain_outbox WHERE model_name = ?")
				.get("CounterDomain");
			expect(remaining).toBeDefined();
			expect(Number(remaining?.n)).toBe(0);
		} finally {
			driver.close();
		}
	});

	it("re-arms persisted schedules after SQLite restart", async () => {
		const dir = mkdtempSync(
			join(tmpdir(), "hobo-sqlite-domain-schedule-rearm-"),
		);
		tempDirs.push(dir);
		const dbPath = join(dir, "domain.sqlite");
		const counterId = CounterId.make("station-counter-schedule-rearm");

		const firstDriver = createNodeSqliteDriver({ path: dbPath });
		try {
			const firstLayer = CounterDomain.layer(Layer.empty).pipe(
				Layer.provide(createSqliteDomainPlatform(firstDriver)),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const counters = yield* CounterAggregate;
					yield* counters.schedule(
						counterId,
						new IncrementCounter({ delta: 9 }),
						{ commandId: "rearm-tick", after: "300 millis" },
					);
				}).pipe(Effect.provide(firstLayer)),
			);
		} finally {
			firstDriver.close();
		}

		const reopenedDriver = createNodeSqliteDriver({ path: dbPath });
		try {
			const reopenedLayer = CounterDomain.layer(Layer.empty).pipe(
				Layer.provide(createSqliteDomainPlatform(reopenedDriver)),
			);
			const snapshot = await Effect.runPromise(
				Effect.gen(function* () {
					yield* Effect.sleep("500 millis");
					const views = yield* CounterSummaryView;
					return Option.getOrThrow(yield* views.get(counterId));
				}).pipe(Effect.provide(reopenedLayer)),
			);
			expect(snapshot).toEqual({ total: 9, updates: 1 });
		} finally {
			reopenedDriver.close();
		}
	});

	it("persists scheduled commands across SQLite restarts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sqlite-domain-schedule-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "domain.sqlite");
		const counterId = CounterId.make("station-counter-schedule");
		const driver = createNodeSqliteDriver({ path: dbPath });
		try {
			const layer = CounterDomain.layer(Layer.empty).pipe(
				Layer.provide(createSqliteDomainPlatform(driver)),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const counters = yield* CounterAggregate;
					yield* counters.schedule(
						counterId,
						new IncrementCounter({ delta: 1 }),
						{ commandId: "tick", after: "60 seconds" },
					);
				}).pipe(Effect.provide(layer)),
			);
		} finally {
			driver.close();
		}

		const reopened = createNodeSqliteDriver({ path: dbPath });
		try {
			const row = reopened
				.prepare(
					"SELECT schedule_name, cancelled FROM domain_schedules WHERE instance_id = ?",
				)
				.get(counterId);
			expect(row).toBeDefined();
			expect(row?.schedule_name).toBe("tick");
			expect(Number(row?.cancelled)).toBe(0);
		} finally {
			reopened.close();
		}
	});

	it("delivers multi-aggregate policy chains without re-entrant outbox or aggregate lock deadlocks", async () => {
		const MirrorId = Schema.String.pipe(Schema.brand("MirrorId"));

		class MirrorRecorded extends Domain.Event("MirrorRecorded", {
			sourceId: CounterId,
			delta: Schema.Int,
		}) {}

		class RecordMirror extends Domain.Command("RecordMirror", {
			target: MirrorId,
			input: {
				sourceId: CounterId,
				delta: Schema.Int,
			},
			events: [MirrorRecorded],
			rejects: [],
		}) {}

		class MirrorAggregate extends Domain.Aggregate("MirrorAggregate", {
			id: MirrorId,
			state: Schema.Struct({ mirrored: Schema.Int }),
			initial: { mirrored: 0 },
			commands: [RecordMirror],
			decide: {
				RecordMirror: (_state, cmd) => [
					new MirrorRecorded({ sourceId: cmd.sourceId, delta: cmd.delta }),
				],
			},
			evolve: {
				MirrorRecorded: (state, event) => ({
					mirrored: state.mirrored + event.delta,
				}),
			},
		}) {}

		class MirrorView extends Domain.View("MirrorView", {
			from: [MirrorAggregate],
			key: MirrorAggregate,
			state: Schema.Struct({ mirrored: Schema.Int }),
			initial: { mirrored: 0 },
			evolve: {
				MirrorRecorded: (state, event) => ({
					mirrored: state.mirrored + event.delta,
				}),
			},
		}) {}

		class ForwardToMirrorPolicy extends Domain.Policy("ForwardToMirrorPolicy", {
			from: CounterAggregate,
			on: [Incremented],
		}) {}

		class EchoBackPolicy extends Domain.Policy("EchoBackPolicy", {
			from: MirrorAggregate,
			on: [MirrorRecorded],
		}) {}

		class ChainedDomain extends Domain.Model("ChainedDomain", {
			aggregates: [CounterAggregate, MirrorAggregate],
			views: [CounterSummaryView, MirrorView],
			policies: [ForwardToMirrorPolicy, EchoBackPolicy],
		}) {}

		const ForwardToMirrorPolicyLive = ForwardToMirrorPolicy.toLayer(
			Effect.gen(function* () {
				const mirrors = yield* MirrorAggregate;
				return Effect.fn(function* ({ source, event }) {
					if (event.delta <= 0) return;
					yield* mirrors
						.send(
							MirrorId.make(`mirror-${source.id}`),
							new RecordMirror({ sourceId: source.id, delta: event.delta }),
						)
						.pipe(Effect.asVoid);
				});
			}),
		);

		const EchoBackPolicyLive = EchoBackPolicy.toLayer(
			Effect.gen(function* () {
				const counters = yield* CounterAggregate;
				return Effect.fn(function* ({ event }) {
					yield* counters
						.send(event.sourceId, new IncrementCounter({ delta: 0 }))
						.pipe(Effect.asVoid);
				});
			}),
		);

		const dir = mkdtempSync(join(tmpdir(), "hobo-sqlite-domain-policy-chain-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "chained.sqlite");
		const counterId = CounterId.make("counter-chain-1");
		const mirrorId = MirrorId.make(`mirror-${counterId}`);
		const driver = createNodeSqliteDriver({ path: dbPath });
		try {
			const layer = ChainedDomain.layer(
				Layer.mergeAll(ForwardToMirrorPolicyLive, EchoBackPolicyLive),
			).pipe(Layer.provide(createSqliteDomainPlatform(driver)));

			const snapshots = await Effect.runPromise(
				Effect.gen(function* () {
					const counters = yield* CounterAggregate;
					const counterViews = yield* CounterSummaryView;
					const mirrorViews = yield* MirrorView;
					yield* counters.send(counterId, new IncrementCounter({ delta: 4 }), {
						commandId: "cmd-chain-1",
					});
					const counterSnapshot = Option.getOrThrow(
						yield* counterViews.get(counterId),
					);
					const mirrorSnapshot = Option.getOrThrow(
						yield* mirrorViews.get(mirrorId),
					);
					return { counterSnapshot, mirrorSnapshot };
				}).pipe(Effect.provide(layer)),
			);

			expect(snapshots.counterSnapshot).toEqual({ total: 4, updates: 2 });
			expect(snapshots.mirrorSnapshot).toEqual({ mirrored: 4 });
			const remaining = driver
				.prepare("SELECT COUNT(*) AS n FROM domain_outbox WHERE model_name = ?")
				.get("ChainedDomain");
			expect(Number(remaining?.n)).toBe(0);
		} finally {
			driver.close();
		}
	});
});
