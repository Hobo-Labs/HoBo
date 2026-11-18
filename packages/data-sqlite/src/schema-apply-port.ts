import { DatabaseSync } from "node:sqlite";
import {
	createSchemaPort,
	type SqliteSchemaHost,
	type SyncSchemaApplyPort,
} from "./engine.js";

export interface CreateSqliteSchemaApplyPortOptions {
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
