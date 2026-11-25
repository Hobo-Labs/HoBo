/**
 * Minimal SQLite driver surface shared by Node (`node:sqlite`) and browser
 * (SQLite WASM). Semantic logic never imports Node or browser APIs.
 */

import { isJsonBigInt, isJsonNumber, isJsonString } from "./json.js";

export type SqliteValue =
	| null
	| number
	| bigint
	| string
	| Uint8Array
	| boolean;

export interface SqliteRunResult {
	readonly changes: number;
	readonly lastInsertRowid: number | bigint;
}

export interface SqliteRow {
	readonly [key: string]: SqliteValue | undefined;
}

export interface SqliteStatement {
	run(...params: SqliteValue[]): SqliteRunResult;
	get(...params: SqliteValue[]): SqliteRow | undefined;
	all(...params: SqliteValue[]): SqliteRow[];
}

export interface SqliteDriver {
	readonly kind: "node" | "browser" | "memory" | "test";
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	/**
	 * Prefer BEGIN IMMEDIATE on native single-owner partitions.
	 * Browser VFS may map this to BEGIN.
	 */
	beginImmediate(): void;
	commit(): void;
	rollback(): void;
	pragma(name: string, value?: string | number): string | number | null;
	close(): void;
}

export function asBigInt<T>(value: T, field: string): bigint {
	if (isJsonBigInt(value)) return value;
	if (isJsonNumber(value) && Number.isSafeInteger(value)) {
		return BigInt(value);
	}
	if (isJsonString(value) && /^-?\d+$/.test(value)) {
		return BigInt(value);
	}
	throw new TypeError(`${field} must be integer/bigint`);
}

export function asNumber<T>(value: T, field: string): number {
	if (isJsonNumber(value) && Number.isFinite(value)) return value;
	if (isJsonBigInt(value)) {
		if (
			value > BigInt(Number.MAX_SAFE_INTEGER) ||
			value < BigInt(Number.MIN_SAFE_INTEGER)
		) {
			throw new TypeError(`${field} bigint out of safe number range`);
		}
		return Number(value);
	}
	if (isJsonString(value) && value !== "" && Number.isFinite(Number(value))) {
		return Number(value);
	}
	throw new TypeError(`${field} must be a number`);
}

export function asText<T>(value: T, field: string): string {
	if (isJsonString(value)) return value;
	throw new TypeError(`${field} must be a string`);
}

export function asNullableText<T>(value: T): string | null {
	if (value === null || value === undefined) return null;
	if (isJsonString(value)) return value;
	throw new TypeError("expected string or null");
}

export function asBytes<T>(value: T, field: string): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (isJsonString(value)) {
		return new TextEncoder().encode(value);
	}
	throw new TypeError(`${field} must be bytes`);
}
