import type { SimulatedStep } from "../github-simulator-port.js";

export type JobConclusion = "success" | "failure" | "cancelled" | "skipped";

export type SimulatedAnnotation = Readonly<{
	level: "notice" | "warning" | "failure";
	message: string;
}>;

export type SimulatedStepResult = Readonly<{
	name: string;
	conclusion: JobConclusion;
}>;

export type RepositoryRecord = {
	id: number;
	fullName: string;
	ownerLogin: string;
	ownerId: number;
	private: boolean;
	defaultBranch: string;
	files: Map<string, Map<string, string>>;
};

export type JobRecord = {
	id: number;
	runId: number;
	runAttempt: number;
	repository: string;
	name: string;
	labelTemplates: readonly string[];
	labels: readonly string[];
	blocked: boolean;
	status: "queued" | "in_progress" | "completed";
	conclusion: JobConclusion | undefined;
	runnerId: number | undefined;
	runnerName: string | undefined;
	session: string | undefined;
	createdAtMs: number;
	queuedAtMs: number;
	startedAtMs: number | undefined;
	completedAtMs: number | undefined;
	outputs: Map<string, string>;
	annotations: SimulatedAnnotation[];
	steps: SimulatedStepResult[];
	log: string;
	needs: readonly string[];
	inputs: ReadonlyMap<string, string>;
	workflowSteps: readonly SimulatedStep[];
	serviceJobId: string;
};

export type AttemptRecord = {
	attempt: number;
	createdAtMs: number;
	jobIds: number[];
	completedAtMs: number | undefined;
};

export type RunRecord = {
	id: number;
	repository: string;
	event: string;
	actorId: string;
	workflowRef: string;
	fork: boolean;
	headSha: string;
	headBranch: string;
	attempts: Map<number, AttemptRecord>;
	latestAttempt: number;
};

export type RunnerLabelRecord = {
	id: number;
	name: string;
	type: "read-only" | "custom";
};

export type RunnerRecord = {
	id: number;
	name: string;
	labels: RunnerLabelRecord[];
	status: "online" | "offline";
	busy: boolean;
	repository: string | undefined;
	org: string | undefined;
	ephemeral: boolean;
	jobId: number | undefined;
	sessions: number;
};

export type DeliveryRecord = {
	id: string;
	event: "workflow_job" | "workflow_run";
	body: string;
	dropped: boolean;
	delivered: number;
};

export type BillingUsageItem = Readonly<{
	date: string;
	product: string;
	sku: string;
	quantity: number;
	unitType: string;
	pricePerUnit: number;
	grossAmount: number;
	discountAmount: number;
	netAmount: number;
	repositoryName?: string;
}>;

export type RecordedRequest = Readonly<{
	atMs: number;
	method: string;
	path: string;
	query: string;
	body: string;
	status: number;
	authorized: boolean;
	area: "rest" | "billing" | "logs" | "runner-service" | "unknown";
}>;
