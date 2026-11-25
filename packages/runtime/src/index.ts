// Trainable-method authoring surface (ADR-0025 / ADR-0125): the promised
// `training` namespace exported from the package root (sdk-api.md §Trainable methods).

// Durable authoring surface (S1-14, sdk-api.md §Layer 4): actors/grains,
// workflow/step, agent(), and the deny-by-default capability context — lowering
// onto the `hobo:runtime@0.1.0` primitives.
export {
	type ActorDefinition,
	type ActorHandlerContext,
	type ActorInstance,
	activateActor,
	type DefineActorInput,
	defineActor,
} from "./actor.js";
export {
	type AgentTool,
	agent,
	type DefineAgentInput,
} from "./agent.js";
export {
	type Boundary,
	type BoundaryExample,
	type BoundaryRouter,
	BoundaryRoutingError,
	type BoundaryServed,
	type BoundaryStatus,
	type BridgeContract,
	BridgeContractError,
	type BridgeOptions,
	createBoundaryRouter,
	type FaultOptions,
	isSubsetMatch,
	type RecordedBoundaryCall,
	type ShadowDiff,
} from "./bridge/index.js";
export {
	type ActorStub,
	type Capability,
	type CtxEffects,
	createRuntimeContext,
	type RuntimeContext,
	type StepOptions,
	type TokenBroker,
	tokenCapability,
	toolCapability,
} from "./ctx.js";
export {
	CapabilityDeniedError,
	FatalError,
	RetryableError,
	RuntimeAuthoringError,
	WorkflowFailure,
} from "./errors.js";
// The JSON types the trainable surface is typed in. A generated module's
// exports (`training.define`, `defineGrounding`) infer `Trainable<JsonValue,
// JsonValue>`, and declaration emit can name that type only through the root.
export type { JsonBag, JsonObject, JsonValue } from "./json.js";
export {
	type PlacementResolved,
	type ResolveActorPlacementInput,
	resolveActorPlacement,
	signalActor,
} from "./placement.js";
export type {
	ActorHost,
	ActorLease,
	ActorStateHandle,
	FoldEvent,
	RuntimeClock,
} from "./ports.js";
export {
	DEFAULT_STEP_RETRIES,
	defineStep,
	runWithRetries,
	type StepDefinition,
	step,
} from "./step.js";
export {
	applyTrainingArtifact,
	COMPONENT_METADATA,
	type ComponentMetadata,
	type ComponentOptions,
	component,
	componentMetadataOf,
	type DeclaredOperation,
	type DeclaredParameter,
	type DeclaredTrainableClass,
	defineGrounding,
	description,
	type FieldDescription,
	type FieldMetadata,
	generateDeclaredRegistrations,
	getAppliedArtifact,
	getTrainable,
	intent,
	isTrainable,
	lintUseTrainingSource,
	listTrainables,
	operation,
	PENDING_GROUNDINGS,
	param,
	type RecordedTrainableCall,
	resetTrainables,
	resolveDeclared,
	resolveTrainable,
	returns,
	scanDeclaredTrainables,
	stub,
	TRAINABLE,
	TRAINABLE_METADATA,
	type Trainable,
	type TrainableManifestFact,
	type TrainableRecord,
	TrainingArtifactError,
	type TrainingContract,
	type TrainingExample,
	TrainingGroundingError,
	type TrainingOptions,
	TrainingResolutionError,
	trainable,
	training,
	type UseTrainingLintFinding,
	type UseTrainingLintResult,
} from "./training/index.js";
export type {
	WitActorKey,
	WitAgentMessage,
	WitEvent,
	WitRuntimeError,
	WitStateEntry,
	WitStepOpts,
	WitTokenHandle,
	WitTokenRequest,
	WitToolCall,
} from "./wit.js";
export {
	createWorkflowEngine,
	type DefineWorkflowInput,
	defineWorkflow,
	type RunStatus,
	type WorkflowContext,
	type WorkflowDefinition,
	type WorkflowEngine,
	type WorkflowEngineOptions,
	type WorkflowRunHandle,
	workflow,
} from "./workflow.js";
