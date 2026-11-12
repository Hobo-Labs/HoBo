import { EventStoreError, type EventStoreErrorCode } from "@hobo/core";
import { StoragePostgresErrorCode } from "./_generated/storage_postgres_pb.js";

/**
 * Failure classes this store adds to the core EventStore error vocabulary.
 * Each maps onto an existing `EventStoreErrorCode` so callers that switch on
 * `error.code` (reconcilers, runtimes) keep working; `failure` is the finer
 * label for operators and metrics, and `remediation` says what to do.
 */
export type StoragePostgresFailure =
	| "invalid-config"
	| "invalid-input"
	| "server-too-old"
	| "migration-drift"
	| "schema-ahead"
	| "unavailable"
	| "statement-timeout"
	| "lease-held"
	| "lease-not-held"
	| "closed";

const CODE_OF: Readonly<Record<StoragePostgresFailure, EventStoreErrorCode>> =
	Object.freeze({
		"invalid-config": "INVALID_INPUT",
		"invalid-input": "INVALID_INPUT",
		"server-too-old": "MIGRATION_FAILURE",
		"migration-drift": "MIGRATION_FAILURE",
		"schema-ahead": "UNSUPPORTED_SCHEMA_VERSION",
		unavailable: "PERSISTENCE_UNAVAILABLE",
		"statement-timeout": "PERSISTENCE_UNAVAILABLE",
		"lease-held": "SUBSCRIPTION_LEASE_CONFLICT",
		"lease-not-held": "SUBSCRIPTION_LEASE_CONFLICT",
		closed: "PERSISTENCE_UNAVAILABLE",
	});

const REMEDIATION_OF: Readonly<Record<StoragePostgresFailure, string>> =
	Object.freeze({
		"invalid-config":
			"Fix the named configuration field; see the defaults table in packages/storage-postgres/README.md.",
		"invalid-input":
			"Fix the caller: the named field is outside the EventStore limits (EVENTSTORE_LIMITS) or not a valid value.",
		"server-too-old":
			"Upgrade the server to PostgreSQL 16 or newer (plan 0024 R6), or point the store at a supported server.",
		"migration-drift":
			"An applied migration differs from the one this build ships. Restore the shipped migration or run the build that applied it; never edit applied migrations.",
		"schema-ahead":
			"The schema was migrated by a newer build. Roll this process forward to that build; do not run older code against a newer schema.",
		unavailable:
			"Check that the database is reachable (network, credentials, max_connections) and retry; the command was not committed.",
		"statement-timeout":
			"A statement exceeded statement_timeout. Look for long lock holders (pg_stat_activity) and retry; the command was not committed.",
		"lease-held":
			"Another holder owns this subscription lease. Wait for it to expire or be released, then claim again.",
		"lease-not-held":
			"This holder no longer owns the lease (another claimed it). Stop work immediately; do not retry with the old fence.",
		closed:
			"The store was closed. Create a new store; do not reuse a closed instance.",
	});

const WIRE_CODE_OF: Readonly<
	Record<StoragePostgresFailure, StoragePostgresErrorCode>
> = Object.freeze({
	"invalid-config": StoragePostgresErrorCode.INVALID_CONFIG,
	"invalid-input": StoragePostgresErrorCode.INVALID_INPUT,
	"server-too-old": StoragePostgresErrorCode.SERVER_TOO_OLD,
	"migration-drift": StoragePostgresErrorCode.MIGRATION_DRIFT,
	"schema-ahead": StoragePostgresErrorCode.SCHEMA_AHEAD,
	unavailable: StoragePostgresErrorCode.UNAVAILABLE,
	"statement-timeout": StoragePostgresErrorCode.STATEMENT_TIMEOUT,
	"lease-held": StoragePostgresErrorCode.LEASE_HELD,
	"lease-not-held": StoragePostgresErrorCode.LEASE_NOT_HELD,
	closed: StoragePostgresErrorCode.CLOSED,
});

/** Wire enum (storage_postgres.proto) for a failure class. */
export function storagePostgresErrorCode(
	failure: StoragePostgresFailure,
): StoragePostgresErrorCode {
	return WIRE_CODE_OF[failure];
}

/** Typed failure raised by `@hobo/storage-postgres`. */
export class StoragePostgresError extends EventStoreError {
	readonly failure: StoragePostgresFailure;
	readonly remediation: string;
	/** SQLSTATE of the underlying server error, when there was one. */
	readonly sqlState: string | undefined;

	constructor(
		failure: StoragePostgresFailure,
		message: string,
		options: { sqlState?: string; cause?: Error } = {},
	) {
		super(CODE_OF[failure], message);
		this.name = "StoragePostgresError";
		this.failure = failure;
		this.remediation = REMEDIATION_OF[failure];
		this.sqlState = options.sqlState;
		if (options.cause !== undefined) {
			Object.defineProperty(this, "cause", {
				value: options.cause,
				enumerable: false,
			});
		}
	}
}

const CORE_REMEDIATION: Readonly<Partial<Record<EventStoreErrorCode, string>>> =
	Object.freeze({
		OPTIMISTIC_SEQUENCE_CONFLICT:
			"Another writer appended first. Reload the stream, re-decide, and retry with the current expectedSeq.",
		STALE_FENCE:
			"A newer holder fenced this stream or lease. Stop writing; claim again to obtain a current fence.",
		MISSING_FENCE:
			"The stream is fenced. Append with the fence token of the current lease.",
		CHECKPOINT_REGRESSION:
			"Checkpoints only move forward. Resume from loadCheckpoint() instead of an older position.",
		SNAPSHOT_AHEAD:
			"Snapshot only at or below the stream head; fold the stream first.",
		INVALID_INPUT:
			"Fix the caller: the named field is outside the EventStore limits.",
		UNSUPPORTED_CODEC:
			"The row was written with a codec this build cannot read; run the build that wrote it.",
	});

/** Remediation for any error this store can throw, or undefined for foreign errors. */
export function remediationFor(error: Error): string | undefined {
	if (error instanceof StoragePostgresError) return error.remediation;
	if (error instanceof EventStoreError) return CORE_REMEDIATION[error.code];
	return undefined;
}

/** SQLSTATEs whose transaction can be retried as a whole without effect. */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

/** SQLSTATE classes and codes that mean "the server is not usable right now". */
function isUnavailableSqlState(state: string): boolean {
	return (
		state.startsWith("08") ||
		state === "57P01" ||
		state === "57P02" ||
		state === "57P03" ||
		state === "53300" ||
		state === "53000"
	);
}

const NETWORK_ERRNOS = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ENOTFOUND",
	"ETIMEDOUT",
	"EPIPE",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EAI_AGAIN",
]);

function stringField(error: Error, field: "code"): string | undefined {
	const value: unknown = Reflect.get(error, field);
	return typeof value === "string" ? value : undefined;
}

/** True when the whole transaction may be retried (serialization/deadlock). */
export function isRetryableTransactionError(error: Error): boolean {
	const code = stringField(error, "code");
	return code !== undefined && RETRYABLE_SQLSTATES.has(code);
}

/**
 * Translate a driver/server error into a typed store failure. Errors that are
 * already EventStore errors pass through unchanged; anything unrecognised is
 * returned as-is so a programming error is never disguised as an outage.
 */
export function translatePgError(error: Error): Error {
	if (error instanceof EventStoreError) return error;
	const code = stringField(error, "code");
	if (code === undefined) {
		if (/timeout exceeded when trying to connect|Connection terminated/iu.test(error.message)) {
			return new StoragePostgresError("unavailable", error.message, {
				cause: error,
			});
		}
		return error;
	}
	if (code === "57014" || code === "55P03") {
		return new StoragePostgresError(
			"statement-timeout",
			`statement cancelled (${code}): ${error.message}`,
			{ sqlState: code, cause: error },
		);
	}
	if (isUnavailableSqlState(code) || NETWORK_ERRNOS.has(code)) {
		return new StoragePostgresError(
			"unavailable",
			`database unavailable (${code}): ${error.message}`,
			{ sqlState: code, cause: error },
		);
	}
	return error;
}
