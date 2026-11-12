export {
	createHostAssetClient,
	errorForHostResponse,
	type FetchedComponent,
	type HostAssetClient,
	type HostAssetClientOptions,
} from "./client.js";
export {
	type AbsentTrafficOffering,
	defineHostingCoverage,
	HOSTING_COVERAGE_CONTRACT,
	type HostingCoverage,
	hostingProductRefusal,
	instrumentResolvers,
	PORTABLE_TRAFFIC_OFFERING_IDS,
	RESOLVER_DURATION_METRIC,
	RESOLVER_OPERATIONS_METRIC,
	type ResolverMetricPoint,
	type ResolverMetricSink,
	type ResolverTelemetryOptions,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
export {
	CLEANUP_STATES,
	type CleanupOutcome,
	type CleanupState,
	GUEST_PHASES,
	type GuestHandle,
	type GuestPhase,
	negotiatePersistence,
	orphanedGuest,
	type ProvisionReceipt,
	provisionGuest,
	RECEIPT_SCHEMA_VERSION,
	releaseGuest,
} from "./driver.js";
export {
	browserWasmNativePorts,
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
} from "./equivalence.js";
export {
	BROWSER_WASM_ERROR_CODES,
	type BrowserWasmErrorCode,
	BrowserWasmProviderError,
	isBrowserWasmProviderError,
	redactHostText,
} from "./errors.js";
export {
	BROWSER_WASM_GUEST_PRODUCT_ID,
	type BrowserWasmResolverOptions,
	browserWasmResolverRegistry,
	createBrowserWasmResolvers,
} from "./guest-resolver.js";
export {
	createUnavailableRuntime,
	type GuestRuntimePort,
	type InstantiatedGuest,
	type InstantiateInput,
	type TerminateInput,
	type TerminationResult,
} from "./host-runtime.js";
export {
	BROWSER_WASM_HOSTING_COVERAGE,
	BROWSER_WASM_RESOLVED_PRODUCT_IDS,
	BROWSER_WASM_UNRESOLVED_PRODUCTS,
	browserWasmProductRefusal,
} from "./hosting-coverage.js";
export {
	COMPONENT_MEDIA_TYPE,
	type ComponentArtifact,
	createWebCryptoDigest,
	type DigestPort,
	GUEST_MANIFEST_SCHEMA,
	GUEST_PORTS,
	type GuestManifest,
	type GuestPort,
	HOST_CAPABILITIES_SCHEMA,
	HOST_FAULT_SCHEMA,
	type HostCapabilities,
	type HostFault,
	isComponentPreamble,
	MAX_COMPONENT_BYTES,
	MAX_MEMORY_LIMIT_BYTES,
	MIN_COMPONENT_BYTES,
	MIN_MEMORY_LIMIT_BYTES,
	PERSISTENCE_MODES,
	type PersistenceMode,
	parseGuestManifest,
	parseHostCapabilities,
	parseHostFault,
	RESOURCE_CLASS_FOR_PORT,
	verifyComponentArtifact,
	WASM_PAGE_BYTES,
} from "./manifest.js";
export {
	browserWasm,
	PROVIDER_TARGET,
	type TypedOptionBlock,
} from "./options.js";
export {
	DEFAULT_EPOCH_DEADLINE_MS,
	DEFAULT_MEMORY_LIMIT_BYTES,
	DEFAULT_WORLD,
	type GuestPlacement,
	guestManifestPath,
	HOST_CAPABILITIES_PATH,
	MAX_EPOCH_DEADLINE_MS,
	parseGuestPlacement,
	type RequestedPersistence,
} from "./placement.js";
export { createBrowserWasmProvider } from "./provider.js";
export {
	provisionTemporaryEnvironmentStation,
	supportsAnonymousTemporaryDeploy,
} from "./temporary-station.js";
export {
	BROWSER_WASM_TRAFFIC_ROUTING_ABSENT,
	BROWSER_WASM_TRAFFIC_ROUTING_OFFERING_IDS,
	BROWSER_WASM_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";
export {
	assertSameOriginAsset,
	createFetchTransport,
	createGuardedTransport,
	DEFAULT_MAX_BUNDLE_BYTES,
	decodeText,
	defaultTransportPolicy,
	HOST_ROUTE_PREFIX,
	type HostAssetTransport,
	headerOf,
	type TransportPolicy,
	type TransportRequest,
	type TransportResponse,
} from "./transport.js";
export type {
	Capability,
	CapabilityManifest,
	CloudProvider,
	ResourcePlan,
} from "./types.js";

// public-contract: package identity used by generated catalogs.
export const HOBO_PROVIDER_BROWSER_WASM_PACKAGE = "@hobo/provider-browser-wasm";
