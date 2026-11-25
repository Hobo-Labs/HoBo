// Execution-host provider contract types (control-plane.md §Execution-host
// provider categories), promoted from the `execution-host-provider-contract`
// draft proof into the first REAL adapter of the pair of ports (HOBO-718).
// Two categories exist: `runner` (executes CI/action jobs, port `hobo:runner`)
// and `build-machine` (the host a BuildProvider engine runs on, port
// `hobo:build-machine`). Both are selected per job by the Dispatcher
// (ADR-0071) to maximize free credits across only the registered providers.

// public-contract: the runner execution-host category token.
export const RUNNER_CATEGORY = "runner";
// public-contract: the build-machine execution-host category token.
export const BUILD_MACHINE_CATEGORY = "build-machine";

export type ExecutionHostCategory =
	| typeof RUNNER_CATEGORY
	| typeof BUILD_MACHINE_CATEGORY;

// Category -> agnostic port (control-plane.md execution-host categories).
export const CATEGORY_PORTS = {
	runner: "hobo:runner",
	"build-machine": "hobo:build-machine",
} satisfies Record<ExecutionHostCategory, string>;

// Category -> the metered SKU each cost fact declares (Plan 5 CreditLedgerView
// ranks by effective marginal cost per SKU).
export const CATEGORY_SKUS = {
	runner: "runner.minutes",
	"build-machine": "build.minutes",
} satisfies Record<ExecutionHostCategory, string>;

// A CI/action job handed to a RunnerProvider by the Dispatcher.
export interface RunnerJob {
	// The durable job id — correlates dispatch.Decided, runner.* facts and the
	// remote workflow run.
	readonly jobId: string;
	// The workflow file to dispatch (defaults to the provider's runner workflow).
	readonly workflow?: string;
	// The git ref the workflow_dispatch targets (default "main").
	readonly ref?: string;
	// Extra workflow_dispatch inputs (jobId is always injected as `job_id`).
	readonly inputs?: Record<string, string>;
	// The command the job runs (recorded on the result fact; the workflow
	// receives it as the `command` input).
	readonly command?: string;
	// Estimated metered units (minutes) — the Dispatcher's ledger input.
	readonly estimatedUnits?: number;
}

export type RunnerEventType =
	| "runner.JobStarted"
	| "runner.JobSucceeded"
	| "runner.JobFailed";

// Past-tense runner facts emitted alongside the result — the caller appends
// them to the durable log (event-sourced control plane; providers stay
// stateless and never write the log themselves).
export interface RunnerEvent {
	readonly type: RunnerEventType;
	readonly jobId: string;
	readonly providerId: string;
	readonly runId?: number;
	readonly runUrl?: string;
}

export interface RunnerResult {
	readonly providerId: string;
	readonly category: typeof RUNNER_CATEGORY;
	readonly jobId: string;
	readonly status: "succeeded" | "failed";
	readonly command: string;
	readonly runId: number;
	readonly runUrl: string;
	readonly events: RunnerEvent[];
}

// A build handed to a BuildMachineProvider: the BuildProvider engine executes
// ON this host (deepens ADR-0005); the outcome is a pullable image reference.
export interface ExecutionHostBuild {
	readonly buildId: string;
	// The GHCR container package the build workflow publishes (defaults to the
	// buildId).
	readonly imageName?: string;
	readonly workflow?: string;
	readonly ref?: string;
	readonly inputs?: Record<string, string>;
	// Estimated metered units (minutes) checked against the credit budget.
	readonly estimatedUnits?: number;
}

// A pullable OCI image reference (control-plane.md `ImageRef`).
export interface ImageRef {
	readonly mediaType: string;
	readonly uri: string;
	readonly digest: string;
}

// Remaining prepaid/free units for this host — the Dispatcher's reservation
// against the CreditLedgerView (Plan 5).
export interface CreditBudget {
	remainingUnits: number;
}

// The execution-host Capability Manifest (schema
// hobo.execution-host-capability-manifest/v1): exactly one execution-host
// port, plus declared cost facts incl. free tiers so CreditLedgerView ranking
// has honest inputs.
export interface ExecutionHostCostFact {
	readonly sku: string;
	readonly unit: string;
	readonly marginalPrice: string;
	readonly freeTier: {
		readonly unit: string;
		readonly included: number;
		readonly reset: string;
	};
	readonly source: { readonly type: string; readonly digest: string };
}

export interface ExecutionHostManifest {
	readonly schema: string;
	readonly provider: {
		readonly id: string;
		readonly category: ExecutionHostCategory;
		readonly kind: string;
		readonly adapter: string;
	};
	readonly capabilities: Array<{
		readonly port: string;
		readonly interface: string;
		readonly version: string;
		readonly stability: string;
		readonly features: readonly string[];
	}>;
	readonly cost: {
		readonly schema: string;
		readonly currency: string;
		readonly facts: ExecutionHostCostFact[];
	};
}

// The pair of execution-host ports (control-plane.md interfaces).
export interface RunnerProvider {
	readonly id: string;
	readonly category: typeof RUNNER_CATEGORY;
	capabilityManifest(): ExecutionHostManifest;
	run(job: RunnerJob): Promise<RunnerResult>;
}

export interface BuildMachineProvider {
	readonly id: string;
	readonly category: typeof BUILD_MACHINE_CATEGORY;
	capabilityManifest(): ExecutionHostManifest;
	execute(build: ExecutionHostBuild): Promise<ImageRef>;
}

export type ExecutionHostProvider = RunnerProvider | BuildMachineProvider;
