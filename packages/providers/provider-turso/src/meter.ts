/**
 * Request and rows metering for the libSQL binding.
 *
 * `meterLibsqlClient` wraps the client and counts what is actually sent: one
 * request per `execute` or `batch` call, including the schema creation a
 * fresh database needs once. That is the figure the conformance suite checks
 * against `LIBSQL_EPHEMERAL_COST`. Rows cannot be counted at the client — the
 * libSQL protocol does not return rows read or written — so the binding
 * reports its own upper-bound estimate per call through `onRows`, and
 * `createLibsqlUsageMeter` sums both. Only operation names and counts reach a
 * meter; keys, values and SQL never do.
 */
import type { LibsqlCell } from "./cells.js";
import type { LibsqlRowsCharge } from "./cost.js";

/** The part of `@libsql/client`'s `Client` the binding uses. */
export type LibsqlStatementClient = {
	execute(statement: {
		readonly sql: string;
		args: (string | bigint | Uint8Array | null)[];
	}): Promise<LibsqlResult>;
	batch(
		statements: {
			readonly sql: string;
			args: (string | bigint | Uint8Array | null)[];
		}[],
		mode: "write" | "read" | "deferred",
	): Promise<readonly LibsqlResult[]>;
};

/** The part of `@libsql/client`'s `ResultSet` the binding reads. */
export type LibsqlResult = {
	readonly rows: ArrayLike<ArrayLike<LibsqlCell>>;
};

// domain-view: number-valued view of the generated LibsqlUsage (whose int64 fields are bigint on the wire).
export type LibsqlUsageSnapshot = {
	readonly requests: number;
	readonly requestsByKind: Readonly<Record<string, number>>;
	readonly rowsRead: number;
	readonly rowsWritten: number;
};

export type MeteredLibsqlClient = LibsqlStatementClient & {
	requests(): {
		readonly total: number;
		readonly byKind: Readonly<Record<string, number>>;
	};
	reset(): void;
};

export function meterLibsqlClient(
	inner: LibsqlStatementClient,
	options: { readonly onRequest?: (kind: "execute" | "batch") => void } = {},
): MeteredLibsqlClient {
	let execute = 0;
	let batch = 0;
	return {
		execute(statement) {
			execute += 1;
			options.onRequest?.("execute");
			return inner.execute(statement);
		},
		batch(statements, mode) {
			batch += 1;
			options.onRequest?.("batch");
			return inner.batch(statements, mode);
		},
		requests() {
			return { total: execute + batch, byKind: { execute, batch } };
		},
		reset() {
			execute = 0;
			batch = 0;
		},
	};
}

export type LibsqlUsageMeter = {
	/** Pass as the binding's `onRows`. */
	readonly onRows: (charge: LibsqlRowsCharge) => void;
	/** Pass as `meterLibsqlClient`'s `onRequest`. */
	readonly onRequest: (kind: "execute" | "batch") => void;
	usage(): LibsqlUsageSnapshot;
	reset(): void;
};

export function createLibsqlUsageMeter(): LibsqlUsageMeter {
	let requests = new Map<string, number>();
	let rowsRead = 0;
	let rowsWritten = 0;
	return {
		onRows(charge) {
			rowsRead += charge.rowsRead;
			rowsWritten += charge.rowsWritten;
		},
		onRequest(kind) {
			requests.set(kind, (requests.get(kind) ?? 0) + 1);
		},
		usage() {
			let total = 0;
			for (const count of requests.values()) total += count;
			return {
				requests: total,
				requestsByKind: Object.fromEntries(requests),
				rowsRead,
				rowsWritten,
			};
		},
		reset() {
			requests = new Map();
			rowsRead = 0;
			rowsWritten = 0;
		},
	};
}
