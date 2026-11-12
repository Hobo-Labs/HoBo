/**
 * `EphemeralStatePort` over libSQL — Turso, a self-hosted `sqld`, or a local
 * `file:` database — with the same semantics as the Redis-protocol binding in
 * `@hobo/kv-redis-compatible`, checked by the same conformance suite.
 *
 * Storage: one table (`statements.ts`), one row per key holding the value,
 * an incarnation chosen by the writer that created the key, a revision, and
 * an absolute expiry. The version a caller sees is `<incarnation>:<revision>`,
 * so a version from a deleted or expired incarnation never matches the
 * recreated key (no ABA). Reads treat an expired row as absent; expired rows
 * are deleted lazily — replaced in place by the next `putIfAbsent` or
 * `increment` of the key, removed by an unconditional `delete`, and swept by a
 * bounded purge that rides along with a write at most once per interval.
 *
 * Every port call is one request (one `execute`, or one `batch` when a purge
 * or a large `getMany` rides along) and at most one row read and written per
 * key: see `LIBSQL_EPHEMERAL_COST`.
 *
 * Errors use `KvRedisCompatibleError` with the same codes as the Redis
 * binding, so a host handles every cache binding's rejections alike: a
 * rejected increment is `EPHEMERAL_BACKEND_REJECTED`, a reply the statements
 * never produce is `EPHEMERAL_BACKEND_CONTRACT`. Transport failures from the
 * client are thrown as the client threw them.
 */
import {
	type EphemeralEntry,
	type EphemeralKey,
	type EphemeralStatePort,
	type EphemeralTtlMs,
	type EphemeralVersion,
	type EphemeralWrite,
	type IncrementTtlMode,
	parseEphemeralVersion,
	parseIncrementBy,
} from "@hobo/core";
import { KvRedisCompatibleError } from "@hobo/kv-redis-compatible";

import {
	isCellBigInt,
	isCellBytes,
	isCellNumber,
	isCellText,
	type LibsqlCell,
} from "./cells.js";
import type { LibsqlRowsCharge } from "./cost.js";
import type { LibsqlResult, LibsqlStatementClient } from "./meter.js";
import {
	DEFAULT_LIBSQL_EPHEMERAL_TABLE,
	LIBSQL_GET_MANY_CHUNK,
	type LibsqlStatement,
	libsqlStatements,
} from "./statements.js";

export type LibsqlPurgeOptions = {
	/** Least time between purges by one client. Default one minute. */
	readonly everyMs?: number;
	/** Most expired rows one purge deletes. Default 64. */
	readonly limit?: number;
};

export type LibsqlEphemeralStateOptions = {
	readonly client: LibsqlStatementClient;
	/** Default `hobo_ephemeral_state`. Created on first use if missing. */
	readonly table?: string;
	/**
	 * Milliseconds since the Unix epoch. Omit to use the database's clock, so
	 * every client agrees on expiry. Inject only for deterministic tests.
	 */
	readonly now?: () => number;
	/** Incarnation for a key a call creates; must not repeat. Default a random UUID. */
	readonly newIncarnation?: () => string;
	/** `false` turns the opportunistic purge off. */
	readonly purge?: LibsqlPurgeOptions | false;
	/** Called once per call with the binding's upper-bound rows estimate. */
	readonly onRows?: (charge: LibsqlRowsCharge) => void;
};

const contract = (message: string) =>
	new KvRedisCompatibleError("EPHEMERAL_BACKEND_CONTRACT", message);

const INCARNATION = /^[\x21-\x39\x3b-\x7e]{1,64}$/u; // printable ASCII without ':'

function parseIncarnation(value: string): string {
	if (!INCARNATION.test(value)) {
		throw new RangeError(
			"an incarnation must be 1..64 printable ASCII characters without ':'",
		);
	}
	return value;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type Cell = LibsqlCell | undefined;

function text(cell: Cell, operation: string): string {
	if (!isCellText(cell)) {
		throw contract(`ephemeral ${operation} expected a text column`);
	}
	return cell;
}

/** A stored value: UTF-8 bytes from `putIfAbsent`/`compareAndSet`, or a counter's decimal text. */
function value(cell: Cell, operation: string): string {
	if (isCellText(cell)) return cell;
	if (isCellBytes(cell)) {
		try {
			return decoder.decode(cell);
		} catch {
			throw contract(`ephemeral ${operation} read a value that is not UTF-8`);
		}
	}
	throw contract(`ephemeral ${operation} expected a stored value`);
}

function revision(cell: Cell, operation: string): number {
	const parsed = isCellNumber(cell)
		? cell
		: isCellBigInt(cell)
			? Number(cell)
			: Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw contract(`ephemeral ${operation} expected a positive revision`);
	}
	return parsed;
}

function versionOf(
	incarnation: Cell,
	rev: Cell,
	operation: string,
): EphemeralVersion {
	return parseEphemeralVersion(
		`${text(incarnation, operation)}:${revision(rev, operation)}`,
	);
}

function firstRow(
	result: LibsqlResult | undefined,
	operation: string,
): ArrayLike<LibsqlCell> | undefined {
	if (result === undefined)
		throw contract(`ephemeral ${operation} got no result`);
	if (result.rows.length > 1) {
		throw contract(`ephemeral ${operation} returned more than one row`);
	}
	return result.rows[0];
}

const isMissingTable = (error: Error | undefined): boolean =>
	error !== undefined && /no such table/iu.test(error.message);

export function createLibsqlEphemeralState(
	options: LibsqlEphemeralStateOptions,
): EphemeralStatePort {
	const { client } = options;
	const sql = libsqlStatements(options.table ?? DEFAULT_LIBSQL_EPHEMERAL_TABLE);
	const newIncarnation = () =>
		parseIncarnation(
			options.newIncarnation?.() ?? globalThis.crypto.randomUUID(),
		);
	const clock = options.now;
	const nowArg = (): bigint | null =>
		clock === undefined ? null : BigInt(Math.floor(clock()));
	const purge =
		options.purge === false
			? undefined
			: {
					everyMs: options.purge?.everyMs ?? 60_000,
					limit: BigInt(options.purge?.limit ?? 64),
				};
	let lastPurgeMs = Number.NEGATIVE_INFINITY;
	const charge = (
		operation: LibsqlRowsCharge["operation"],
		rowsRead: number,
		rowsWritten: number,
	) => options.onRows?.({ operation, rowsRead, rowsWritten });

	/** Create the table once, on the first statement that finds it missing. */
	async function withSchema<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (!isMissingTable(error instanceof Error ? error : undefined))
				throw error;
			await client.batch(
				sql.schema.map((statement) => ({ sql: statement, args: [] })),
				"write",
			);
			return run();
		}
	}

	/** One request: the statement alone, or with a purge in one write transaction. */
	async function write(
		statement: LibsqlStatement,
	): Promise<LibsqlResult | undefined> {
		const wallMs = clock?.() ?? Date.now();
		if (purge === undefined || wallMs - lastPurgeMs < purge.everyMs) {
			return withSchema(() => client.execute(statement));
		}
		lastPurgeMs = wallMs;
		const [result, purged] = await withSchema(() =>
			client.batch([statement, sql.purge(purge.limit, nowArg())], "write"),
		);
		const removed = purged?.rows.length ?? 0;
		charge("purge", removed * 2 + 1, removed);
		return result;
	}

	const read = (statement: LibsqlStatement) =>
		withSchema(() => client.execute(statement));

	return {
		async get(key: EphemeralKey) {
			const row = firstRow(await read(sql.get(key, nowArg())), "get");
			charge("get", 1, 0);
			if (row === undefined) return undefined;
			return {
				value: value(row[0], "get"),
				version: versionOf(row[1], row[2], "get"),
			};
		},

		async getMany(keys: readonly EphemeralKey[]) {
			if (keys.length === 0) return [];
			const unique = [...new Set(keys)];
			const chunks: string[][] = [];
			for (let at = 0; at < unique.length; at += LIBSQL_GET_MANY_CHUNK) {
				chunks.push(unique.slice(at, at + LIBSQL_GET_MANY_CHUNK));
			}
			const nowMs = nowArg();
			const statements = chunks.map((chunk) => sql.getMany(chunk, nowMs));
			const results: readonly LibsqlResult[] =
				statements.length === 1 && statements[0] !== undefined
					? [await read(statements[0])]
					: await withSchema(() => client.batch(statements, "deferred"));
			const found = new Map<string, EphemeralEntry>();
			for (const result of results) {
				for (const row of Array.from(result.rows)) {
					found.set(text(row[0], "getMany"), {
						value: value(row[1], "getMany"),
						version: versionOf(row[2], row[3], "getMany"),
					});
				}
			}
			charge("getMany", unique.length, 0);
			return keys.map((key) => found.get(key));
		},

		async putIfAbsent(
			key: EphemeralKey,
			stored: string,
			ttlMs: EphemeralTtlMs,
		) {
			const row = firstRow(
				await write(
					sql.putIfAbsent(
						key,
						encoder.encode(stored),
						newIncarnation(),
						BigInt(ttlMs),
						nowArg(),
					),
				),
				"putIfAbsent",
			);
			charge("putIfAbsent", 1, row === undefined ? 0 : 1);
			return row === undefined
				? ({ applied: false } satisfies EphemeralWrite)
				: ({
						applied: true,
						version: versionOf(row[0], row[1], "putIfAbsent"),
					} satisfies EphemeralWrite);
		},

		async compareAndSet(
			key: EphemeralKey,
			expected: EphemeralVersion,
			stored: string,
			ttlMs: EphemeralTtlMs,
		) {
			const row = firstRow(
				await write(
					sql.compareAndSet(
						key,
						expected,
						encoder.encode(stored),
						BigInt(ttlMs),
						nowArg(),
					),
				),
				"compareAndSet",
			);
			charge("compareAndSet", 1, row === undefined ? 0 : 1);
			return row === undefined
				? ({ applied: false } satisfies EphemeralWrite)
				: ({
						applied: true,
						version: versionOf(row[0], row[1], "compareAndSet"),
					} satisfies EphemeralWrite);
		},

		async delete(key: EphemeralKey, expected?: EphemeralVersion) {
			const row = firstRow(
				await write(
					expected === undefined
						? sql.delete(key, nowArg())
						: sql.deleteIfVersion(key, expected, nowArg()),
				),
				"delete",
			);
			charge("delete", 1, row === undefined ? 0 : 1);
			if (row === undefined) return false;
			// Unconditional delete returns whether the removed row was live.
			return expected === undefined ? Number(row[0]) === 1 : true;
		},

		async increment(
			key: EphemeralKey,
			by: number,
			ttlMs: EphemeralTtlMs,
			mode: IncrementTtlMode = "on-create",
		) {
			const row = firstRow(
				await write(
					sql.increment(
						key,
						BigInt(parseIncrementBy(by)),
						newIncarnation(),
						BigInt(ttlMs),
						mode,
						nowArg(),
					),
				),
				"increment",
			);
			charge("increment", 1, row === undefined ? 0 : 1);
			if (row === undefined) {
				throw new KvRedisCompatibleError(
					"EPHEMERAL_BACKEND_REJECTED",
					"ephemeral increment was rejected by the store: the stored value is not an integer, or the sum leaves the safe integer range",
				);
			}
			const raw = value(row[0], "increment");
			const parsed = /^-?\d+$/u.test(raw) ? Number(raw) : Number.NaN;
			if (!Number.isSafeInteger(parsed)) {
				throw contract("ephemeral increment expected an integer result");
			}
			return parsed;
		},

		async expire(key: EphemeralKey, ttlMs: EphemeralTtlMs) {
			const row = firstRow(
				await write(sql.expire(key, BigInt(ttlMs), nowArg())),
				"expire",
			);
			charge("expire", 1, row === undefined ? 0 : 1);
			return row !== undefined;
		},
	};
}
