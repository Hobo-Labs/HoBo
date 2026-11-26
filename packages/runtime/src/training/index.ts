export {
	COMPONENT_METADATA,
	type ComponentMetadata,
	type ComponentOptions,
	component,
	componentMetadataOf,
	operation,
	param,
	TRAINABLE_METADATA,
	trainable,
} from "./decorators.js";
export {
	defineGrounding,
	description,
	intent,
	PENDING_GROUNDINGS,
	resolveDeclared,
	returns,
} from "./granular.js";
export {
	lintUseTrainingSource,
	type UseTrainingLintFinding,
	type UseTrainingLintResult,
} from "./lint.js";
export {
	type DeclaredOperation,
	type DeclaredParameter,
	type DeclaredTrainableClass,
	generateDeclaredRegistrations,
	scanDeclaredTrainables,
} from "./scan.js";
export {
	applyTrainingArtifact,
	getAppliedArtifact,
	getTrainable,
	isTrainable,
	listTrainables,
	resetTrainables,
	resolveTrainable,
	stub,
	training,
} from "./training.js";
export {
	type FieldDescription,
	type FieldMetadata,
	type RecordedTrainableCall,
	TRAINABLE,
	type Trainable,
	type TrainableManifestFact,
	type TrainableRecord,
	TrainingArtifactError,
	type TrainingContract,
	type TrainingExample,
	TrainingGroundingError,
	type TrainingOptions,
	TrainingResolutionError,
} from "./types.js";
