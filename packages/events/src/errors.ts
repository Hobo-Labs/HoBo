export class SagaCompensationError extends Error {
	readonly code = "SAGA_COMPENSATED" as const;
	readonly sagaId: string;
	readonly step: string;
	readonly cause: unknown;
	constructor(sagaId: string, step: string, cause: unknown) {
		super(
			`saga ${sagaId} compensated at step "${step}": ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "SagaCompensationError";
		this.sagaId = sagaId;
		this.step = step;
		this.cause = cause;
	}
}
