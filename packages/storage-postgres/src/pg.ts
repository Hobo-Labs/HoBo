import pg from "pg";
import type { PostgresStoreConfig } from "./config.js";
import { isJsonNumber, isJsonString } from "./json.js";

/** One row as the driver returns it (int8 arrives as a decimal string). */
/** One cell: this store selects only text, int2/4/8 (int8 as text) and boolean columns. */
export type PgCell = string | number | boolean | null;

export type PgRow = Readonly<Record<string, PgCell>>;

export type PgParam = string | number | boolean | null | readonly string[];

/** The slice of a pooled `pg` client this store uses. */
export interface PgClientLike {
	query(
		text: string,
		values?: readonly PgParam[],
	): Promise<{
		rows: PgRow[];
		rowCount: number | null;
	}>;
	release(destroy?: boolean | Error): void;
}

/** The slice of a `pg.Pool` this store uses; inject one to share a pool. */
export interface PgPoolLike {
	connect(): Promise<PgClientLike>;
	end(): Promise<void>;
}

/** A dedicated (non-pooled) connection used for LISTEN. */
export interface PgListenerLike {
	connect(): Promise<void>;
	query(text: string): Promise<void>;
	onNotification(listener: (channel: string) => void): void;
	onError(listener: (error: Error) => void): void;
	end(): Promise<void>;
}

function connectionSettings(config: PostgresStoreConfig) {
	return {
		connectionString: config.connectionString,
		application_name: config.applicationName,
		statement_timeout: config.statementTimeoutMs,
		lock_timeout: config.statementTimeoutMs,
		idle_in_transaction_session_timeout: config.statementTimeoutMs * 2,
		connectionTimeoutMillis: config.connectionTimeoutMs,
	};
}

/** Pool with the store's bounded size and per-session timeouts. */
export function createPgPool(config: PostgresStoreConfig): PgPoolLike {
	const pool = new pg.Pool({
		...connectionSettings(config),
		max: config.poolSize,
	});
	// An idle client dropped by the server is reported on the next checkout,
	// not as an unhandled 'error' event that would crash the process.
	pool.on("error", () => {});
	return pool;
}

export function createPgListener(config: PostgresStoreConfig): PgListenerLike {
	const client = new pg.Client(connectionSettings(config));
	return Object.freeze({
		connect: () => client.connect(),
		async query(sql: string) {
			await client.query(sql);
		},
		onNotification(listener: (channel: string) => void) {
			client.on("notification", (message) => listener(message.channel));
		},
		onError(listener: (error: Error) => void) {
			client.on("error", listener);
		},
		end: () => client.end(),
	});
}

/** Parse an int8 column (decimal string or number) into a bigint. */
export function int8(row: PgRow, column: string): bigint {
	const value = row[column];
	if (isJsonString(value) && /^-?(0|[1-9][0-9]*)$/u.test(value)) {
		return BigInt(value);
	}
	if (isJsonNumber(value) && Number.isSafeInteger(value)) {
		return BigInt(value);
	}
	throw new TypeError(`column ${column} is not an int8: ${String(value)}`);
}

export function int4(row: PgRow, column: string): number {
	const value = row[column];
	if (isJsonNumber(value) && Number.isSafeInteger(value)) return value;
	if (isJsonString(value) && /^-?(0|[1-9][0-9]*)$/u.test(value)) {
		return Number(value);
	}
	throw new TypeError(`column ${column} is not an int4: ${String(value)}`);
}

export function text(row: PgRow, column: string): string {
	const value = row[column];
	if (!isJsonString(value)) {
		throw new TypeError(`column ${column} is not text: ${String(value)}`);
	}
	return value;
}

export function optionalText(row: PgRow, column: string): string | undefined {
	const value = row[column];
	if (value === null || value === undefined) return undefined;
	return text(row, column);
}
