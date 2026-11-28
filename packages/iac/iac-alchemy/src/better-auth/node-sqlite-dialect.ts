import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
	CompiledQuery,
	type DatabaseConnection,
	type DatabaseIntrospector,
	type Dialect,
	type DialectAdapter,
	type Driver,
	type Kysely,
	type QueryCompiler,
	type QueryResult,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";

const READ_QUERY_PATTERN = /^\s*(?:SELECT|PRAGMA|WITH|EXPLAIN)\b/iu;
const RETURNING_CLAUSE_PATTERN = /\bRETURNING\b/iu;

function toSqlInputValue(
	value: SQLInputValue | Date | boolean | undefined,
): SQLInputValue {
	if (value === undefined || value === null) return null;
	if (value === true) return 1;
	if (value === false) return 0;
	if (value instanceof Date) return value.toISOString();
	return value;
}

class NodeSqliteConnection implements DatabaseConnection {
	constructor(private readonly db: DatabaseSync) {}

	async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
		const stmt = this.db.prepare(compiledQuery.sql);
		const params: SQLInputValue[] = [];
		for (const raw of compiledQuery.parameters) {
			// SAFETY: Kysely CompiledQuery.parameters carries SQL primitive, Date, or boolean values at the driver boundary.
			params.push(
				toSqlInputValue(raw as SQLInputValue | Date | boolean | undefined),
			);
		}
		const returnsRows =
			READ_QUERY_PATTERN.test(compiledQuery.sql) ||
			RETURNING_CLAUSE_PATTERN.test(compiledQuery.sql);
		if (returnsRows) {
			// SAFETY: Kysely typed query result rows are decoded by Better Auth's adapter layer.
			const rows = stmt.all(...params) as R[];
			return { rows };
		}
		const outcome = stmt.run(...params);
		const numAffectedRows = BigInt(outcome.changes);
		const insertId =
			outcome.lastInsertRowid !== undefined
				? BigInt(outcome.lastInsertRowid)
				: undefined;
		return {
			rows: [],
			numAffectedRows,
			...(insertId !== undefined ? { insertId } : undefined),
		};
	}

	async *streamQuery<R>(
		compiledQuery: CompiledQuery,
	): AsyncIterableIterator<QueryResult<R>> {
		yield await this.executeQuery<R>(compiledQuery);
	}
}

class NodeSqliteDriver implements Driver {
	private db: DatabaseSync | undefined;
	private connection: NodeSqliteConnection | undefined;
	private lockChain: Promise<void> = Promise.resolve();

	constructor(private readonly filename: string) {}

	async init(): Promise<void> {
		if (this.db !== undefined) return;
		const db = new DatabaseSync(this.filename);
		db.exec("PRAGMA busy_timeout = 5000;");
		db.exec("PRAGMA foreign_keys = ON;");
		if (this.filename !== ":memory:") {
			db.exec("PRAGMA journal_mode = WAL;");
		}
		this.db = db;
		this.connection = new NodeSqliteConnection(db);
	}

	async acquireConnection(): Promise<DatabaseConnection> {
		if (this.connection === undefined) {
			await this.init();
		}
		const active = this.connection;
		if (active === undefined) {
			throw new Error("node:sqlite connection failed to initialize");
		}
		return active;
	}

	async beginTransaction(connection: DatabaseConnection): Promise<void> {
		await this.withLock(async () => {
			await connection.executeQuery(CompiledQuery.raw("BEGIN"));
		});
	}

	async commitTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw("COMMIT"));
	}

	async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
	}

	async releaseConnection(): Promise<void> {}

	async destroy(): Promise<void> {
		if (this.db !== undefined) {
			this.db.close();
			this.db = undefined;
			this.connection = undefined;
		}
	}

	private async withLock(operation: () => Promise<void>): Promise<void> {
		const previous = this.lockChain;
		let release: () => void = () => undefined;
		this.lockChain = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			await operation();
		} finally {
			release();
		}
	}
}

export class NodeSqliteDialect implements Dialect {
	constructor(private readonly filename: string) {}

	createAdapter(): DialectAdapter {
		return new SqliteAdapter();
	}

	createDriver(): Driver {
		return new NodeSqliteDriver(this.filename);
	}

	createIntrospector(db: Kysely<never>): DatabaseIntrospector {
		return new SqliteIntrospector(db);
	}

	createQueryCompiler(): QueryCompiler {
		return new SqliteQueryCompiler();
	}
}
