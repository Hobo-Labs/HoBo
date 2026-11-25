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
} from "../src/index.js";

const CounterId = Schema.String.pipe(Schema.brand("CounterId"));
type CounterId = typeof CounterId.Type;

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

	it("fails closed when a second driver commits with a stale expected version", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sqlite-domain-race-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "domain.sqlite");
		const counterId = CounterId.make("race-counter-1");
		const modelName = "CounterDomain";
		const aggregateName = "CounterAggregate";

		const seedDriver = createNodeSqliteDriver({ path: dbPath });
		const layer = CounterDomain.layer(Layer.empty).pipe(
			Layer.provide(createSqliteDomainPlatform(seedDriver)),
		);
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const counters = yield* CounterAggregate;
					return yield* counters.send(
						counterId,
						new IncrementCounter({ delta: 4 }),
						{ commandId: "seed-cmd" },
					);
				}).pipe(Effect.provide(layer)),
			);
		} finally {
			seedDriver.close();
		}

		const winner = createNodeSqliteDriver({ path: dbPath });
		const loser = createNodeSqliteDriver({ path: dbPath });
		const casUpdateSql = `UPDATE domain_aggregates
       SET state_json = ?, version = ?
       WHERE model_name = ? AND aggregate_name = ? AND instance_id = ? AND version = ?`;
		const winnerCas = winner.prepare(casUpdateSql);
		const readVersion = (driver: typeof winner) =>
			Number(
				driver
					.prepare(
						`SELECT version FROM domain_aggregates
           WHERE model_name = ? AND aggregate_name = ? AND instance_id = ?`,
					)
					.get(modelName, aggregateName, counterId)?.version ?? -1,
			);

		try {
			winner.beginImmediate();
			const winnerUpdate = winnerCas.run(
				JSON.stringify({ total: 9 }),
				2,
				modelName,
				aggregateName,
				counterId,
				1,
			);
			expect(winnerUpdate.changes).toBe(1);
			winner.commit();
			winner.close();
			expect(readVersion(loser)).toBe(2);

			const loserCas = loser.prepare(casUpdateSql);
			loser.beginImmediate();
			const staleUpdate = loserCas.run(
				JSON.stringify({ total: 99 }),
				1,
				modelName,
				aggregateName,
				counterId,
				0,
			);
			expect(staleUpdate.changes).toBe(0);
			loser.rollback();
			expect(readVersion(loser)).toBe(2);

			const verifyDriver = createNodeSqliteDriver({ path: dbPath });
			try {
				const row = verifyDriver
					.prepare(
						`SELECT state_json, version FROM domain_aggregates
           WHERE model_name = ? AND aggregate_name = ? AND instance_id = ?`,
					)
					.get(modelName, aggregateName, counterId);
				expect(JSON.parse(String(row?.state_json))).toEqual({ total: 9 });
				expect(Number(row?.version)).toBe(2);
			} finally {
				verifyDriver.close();
			}
		} finally {
			loser.close();
		}
	});

});
