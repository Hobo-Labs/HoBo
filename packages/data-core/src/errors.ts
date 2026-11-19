export const DATA_CORE_ERROR_CODES = [
	"INVALID_DATASET_SCHEMA",
	"INVALID_RECORD",
	"INVALID_ENVELOPE",
	"INVALID_ENGINE_DECLARATION",
	"INVALID_CUSTODY_PATH",
	"INVALID_SELECTION_REQUEST",
	"INVALID_MIGRATION_PLAN",
	"PORT_MISSING",
	"FENCED_WRITE",
	"FENCE_TOKEN_MISMATCH",
	"FENCE_OPERATION_HELD",
	"FENCE_OPERATION_UNTRUSTED",
	"FENCE_OPERATION_CONFLICT",
	"RETIRE_REFUSED",
	"ILLEGAL_PHASE_TRANSITION",
	"POLICY_DENIED",
	"VERIFICATION_FAILED",
	"CONFORMANCE_SUITE_INVALID",
	"NATIVE_REALIZATION_UNAVAILABLE",
	"NATIVE_TRANSFER_REFUSED",
	"NATIVE_TRANSFER_LOST",
	"STALE_APPLY",
	"JOURNAL_CONFLICT",
	"STALE_AUTHORITY_MOVE",
	"CAPTURE_POSITION_INVALID",
	"CAPTURE_SUBSCRIPTION_CONFLICT",
] as const;

export type DataCoreErrorCode = (typeof DATA_CORE_ERROR_CODES)[number];

export type DataCoreErrorDetail = Readonly<
	Record<string, string | number | boolean>
>;

export type DataCoreErrorOptions = {
	readonly detail?: DataCoreErrorDetail;
	readonly cause?: unknown;
};

export class DataCoreError extends Error {
	readonly code: DataCoreErrorCode;
	readonly detail: DataCoreErrorDetail;

	constructor(
		code: DataCoreErrorCode,
		message: string,
		options: DataCoreErrorOptions = {},
	) {
		super(message, options.cause === undefined ? {} : { cause: options.cause });
		this.name = "DataCoreError";
		this.code = code;
		this.detail = Object.freeze(options.detail ?? {});
	}
}

export function isDataCoreError(
	value: DataCoreError | Error | null | undefined,
): value is DataCoreError {
	return value instanceof DataCoreError;
}

export class FencedWriteError extends DataCoreError {
	readonly dataset: string;
	readonly tenant: string;

	constructor(dataset: string, tenant: string) {
		super(
			"FENCED_WRITE",
			`dataset ${dataset}${tenant === "" ? "" : ` (tenant ${tenant})`} is fenced; write authority has moved`,
			{ detail: { dataset, tenant } },
		);
		this.name = "FencedWriteError";
		this.dataset = dataset;
		this.tenant = tenant;
	}
}

export class StaleApplyError extends DataCoreError {
	readonly dataset: string;
	readonly source: string;

	constructor(dataset: string, source: string) {
		super(
			"STALE_APPLY",
			`the watermark for ${source} on dataset ${dataset} is not the one this apply named; another applier has written since`,
			{ detail: { dataset, source } },
		);
		this.name = "StaleApplyError";
		this.dataset = dataset;
		this.source = source;
	}
}

export class CapturePositionError extends DataCoreError {
	readonly subscription: string;

	constructor(
		subscription: string,
		message: string,
		options: { readonly cause?: unknown } = {},
	) {
		super("CAPTURE_POSITION_INVALID", message, {
			detail: { subscription },
			...(options.cause === undefined ? undefined : { cause: options.cause }),
		});
		this.name = "CapturePositionError";
		this.subscription = subscription;
	}
}

export class JournalConflictError extends DataCoreError {
	readonly migrationId: string;
	readonly expectedCount: number;

	constructor(
		migrationId: string,
		expectedCount: number,
		options: { readonly cause?: unknown } = {},
	) {
		super(
			"JOURNAL_CONFLICT",
			`migration ${migrationId} was advanced by another driver; this one read ${expectedCount} fact(s) and the journal has moved on`,
			{
				detail: { migrationId, expectedCount },
				...(options.cause === undefined ? undefined : { cause: options.cause }),
			},
		);
		this.name = "JournalConflictError";
		this.migrationId = migrationId;
		this.expectedCount = expectedCount;
	}
}

export class StaleAuthorityMoveError extends DataCoreError {
	readonly migrationId: string;
	readonly head: number;
	readonly appliedHead: number;

	constructor(migrationId: string, head: number, appliedHead: number) {
		super(
			"STALE_AUTHORITY_MOVE",
			`an authority move for migration ${migrationId} was decided at journal head ${head}; the router has already applied one decided at ${appliedHead}`,
			{ detail: { migrationId, head, appliedHead } },
		);
		this.name = "StaleAuthorityMoveError";
		this.migrationId = migrationId;
		this.head = head;
		this.appliedHead = appliedHead;
	}
}

export function isSupersededError(
	value: DataCoreError | Error | null | undefined,
): value is StaleApplyError | JournalConflictError | StaleAuthorityMoveError {
	return (
		value instanceof StaleApplyError ||
		value instanceof JournalConflictError ||
		value instanceof StaleAuthorityMoveError
	);
}
