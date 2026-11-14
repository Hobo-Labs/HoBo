export {
	type CompensationContext,
	type CompensationDeps,
	type CompensationResult,
	runCompensation,
} from "./compensation.js";

export {
	changedSinceLastDeployed,
	classifyResource,
	currentEpochStart,
	DEPLOYMENT_MODES,
	type DeploymentChangeSet,
	type DeploymentMode,
	type DesiredSpecHash,
	desiredSpecHash,
	orphansToPrune,
	parseDeploymentMode,
	planDeploymentChanges,
	type RecordedResource,
	type ResourceChange,
	type ResourceChangeAction,
	recordedResources,
} from "./desired-state.js";
export {
	type OrchestratorContext,
	type OrchestratorDeps,
	type OrchestratorResult,
	type OrchestratorStatus,
	runOrchestrator,
} from "./orchestrator.js";
export {
	destroyResource,
	foldResourceActor,
	iacProgramFor,
	isConverged,
	RESOURCE_ACTOR_STATES,
	type ReconcileContext,
	type ReconcileOutcome,
	type ResourceActorDeps,
	type ResourceActorSnapshot,
	type ResourceActorState,
	reconcileResource,
	resourceActorKey,
} from "./resource-actor.js";
