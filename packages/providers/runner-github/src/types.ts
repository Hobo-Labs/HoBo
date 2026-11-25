// public-contract: the runner execution-host category token.
export const RUNNER_CATEGORY = "runner";
// public-contract: the build-machine execution-host category token.
export const BUILD_MACHINE_CATEGORY = "build-machine";

export type ExecutionHostCategory =
	| typeof RUNNER_CATEGORY
	| typeof BUILD_MACHINE_CATEGORY;

export const CATEGORY_PORTS = {
	runner: "hobo:runner",
	"build-machine": "hobo:build-machine",
} satisfies Record<ExecutionHostCategory, string>;

export const CATEGORY_SKUS = {
	runner: "runner.minutes",
	"build-machine": "build.minutes",
} satisfies Record<ExecutionHostCategory, string>;

export interface RunnerJob {
	readonly jobId: string;
	readonly workflow?: string;
	readonly ref?: string;
	readonly inputs?: Record<string, string>;
	readonly command?: string;
	readonly estimatedUnits?: number;
}

export type RunnerEventType =
	| "runner.JobStarted"
	| "runner.JobSucceeded"
	| "runner.JobFailed";

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

export interface ExecutionHostBuild {
	readonly buildId: string;
	readonly imageName?: string;
	readonly workflow?: string;
	readonly ref?: string;
	readonly inputs?: Record<string, string>;
	readonly estimatedUnits?: number;
}

export interface ImageRef {
	readonly mediaType: string;
	readonly uri: string;
	readonly digest: string;
}

export interface CreditBudget {
	remainingUnits: number;
}

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
