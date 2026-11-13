/**
 * `@hobo/provider-oci-registry`: a generic OCI distribution registry realizer
 * (GHCR, Docker Hub, ECR, Artifact Registry, Harbor, Zot) on the core
 * `ResourceResolver` port. See `resolver.ts` for the convergence contract.
 */
export {
	createLatin1FetchTransport,
	declareLatin1Transport,
	HTTP_TRANSPORT_BODY_ENCODING,
	isLatin1Transport,
	ociLatin1Transport,
} from "./byte-transport.js";
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
	type ResolverMetricAttributes,
	type ResolverMetricPoint,
	type ResolverMetricSink,
	type ResolverTelemetryOptions,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
export {
	OCI_REGISTRY_HOSTING_COVERAGE,
	OCI_REGISTRY_RESOLVED_PRODUCT_IDS,
	OCI_REGISTRY_UNRESOLVED_PRODUCTS,
	ociRegistryProductRefusal,
} from "./hosting-coverage.js";
export {
	type Descriptor,
	type ParsedManifest,
	parseManifest,
	parseReferrers,
} from "./manifest.js";
export {
	DOCKER_MANIFEST_LIST,
	DOCKER_MANIFEST_V2,
	digestOf,
	MANIFEST_MEDIA_TYPES,
	OCI_IMAGE_INDEX,
	OCI_IMAGE_MANIFEST,
	OCI_REGISTRY_IMAGE_PRODUCT_ID,
	OCI_REGISTRY_PROVIDER_ID,
	physicalIdOf,
	referrersFallbackTag,
} from "./reference.js";
export {
	createOciRegistryResolvers,
	type OciArtifactStore,
	type OciRegistryResolverOptions,
	ociRegistryResolverRegistry,
} from "./resolver.js";
export {
	type OciRegistryCredential,
	type OciRegistryEndpoint,
	parseChallenge,
	type TransportBodyEncoding,
} from "./session.js";
export {
	OCI_REGISTRY_TRAFFIC_ROUTING_ABSENT,
	OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";
