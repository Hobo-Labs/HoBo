export {
	APP_KIT_KINDS,
	type AppKitKind,
	appKitLabel,
	HTTP_APP_KIT_KINDS,
	type HttpAppKitKind,
	INFRA_KIT_KINDS,
	isAppKitKind,
	isHttpAppKitKind,
} from "./app-kits.js";
export {
	type BindingDeliveryGateResult,
	type BindingDeliveryReason,
	evaluateBindingDeliveryGate,
	isForbiddenSecretEnvKey,
	looksLikeSecretEnvValue,
} from "./binding-delivery.js";
export {
	bindle,
	DEFAULT_BINDLE_NAME,
	inferRequirementsFromResources,
} from "./bindle.js";
export {
	api,
	auth,
	bucket,
	CATALOG,
	catalogFactoryNames,
	crypto,
	data,
	experiment,
	flag,
	guardrail,
	job,
	kv,
	notify,
	project,
	queue,
	rolloutResource,
	schedule,
	// secret is dual-exported from secret-surface.ts (resource + field builders)
	service,
	topic,
	ui,
	web,
	websocket,
} from "./catalog.js";
export type {
	CollectionContext,
	CollectionEvent,
	CollectionEventType,
	CollectionResult,
	CollectionTarget,
	ComponentHostDescriptor,
	ManifestProducedData,
	ManifestProducedEvent,
	ResourcesCollectedData,
	ResourcesCollectedEvent,
} from "./collect/index.js";
export {
	COLLECTION_EVENT_SOURCE,
	CollectionEngineError,
	collectBindleManifest,
	createCollectionEvents,
	manifestFromWiring,
} from "./collect/index.js";
export {
	type ConfigGateReason,
	evaluateSecretlessConfigGate,
	type SecretlessConfigGateInput,
	type SecretlessConfigGateResult,
} from "./config-can-deploy.js";
export {
	type GeneratedAgentConfigView,
	generateCtxConfigSource,
	materializeAgentConfigView,
} from "./config-codegen.js";
export {
	assertSourceAllowed,
	type ConfigFieldDef,
	type ConfigFieldKind,
	type ConfigSchema,
	config,
	envField,
	fromBinding,
	SECRET_SOURCE_RANKS,
	type SecretSourceRank,
	schemaOnlyView,
	secretField,
	sourceRankIndex,
} from "./config-schema.js";
export {
	CONFIG_SENSITIVITY,
	type ConfigSensitivity,
	sensitivityForField,
} from "./config-sensitivity.js";
export {
	type ConnectionClient,
	type ConnectionRequirement,
	connectionRef,
	requireConnection,
} from "./connection.js";
export {
	collectRequiredRuntimes,
	containerDependencyAnnotation,
	DEPENDENCY_OPTION,
	dependencyAnnotation,
	dependencyRuntimeOf,
	discoveryEndpointsForDependency,
	discoveryEnvForDependency,
	externalDependencyAnnotation,
	isDependencyAnnotation,
	type RequiredRuntimeKind,
	readDependencyConfig,
	wasmComponentDependencyAnnotation,
} from "./dependencies.js";
export { env } from "./env.js";
export {
	BINDLE_FEATURES_SCHEMA,
	type ExperimentDeclaration,
	type ExperimentSpec,
	experiment as declareExperiment,
	type FeatureFlagSpec,
	type FeatureState,
	type FeaturesDeclaration,
	featureSpecsToStoreInputs,
	features,
	type RolloutDeclaration,
	type RolloutSpec,
	type RolloutStageSpec,
	rollout,
} from "./features.js";
export {
	assertNoBindleProviderSelection,
	BINDLE_PROVIDER_SELECTION_FORBIDDEN,
	BINDLE_PROVIDER_SELECTION_REMEDIATION,
	type BindleRequirementsHash,
	collectExplicitProviderPins,
	emptyBindleRequirements,
	hashBindleRequirements,
	isPlatformAnnotation,
	parseBindleRequirements,
} from "./requirements.js";
export { secretRef } from "./secret-ref.js";
export { secret } from "./secret-surface.js";
export {
	defaultAppKitSessionReplayAnnotation,
	isSessionReplayAnnotation,
	SESSION_REPLAY_OPTION,
	type SessionReplayBindleConfig,
	sessionReplay,
} from "./session-replay.js";
export {
	isStatusPageAnnotation,
	readStatusPageConfig,
	STATUS_PAGE_OPTION,
	type StatusPageBindleConfig,
	statusPage,
} from "./status-page.js";
export type {
	AllowVerbsFor,
	BindleBuilder,
	BindleConnectorRecord,
	BindleDefinition,
	BindleDependency,
	BindleEdge,
	BindleRequirements,
	BindleResource,
	BindleResourceRecord,
	BindleRuntimeContext,
	ConnectorAuthDefinition,
	ConnectorBinding,
	ConnectorCapability,
	ConnectorDefinition,
	ConnectorSymbol,
	ContainerDependencyOptions,
	ExternalDependencyOptions,
	LoweringDescriptor,
	ProviderAnnotation,
	ResourceCatalogEntry,
	ResourceDescriptor,
	ResourceHandle,
	ResourceKind,
	SecretRef,
	WasmComponentDependencyOptions,
} from "./types.js";
export {
	isWebAppAnnotation,
	WASP_WEBAPP_METADATA,
	WEBAPP_OPTION,
	webAppAnnotationFromBinding,
} from "./webapp.js";
export type {
	BindingMeta,
	ComponentHandle,
	Handle,
	ManifestResource,
	ResourceHandle as WiringResourceHandle,
	WiringManifest,
} from "./wiring/index.js";
export {
	addContainer,
	BindReferenceError,
	bindingTypesFor,
	compileBindleManifest,
	data as wiringData,
	service as wiringService,
} from "./wiring/index.js";

// public-contract: package identity used by generated manifests and tooling.
export const HOBO_BINDLES_PACKAGE = "@hobo/bindles";

export type {
	ManifestHash,
	ManifestReference,
	ManifestV1,
	OutputPlaceholder,
} from "./manifest/index.js";
export {
	aspireFallbackEnv,
	canonicalManifestHash,
	MANIFEST_SCHEMA,
	ManifestParseError,
	parseManifest,
	parseManifestReference,
	parseOutputPlaceholder,
	serializeManifest,
} from "./manifest/index.js";
