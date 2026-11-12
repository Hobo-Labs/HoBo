// OpenTelemetry CI/CD semantic conventions as used by @hobo/cd (D17, R8).
// The pinned version lives in STANDARDS.lock.json next to this file; the two
// must agree (a golden test enforces it). Names here are wire contract:
// collectors, dashboards and the alert rules key on them.

// public-contract: the pinned semantic-conventions release.
export const SEMCONV = Object.freeze({
	version: "1.41.0",
	schemaUrl: "https://opentelemetry.io/schemas/1.41.0",
} as const);

// public-contract: instrumentation scope reported on every export.
export const CD_INSTRUMENTATION_SCOPE = Object.freeze({
	name: "@hobo/cd",
	version: "0.0.1",
} as const);

// public-contract: OTel CI/CD registry attribute keys (semconv `cicd.*`).
export const CICD = Object.freeze({
	pipelineName: "cicd.pipeline.name",
	pipelineActionName: "cicd.pipeline.action.name",
	pipelineResult: "cicd.pipeline.result",
	pipelineRunId: "cicd.pipeline.run.id",
	pipelineRunState: "cicd.pipeline.run.state",
	pipelineRunUrlFull: "cicd.pipeline.run.url.full",
	pipelineTaskName: "cicd.pipeline.task.name",
	pipelineTaskRunId: "cicd.pipeline.task.run.id",
	pipelineTaskRunResult: "cicd.pipeline.task.run.result",
	pipelineTaskRunUrlFull: "cicd.pipeline.task.run.url.full",
	pipelineTaskType: "cicd.pipeline.task.type",
	systemComponent: "cicd.system.component",
	workerId: "cicd.worker.id",
	workerName: "cicd.worker.name",
	workerState: "cicd.worker.state",
} as const);

// public-contract: other registry keys @hobo/cd sets.
export const DEPLOYMENT_ENVIRONMENT_NAME =
	"deployment.environment.name" as const;
// public-contract: other registry keys @hobo/cd sets.
export const ERROR_TYPE = "error.type" as const;

// public-contract: HoBo attribute keys (outside the OTel registry namespace).
export const HOBO_ATTR = Object.freeze({
	freightId: "hobo.freight.id",
	freightAlias: "hobo.freight.alias",
	campId: "hobo.camp.id",
	stationId: "hobo.station.id",
	yardId: "hobo.yard.id",
	pipelineNode: "hobo.cd.pipeline.node",
	promotionId: "hobo.cd.promotion.id",
	intent: "hobo.cd.intent",
	fanoutId: "hobo.cd.fanout.id",
	railDigest: "hobo.rail.digest",
	control: "hobo.policy.control",
	condition: "hobo.camp.condition",
	conditionStatus: "hobo.camp.condition.status",
	taintKey: "hobo.camp.taint.key",
	taintEffect: "hobo.camp.taint.effect",
	state: "state",
} as const);

// public-contract: semconv enum values @hobo/cd emits.
export const CICD_ACTION = Object.freeze({
	build: "BUILD",
	run: "RUN",
	sync: "SYNC",
} as const);

export type CicdResult =
	| "success"
	| "failure"
	| "error"
	| "timeout"
	| "cancellation"
	| "skip";

export type CicdRunState = "pending" | "executing" | "finalizing";

export type CicdTaskType = "build" | "test" | "deploy";

// public-contract: OTel CI/CD metric names (semconv `cicd.*` metrics).
export const CICD_METRICS = Object.freeze({
	pipelineRunDuration: "cicd.pipeline.run.duration",
	pipelineRunActive: "cicd.pipeline.run.active",
	pipelineRunErrors: "cicd.pipeline.run.errors",
	systemErrors: "cicd.system.errors",
	workerCount: "cicd.worker.count",
} as const);

// public-contract: HoBo CD metric names (DORA, reconcile, fleet and policy).
export const CD_METRICS = Object.freeze({
	doraDeploymentFrequency: "hobo.cd.dora.deployment_frequency",
	doraLeadTime: "hobo.cd.dora.lead_time",
	doraChangeFailureRate: "hobo.cd.dora.change_failure_rate",
	doraTimeToRestore: "hobo.cd.dora.time_to_restore",
	reconcileLag: "hobo.cd.reconcile.lag",
	fanoutCamps: "hobo.cd.fanout.camps",
	failoverCount: "hobo.cd.failover.count",
	complianceNoncompliantRatio: "hobo.cd.compliance.noncompliant_ratio",
	policyShadowDivergence: "hobo.cd.policy.shadow_divergence",
	campCondition: "hobo.cd.camp.condition",
	campTaint: "hobo.cd.camp.taint",
	exportFailures: "hobo.cd.telemetry.export_failures",
	authzDecisions: "hobo.cd.authz.decisions",
	authzRefusals: "hobo.cd.authz.refusals",
} as const);
