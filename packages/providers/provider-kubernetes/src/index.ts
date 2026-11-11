export {
	type ApiStatus,
	type DeploymentRecord,
	NAMESPACE_PHASES,
	type NamespacePhase,
	type NamespaceRecord,
	parseApiStatus,
	parseDeploymentRecord,
	parseNamespaceRecord,
	parseServiceRecord,
	ROLLOUT_PHASES,
	type RolloutPhase,
	rolloutPhaseFor,
	type ServiceRecord,
} from "./api.js";
export {
	APPS_PATH,
	createKubernetesApiClient,
	errorForApiResponse,
	type KubernetesApiClient,
	type KubernetesApiClientOptions,
	NAMESPACES_PATH,
} from "./client.js";
export {
	KUBERNETES_DEFAULT_BINDINGS,
	type KubernetesSlotCatalog,
	type KubernetesYardBindingRow,
	type KubernetesYardSpec,
	type KubernetesYardSpecOptions,
	kubernetesYardSpec,
} from "./default-yard.js";
export {
	CLEANUP_STATES,
	type CleanupOutcome,
	type CleanupState,
	cleanupWorkload,
	observeRollout,
	type ProvisionReceipt,
	provisionWorkload,
	RECEIPT_SCHEMA_VERSION,
} from "./driver.js";
export {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
	kubernetesNativePorts,
} from "./equivalence.js";
export {
	isKubernetesProviderError,
	KUBERNETES_ERROR_CODES,
	type KubernetesErrorCode,
	KubernetesProviderError,
	redactClusterText,
} from "./errors.js";
export {
	assertLocalIacProgram,
	IAC_PROGRAM_API_VERSION,
	IAC_PROGRAM_KIND,
	IAC_PROVIDER,
	type IacProgram,
	type IacResource,
	KUBERNETES_IAC_PROVIDER,
} from "./iac-program.js";
export {
	AUTH_SCHEMA,
	CAPABILITIES_SCHEMA,
	COST_FACTS,
	COST_SCHEMA,
	DEFAULT_REGIONS,
	KUBERNETES_PROVIDER_ID,
	type KubernetesManifestInput,
	MANIFEST_SCHEMA,
	type PublishedManifestDocuments,
	type PublishedManifestParseResult,
	parsePublishedManifest,
	publishCapabilityManifest,
} from "./manifest.js";
export {
	kubernetes,
	PROVIDER_TARGET,
	type TypedOptionBlock,
} from "./options.js";
export {
	clusterDnsName,
	clusterEndpointUrl,
	formatMemoryQuantity,
	MAX_SURGE,
	PROVIDER_RESOURCE_CLASS,
	parseCpuMillicores,
	parseMemoryBytes,
	parseWorkloadPlacement,
	type ResourceQuantity,
	renderDeploymentManifest,
	renderNamespaceManifest,
	renderServiceManifest,
	SERVICE_PORT,
	type WorkloadPlacement,
} from "./placement.js";
export {
	createKubernetesProvider,
	type KubernetesProviderOptions,
	kubernetesDriverProgram,
} from "./provider.js";
export {
	type BuildSpec,
	isRealizablePort,
	mergeKubernetesOptions,
	type RealizablePort,
	realizeResourcePlan,
	realizeResourcePlans,
	resolveEquivalence,
} from "./realize.js";
export {
	type ApiServerEndpoint,
	guardedKubernetesTransport,
	kubernetesResolverPolicy,
	kubernetesResolverUrl,
	parseApiServerEndpoint,
	parseApiServerHost,
	RESOLVER_ALLOWED_PATH_PREFIXES,
	RESOLVER_MAX_RESPONSE_BYTES,
	RESOLVER_MAX_TIMEOUT_MS,
} from "./resolver-transport.js";
export {
	KUBERNETES_CRONJOB_PRODUCT_ID,
	KUBERNETES_DAEMONSET_PRODUCT_ID,
	KUBERNETES_DEPLOYMENT_PRODUCT_ID,
	KUBERNETES_INGRESS_PRODUCT_ID,
	KUBERNETES_JOB_PRODUCT_ID,
	KUBERNETES_PVC_PRODUCT_ID,
	KUBERNETES_RESOLVED_PRODUCT_IDS,
	KUBERNETES_SECRET_PRODUCT_ID,
	KUBERNETES_SERVICE_PRODUCT_ID,
	KUBERNETES_STATEFULSET_PRODUCT_ID,
	KUBERNETES_UNRESOLVED_PRODUCT_IDS,
	type KubernetesResolverOptions,
	kubernetesResolverRegistry,
	kubernetesResolvers,
} from "./resolvers.js";
export {
	type CronJobOptions,
	cronJob,
	type DaemonSetOptions,
	type DeploymentOptions,
	daemonSet,
	deployment,
	deploymentWorker,
	type IngressOptions,
	ingress,
	type JobOptions,
	job,
	type PersistentVolumeClaimOptions,
	persistentVolumeClaim,
	type ResourceQuantities as SlotResourceQuantities,
	SERVICE_TYPES,
	type SecretOptions,
	type ServiceOptions,
	type ServiceType,
	type StatefulSetOptions,
	secret,
	service,
	statefulSet,
	statefulSetWorker,
} from "./slots.js";
export {
	provisionTemporaryEnvironmentStation,
	supportsAnonymousTemporaryDeploy,
} from "./temporary-station.js";
export {
	KUBERNETES_TRAFFIC_ROUTING_OFFERING_IDS,
	KUBERNETES_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";
export {
	assertAllowedEndpoint,
	createFetchTransport,
	createGuardedTransport,
	DEFAULT_TRANSPORT_POLICY,
	type KubernetesTransport,
	type TransportMethod,
	type TransportPolicy,
	type TransportRequest,
	type TransportResponse,
} from "./transport.js";
export type {
	Capability,
	CapabilityManifest,
	CloudProvider,
	CostSignal,
	Match,
	Outputs,
	PortKind,
	PortRequest,
	ProviderClient,
	ResourcePlan,
} from "./types.js";
export {
	KUBERNETES_YARD_GENERATOR_CONNECTOR_ID,
	KUBERNETES_YARD_RUNTIME_ID,
	kubernetesDefaultResolverPins,
	kubernetesYardRuntimeRegistration,
} from "./yard-defaults.js";
export {
	KUBERNETES_EVENT_STORE_RESOLVER_ID,
	type KubernetesProviderNativeSignal,
	type KubernetesYardEvent,
	kubernetesEventStoreFoldDescriptor,
	normalizeKubernetesYardSignal,
} from "./yard-event-fold.js";

// public-contract: package identity used by generated catalogs.
export const HOBO_PROVIDER_KUBERNETES_PACKAGE = "@hobo/provider-kubernetes";
export { KUBERNETES_HOST_FORMS } from "./host-forms.js";
