export class RuntimeAuthoringError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeAuthoringError";
	}
}

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
