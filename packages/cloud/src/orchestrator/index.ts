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
	planDeploymentChangesFromRecorded,
	type RecordedResource,
	type ResourceChange,
	type ResourceChangeAction,
	recordedResources,
} from "./desired-state.js";
export {
	createHttpDependencyObserver,
	type HttpDependencyObserverOptions,
} from "./http-dependency-observer.js";
export {
	type BlockedDependency,
	type DependencyObservationRequest,
	type DependencyObservationStatus,
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
