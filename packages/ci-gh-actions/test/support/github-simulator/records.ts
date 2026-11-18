/**
 * The simulator's mutable state, kept apart from the frozen snapshots the
 * wave 0 interface hands out (`../github-simulator-port.ts`). Nothing here
 * leaves the simulator: readers get `SimulatedJob` and `SimulatedRunner`.
 */
import type { SimulatedStep } from "../github-simulator-port.js";

/** A conclusion GitHub gives a job. */
export type JobConclusion = "success" | "failure" | "cancelled" | "skipped";

/** One check-run annotation, as `GET /check-runs/{id}/annotations` lists it. */
export type SimulatedAnnotation = Readonly<{
	/** `notice`, `warning` or `failure`: GitHub's annotation levels. */
	level: "notice" | "warning" | "failure";
	message: string;
}>;

/** One step's result, as the jobs list shows it. */
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
	/** Files per branch name: path to text. */
	files: Map<string, Map<string, string>>;
};

export type JobRecord = {
	id: number;
	runId: number;
	runAttempt: number;
	repository: string;
	name: string;
	/** `runs-on` as written, before `needs` outputs are substituted. */
	labelTemplates: readonly string[];
	labels: readonly string[];
	/** Waiting on `needs`: not on GitHub's lists, offered to no runner. */
	blocked: boolean;
	status: "queued" | "in_progress" | "completed";
	conclusion: JobConclusion | undefined;
	runnerId: number | undefined;
	runnerName: string | undefined;
	/** The runner service session that took it, for relay jobs. */
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
	/** The runner service's id for the job, a GUID as the service writes one. */
	serviceJobId: string;
};

export type AttemptRecord = {
	attempt: number;
	createdAtMs: number;
	/** The jobs this attempt lists: its own, then those kept from the one before. */
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
	/** Registered on one repository. */
	repository: string | undefined;
	/** Registered on an organization. */
	org: string | undefined;
	ephemeral: boolean;
	jobId: number | undefined;
	/** Open runner service sessions. */
	sessions: number;
};

/** One webhook GitHub sent, or lost. */
export type DeliveryRecord = {
	id: string;
	event: "workflow_job" | "workflow_run";
	body: string;
	dropped: boolean;
	/** How many times it reached a handler. */
	delivered: number;
};

/** One enhanced-billing usage item (`GET .../settings/billing/usage`). */
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

/** A request the simulator answered. */
export type RecordedRequest = Readonly<{
	atMs: number;
	method: string;
	/** The URL's path, decoded as sent. */
	path: string;
	/** The URL's query string, with its `?`, or empty. */
	query: string;
	body: string;
	status: number;
	/** Sent with an `Authorization` header. */
	authorized: boolean;
	area: "rest" | "billing" | "logs" | "runner-service" | "unknown";
}>;
