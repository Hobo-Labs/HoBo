// Re-export pure naming / tenancy from core so consumers can depend on one package.
export {
	createMeteringBus,
	createUsageEvent,
	DEFAULT_LOCAL_TLD,
	DEFAULT_OMITTED_ENV,
	DEFAULT_OVERLAY_TLD,
	getNamedEndpoint,
	getNamedEndpointHost,
	HOBO_ZONE_LABEL,
	isHoboHierarchicalName,
	LOCAL_DEFAULT_TENANT_ID,
	parseTenantId,
	sanitizeDnsLabel,
	type TenantIsolationMode,
	tenantContextFromEnv,
} from "@hobo/core";
export {
	type ConnectivityConfig,
	DEFAULT_CONNECTIVITY_CONFIG,
	parseConnectivityConfig,
} from "./config.js";
export {
	CONNECTIVITY_HOST_PROVIDER_NAME,
	type ConnectivityHostHandler,
	type ConnectivityHostRequest,
	type ConnectivityHostResponse,
	createConnectivityHostHandler,
} from "./connectivity-host.js";
export {
	type AwsCredentials,
	createRoute53SigV4Signer,
	hmac,
	type SignAwsRequestInput,
	type SignedAwsRequest,
	sha256Hex,
	signAwsRequest,
} from "./dns/aws-sigv4.js";
export {
	type CloudflareDnsProviderOptions,
	createCloudflareDnsProvider,
} from "./dns/cloudflare-provider.js";
export {
	createDnsControlProvider,
	type DnsControlPlan,
} from "./dns/dnscontrol-provider.js";
export {
	createJunctionDynamicDnsRegistrar,
	type DynamicDnsRegistrationResult,
	type DynamicDnsTarget,
	type JunctionDynamicDnsRegistrar,
} from "./dns/dynamic-registrar.js";
export { createMemoryDnsProvider } from "./dns/memory-provider.js";
export { createPublicDnsManager } from "./dns/public-dns-manager.js";
export {
	createDnsProviderFromConfig,
	createRoute53DnsProvider,
	parseListResourceRecordSets,
	type Route53DnsProviderOptions,
} from "./dns/route53-provider.js";
// Environment network isolation + elevated access + break-glass (ADR-0133).
export * from "./env-isolation/index.js";
export {
	createJunctionAgent,
	type JunctionAgent,
	type JunctionAgentConfig,
	type JunctionAgentRole,
} from "./junction-agent.js";
export {
	attachNamedEndpoints,
	createNamedPreferringBindingResolver,
	getNamedEndpointSession,
	listNamedEndpointSessions,
	type NamedEndpointEntry,
	type NamedEndpointInput,
	type NamedEndpointsResult,
	resourceId,
} from "./local/named-endpoints.js";
export {
	type PortlessMode,
	type PortlessProbe,
	probePortless,
	registerPortlessRoute,
	resolvePortlessMode,
} from "./local/portless.js";
export {
	type BillingAggregator,
	type BillingPeriodBucket,
	createBillingAggregator,
	type Invoice,
	type InvoiceLine,
	invoiceToUsageEvents,
	type PriceBook,
} from "./metering/billing-aggregator.js";
export {
	type BillingChargeResult,
	type BillingChargeStatus,
	type BillingProvider,
	createFileInvoiceLedger,
	createLedgerBillingProvider,
	createStripeBillingProvider,
	exportInvoiceStripeLines,
	type InvoiceLedger,
} from "./metering/billing-provider.js";
export {
	createInMemoryMeteringSink,
	createLogMeteringSink,
} from "./metering/sinks.js";
// HoBo Fleet (ADR-0182): the overlay credential minters (L39); the overlay transport is below.
export {
	createNetbirdCredentialMinter,
	createTailscaleCredentialMinter,
	type OverlayMinterOptions,
} from "./minters/index.js";
export { createNetbirdOverlay } from "./overlay/netbird.js";
export {
	createNetbirdApiClient,
	type NetbirdApiClient,
	type NetbirdApiOptions,
	type NetbirdDnsNameserverGroup,
	type NetbirdPeer,
} from "./overlay/netbird-api.js";
export {
	createTailscaleOverlay,
	parseTenantTag,
	type TailscaleRunner,
} from "./overlay/tailscale.js";
export {
	createTailscaleApiClient,
	type TailscaleApiClient,
	type TailscaleApiOptions,
	type TailscaleSplitDnsMap,
} from "./overlay/tailscale-api.js";
export { createOverlayTransport } from "./overlay-transport.js";
// Privileged Access Gateway (optional Station capability) — full secretless brokers.
export * from "./pam/index.js";
export {
	createOpaPolicyEngine,
	defaultRegoLikeEval,
	OPA_POLICY_ENGINE_ID,
	type OpaPolicyEngineOptions,
	SAMPLE_HOBO_AUTHZ_REGO,
} from "./policy/opa-engine.js";
export {
	ENV_NETWORK_ISOLATION_REGO_DOCUMENT,
	evaluateRegoLite,
	HOBO_DEFAULT_POLICY_DOCUMENT,
	parseRegoLiteDocument,
	type RegoLiteDocument,
	type RegoLiteRule,
	type RegoLiteWhen,
} from "./policy/rego-lite.js";
export {
	createTagAclPolicyEngine,
	TAG_ACL_POLICY_ENGINE_ID,
	type TagAclPolicyEngineOptions,
} from "./policy/tag-acl-engine.js";
export {
	createSecretlessConnector,
	type IsolationTier,
	openMysqlSecretlessLease,
	openPostgresSecretlessLease,
	openRedisSecretlessLease,
	type SecretlessConnector,
	type SecretlessLease,
	type SecretlessProtocol,
} from "./secretless/connector.js";
export {
	createPluginRegistry,
	mysqlPlugin,
	type ProtocolPlugin,
	postgresPlugin,
	redisPlugin,
	type SecretlessProtocolId,
	tcpPlugin,
} from "./secretless/plugins.js";
export {
	createTenantIsolationRegistry,
	type TenantControlPlanePartition,
	type TenantIsolationRegistry,
	type TenantIsolationRegistryOptions,
	type TenantOverlayPlane,
	type TenantOverlays,
	tenantFromSlug,
} from "./tenancy/isolation.js";
export {
	type CloudflareTrafficRouting,
	type CloudflareTrafficRoutingOptions,
	createCloudflareTrafficRouting,
} from "./traffic-routing/cloudflare.js";
export {
	createFunnelTrafficRouting,
	type FunnelTrafficRouting,
	type FunnelTrafficRoutingOptions,
} from "./traffic-routing/funnel.js";
export {
	buildTrafficRouteProgram,
	createLakebedTrafficRouting,
	type LakebedTrafficDeployOptions,
	type LakebedTrafficDriverProgram,
	type LakebedTrafficRouting,
	type LakebedTrafficRoutingOptions,
} from "./traffic-routing/lakebed.js";
export {
	BUILTIN_TRAFFIC_ROUTING_PROFILES,
	CLOUDFLARE_TRAFFIC_ROUTING_PROFILE,
	FUNNEL_TRAFFIC_ROUTING_PROFILE,
	LAKEBED_TRAFFIC_ROUTING_PROFILE,
	SIMPLE_TRAFFIC_ROUTING_PROFILE,
	VERCEL_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing/profiles.js";
export {
	createSimpleTrafficRouting,
	type SimpleTrafficRouting,
} from "./traffic-routing/simple.js";
export {
	createVercelTrafficRouting,
	type VercelTrafficMode,
	type VercelTrafficRouting,
	type VercelTrafficRoutingOptions,
} from "./traffic-routing/vercel.js";
