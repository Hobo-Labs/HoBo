/**
 * Open the CD journal (ADR-0182 D16, ADR-0135).
 *
 * - SQLite (default): one partition, one writer, behind `@hobo/storage-sqlite`.
 * - Postgres (>= 16): `@hobo/storage-postgres`, required for more than one
 *   replica or an agent fleet across Station processes.
 * - A Postgres fleet: the same store on a writer and standbys on other
 *   vendors, run by the journal's declared continuity (`cdJournalContinuity`
 *   in `@hobo/hobo-cd`, mapped by `continuityFleetPlan`). Opening runs one
 *   tick (it names the writer of an empty fleet and settles anything an
 *   interrupted run left); after that the store ticks itself on the plan's
 *   copy cadence until it is closed. Every replica may tick: each change is a
 *   compare-and-set on the register, so a second ticker loses and stops.
 *   Where the fleet cannot keep the policy (too few standbys, no quorum, one
 *   vendor) it says so once, on stderr, and serves.
 * - Memory: an in-memory SQLite journal (the same engine and semantics),
 *   reachable only with `--simulate`.
 *
 * `@hobo/cd` depends on no storage adapter; the host opens the store here.
 */

import type { CdStoreSelection } from "@hobo/cd/compose";
import type { DurableEventStore } from "@hobo/core";
import {
	createMemoryNodeSqliteDriver,
	createNodeSqliteDriver,
	SqliteJournal,
} from "@hobo/storage-sqlite";

export type CdFleetStatus = Readonly<{
	writer: string | undefined;
	shortfalls: readonly string[];
}>;

export type OpenedCdStore = Readonly<{
	store: DurableEventStore;
	backend: CdStoreSelection["backend"];
	/** A fleet's writer and what keeps it from its policy; absent off a fleet. */
	fleet?: () => CdFleetStatus;
	close(): Promise<void>;
}>;

export type CdStoreOpener = (
	selection: CdStoreSelection,
	clock: Readonly<{ now: () => number }>,
) => Promise<OpenedCdStore>;

function sqlite(
	driver: ReturnType<typeof createNodeSqliteDriver>,
	clock: Readonly<{ now: () => number }>,
): DurableEventStore {
	const journal = new SqliteJournal(driver, {
		clock: { now: () => new Date(clock.now()).toISOString() },
	});
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: SqliteJournal implements the DurableEventStore surface (storage-sqlite journal.ts) without declaring it.
	return journal as unknown as DurableEventStore;
}

function warn(
	event: string,
	detail: Readonly<Record<string, string | readonly string[]>>,
): void {
	process.stderr.write(
		`${JSON.stringify({ level: "warn", event, ...detail })}\n`,
	);
}

async function openFleet(
	selection: Extract<CdStoreSelection, { backend: "postgres-fleet" }>,
	clock: Readonly<{ now: () => number }>,
): Promise<OpenedCdStore> {
	const [
		{ createPostgresFleetEventStore },
		{ continuityFleetPlan, continuityShortfalls },
		{ cdJournalContinuity },
	] = await Promise.all([
		import("@hobo/storage-postgres"),
		import("@hobo/backend-fleet"),
		import("@hobo/hobo-cd"),
	]);
	const plan = continuityFleetPlan(cdJournalContinuity());
	const store = createPostgresFleetEventStore({
		members: selection.members.map((m) => ({
			id: m.id,
			connectionString: m.url,
		})),
		witnesses: selection.witnesses.map((m) => ({
			id: m.id,
			connectionString: m.url,
		})),
		plan,
		poolSize: selection.poolSize,
		statementTimeoutMs: selection.statementTimeoutMs,
		minServerMajorVersion: selection.minMajorVersion,
		applicationName: "hobo-cd",
		decidedBy: `hobo-cd:${process.pid}`,
		now: clock.now,
	});
	const shortfalls = continuityShortfalls(plan, {
		standbys: Math.max(0, selection.members.length - 1),
		tickEveryMs: plan.copyEveryMs,
		vendors: selection.members.length,
		witnesses: selection.witnesses.length,
	}).map((shortfall) => shortfall.message);
	if (shortfalls.length > 0)
		warn("hobo_cd_journal_continuity_short", { tier: plan.tier, shortfalls });
	await store.tick();
	let running = false;
	const timer = setInterval(() => {
		if (running) return;
		running = true;
		store
			.tick()
			.catch((error: Error) =>
				warn("hobo_cd_journal_fleet_tick_failed", { message: error.message }),
			)
			.finally(() => {
				running = false;
			});
	}, plan.copyEveryMs);
	timer.unref();
	return {
		store,
		backend: "postgres-fleet",
		fleet: () => ({ writer: store.writer(), shortfalls }),
		close: async () => {
			clearInterval(timer);
			await store.end();
		},
	};
}

export const openCdStore: CdStoreOpener = async (selection, clock) => {
	switch (selection.backend) {
		case "sqlite": {
			const driver = createNodeSqliteDriver({ path: selection.path });
			const store = sqlite(driver, clock);
			return {
				store,
				backend: "sqlite",
				close: async () => driver.close(),
			};
		}
		case "memory": {
			const driver = createMemoryNodeSqliteDriver();
			return {
				store: sqlite(driver, clock),
				backend: "memory",
				close: async () => driver.close(),
			};
		}
		case "postgres-fleet":
			return openFleet(selection, clock);
		case "postgres": {
			const { createPostgresEventStore } = await import(
				"@hobo/storage-postgres"
			);
			const store = createPostgresEventStore({
				config: {
					connectionString: selection.url,
					poolSize: selection.poolSize,
					statementTimeoutMs: selection.statementTimeoutMs,
					minServerMajorVersion: selection.minMajorVersion,
					applicationName: "hobo-cd",
				},
				clock: { now: () => new Date(clock.now()).toISOString() },
			});
			await store.ready();
			return {
				store,
				backend: "postgres",
				close: async () => {
					await store.end();
				},
			};
		}
	}
};
