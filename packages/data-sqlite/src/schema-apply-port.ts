/**
 * Standalone schema-apply port over a SQLite file — the synchronous port the
 * Trails migration executor has always run on, now owned by the engine
 * package instead of the runbook engine (ADR-0177 decision 3).
 *
 * It opens the file and nothing else: no HoBo metadata tables are created in
 * a database that is only having its schema evolved.
 */
import { DatabaseSync } from "node:sqlite";
import {
	createSchemaPort,
	type SqliteSchemaHost,
	type SyncSchemaApplyPort,
} from "./engine.js";

export interface CreateSqliteSchemaApplyPortOptions {
	/** Store file path; `:memory:` is refused (snapshots need a file). */
	readonly path: string;
	readonly clock?: () => string;
}

export interface SqliteSchemaApplyPort extends SyncSchemaApplyPort {
	close(): void;
}

export function createSqliteSchemaApplyPort(
	options: CreateSqliteSchemaApplyPortOptions,
): SqliteSchemaApplyPort {
	if (options.path === ":memory:") {
		throw new Error(
			"schema apply requires a file-backed store: snapshots must survive the connection",
		);
	}
	const clock = options.clock ?? (() => new Date().toISOString());
	let db = new DatabaseSync(options.path);
	const host: SqliteSchemaHost = {
		path: options.path,
		connection: () => db,
		transaction<T>(body: () => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = body();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		reopen(replaceFile: () => void): void {
			db.close();
			replaceFile();
			db = new DatabaseSync(options.path);
		},
	};
	const port = createSchemaPort(host, clock);
	return {
		...port,
		close() {
			db.close();
		},
	};
}
