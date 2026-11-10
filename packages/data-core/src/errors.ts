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
