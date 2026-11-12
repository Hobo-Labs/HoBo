/**
 * Open the CD journal (WP18, plan 0024, R6/D16, ADR-0135).
 *
 * - SQLite (default): one partition, one writer, behind `@hobo/storage-sqlite`.
 * - Postgres (>= 16): `@hobo/storage-postgres`, required for more than one
 *   replica or an agent fleet across Station processes.
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

export type OpenedCdStore = Readonly<{
	store: DurableEventStore;
	backend: CdStoreSelection["backend"];
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
	// SAFETY: SqliteJournal implements the DurableEventStore surface (storage-sqlite journal.ts).
	return journal as unknown as DurableEventStore;
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
		case "postgres": {
			// binds at merge (plan 0024): @hobo/storage-postgres is WP17.
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
