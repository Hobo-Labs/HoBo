/**
 * Stable error codes for the engine-neutral data contract.
 *
 * Every code names something a caller can act on. `FENCED_WRITE` in
 * particular is part of the contract rather than a failure: a fenced writer
 * being refused is how a migration keeps exactly one write authority.
 */
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
	"RETIRE_REFUSED",
	"ILLEGAL_PHASE_TRANSITION",
	"POLICY_DENIED",
	"VERIFICATION_FAILED",
	"CONFORMANCE_SUITE_INVALID",
	// A `native` realization that cannot run. Never answered by quietly running
	// the hub instead: the realization is part of the recorded decision.
	"NATIVE_REALIZATION_UNAVAILABLE",
	// A native transfer the engine will not attempt, because it could not do it
	// faithfully; `detail.reason` names why.
	"NATIVE_TRANSFER_REFUSED",
	// The objects behind a native transfer are gone; what it retained is lost.
	"NATIVE_TRANSFER_LOST",
	// A conditional apply found a watermark other than the one it named: some
	// other applier has written since. Nothing of the batch landed.
	"STALE_APPLY",
	// A journal append named a head the journal is no longer at: another
	// driver of the same migration appended first. Nothing was appended.
	"JOURNAL_CONFLICT",
	// A router was asked to move write authority on a decision older than one
	// it has already applied for the same migration. Nothing moved.
	"STALE_AUTHORITY_MOVE",
	// A capture position the engine never minted, one beyond its head, or one
	// whose changes were acknowledged and released. Never answered with an
	// empty "caught up" batch, and never accepted as an acknowledgement.
	"CAPTURE_POSITION_INVALID",
	// A capture subscription name that is already bound to another scope. The
	// name's position belongs to that scope and is never handed to this one.
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

/** A write reached a fenced scope without the fence token that guards it. */
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

/**
 * A conditional apply was refused: the watermark recorded for the source is
 * not the one the applier named, so another applier has written since it last
 * looked. Like a fenced write, this is the contract working — it is how a
 * driver that has been superseded is kept from writing over its successor —
 * and nothing of the refused batch has landed.
 */
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

/**
 * A capture position that cannot be read from or acknowledged: text the
 * engine never minted, a position past its head, or one below what the
 * subscription already acknowledged. Answering any of them with an empty,
 * caught-up batch would tell a tail it had finished when it had read nothing.
 */
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

/**
 * A journal append lost its compare-and-set: the journal no longer ends where
 * the run that tried to append had read it to. Another driver is running the
 * same migration and got there first. The loser has appended nothing and must
 * stop without touching either store.
 */
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

/**
 * A router refused to move write authority: the move names a journal head
 * lower than one the router has already applied for this migration, so the
 * decision behind it has been overtaken — by a rollback, say. Thrown by the
 * router (`admitAuthorityMove`), and read by an executor as supersession.
 * Nothing moved.
 */
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

/**
 * True for the three refusals that tell a driver it has been superseded. A
 * run that meets one stops where it is: it records nothing further and
 * compensates nothing, because the driver that superseded it owns the
 * migration now.
 */
export function isSupersededError(
	value: DataCoreError | Error | null | undefined,
): value is StaleApplyError | JournalConflictError | StaleAuthorityMoveError {
	return (
		value instanceof StaleApplyError ||
		value instanceof JournalConflictError ||
		value instanceof StaleAuthorityMoveError
	);
}
