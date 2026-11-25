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
					yield* counters.send(
						counterId,
						new IncrementCounter({ delta: 2 }),
						{ commandId: "cmd-outbox-1" },
					);
				}).pipe(Effect.provide(layer)),
			);
			const remaining = driver
				.prepare(
					"SELECT COUNT(*) AS n FROM domain_outbox WHERE model_name = ?",
				)
				.get("CounterDomain");
			expect(remaining).toBeDefined();
			expect(Number(remaining?.n)).toBe(0);
		} finally {
			driver.close();
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
});
