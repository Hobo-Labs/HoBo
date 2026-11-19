
// public-contract: per-operation libSQL cost the relay meters against Turso's rows allowance.
export const LIBSQL_EPHEMERAL_COST = Object.freeze({
	get: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 0 },
	getMany: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 0, perKey: true },
	putIfAbsent: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	compareAndSet: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	delete: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	increment: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	expire: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	"lock.acquire": { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	"lock.renew": { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	"lock.release": { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	"ring.append": { requests: 3, rowsReadMax: 3, rowsWrittenMax: 3 },
	"ring.read": { requests: 2, rowsReadMax: 1, rowsWrittenMax: 0, perKey: true },
} as const);

export type LibsqlEphemeralOperation = keyof typeof LIBSQL_EPHEMERAL_COST;

export type LibsqlRowsCharge = {
	readonly operation:
		| "get"
		| "getMany"
		| "putIfAbsent"
		| "compareAndSet"
		| "delete"
		| "increment"
		| "expire"
		| "purge";
	readonly rowsRead: number;
	readonly rowsWritten: number;
};

export const TURSO_FREE_ROWS_ALLOWANCE = Object.freeze({
	rowsReadPerMonth: 500_000_000,
	rowsWrittenPerMonth: 10_000_000,
} as const);
