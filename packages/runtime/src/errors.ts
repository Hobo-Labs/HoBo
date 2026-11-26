// Typed failures for the authoring surface. These mirror the `runtime-error`
// variant in `hobo:runtime@0.1.0` (retryable / fatal / cancelled): workflow and
// agent handlers throw these instead of log-and-continue, so replay and the
// capability membrane observe a single, typed error channel.

/** Base class for every authoring-surface error. */
export class RuntimeAuthoringError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeAuthoringError";
	}
}

/**
 * Deny-by-default capability denial (`ctx` is scoped to declared capabilities,
 * sdk-api.md §Layer 4 / wasm-runtime-wit.md §Security substrate). Reaching for
 * an undeclared capability — an agent tool or a broker token that was never
 * granted — throws this, never a silent no-op.
 */
export class CapabilityDeniedError extends RuntimeAuthoringError {
	readonly code = "capability.denied" as const;
	readonly capability: string;
	readonly granted: readonly string[];

	constructor(capability: string, granted: readonly string[]) {
		super(
			`capability denied: ${capability} is not in the declared capability set [${granted.join(", ")}]`,
		);
		this.name = "CapabilityDeniedError";
		this.capability = capability;
		this.granted = [...granted];
	}
}

export class FatalError extends RuntimeAuthoringError {
	readonly code = "fatal" as const;
	constructor(message: string) {
		super(message);
		this.name = "FatalError";
	}
}

export class RetryableError extends RuntimeAuthoringError {
	readonly code = "retryable" as const;
	readonly retries: number | undefined;
	constructor(message: string, options: { retries?: number } = {}) {
		super(message);
		this.name = "RetryableError";
		this.retries = options.retries;
	}
}

export class WorkflowExecutionAborted extends RuntimeAuthoringError {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowExecutionAborted";
	}
}

export class WorkflowFailure extends RuntimeAuthoringError {
	readonly code = "workflow.failed" as const;
	readonly step: string | undefined;
	readonly cause: Error | undefined;
	constructor(message: string, options: { step?: string; cause?: Error } = {}) {
		super(message);
		this.name = "WorkflowFailure";
		this.step = options.step;
		this.cause = options.cause;
	}
}
