export {
	ATTESTATION_SCHEMA_VERSION,
	type AttestationDocument,
	type AttestationVerdict,
	createFixtureHostAttestor,
	type LaunchMeasurement,
	type PrincipalRef,
	verifyWorkloadAttestation,
} from "./attestation.js";
// Continuous Identity Migration Plane (hands-off; zero Bindle config required).
export {
	CAN_MIGRATE_SCHEMA_VERSION,
	type CanMigrateInput,
	type CanMigrateReason,
	type CanMigrateResult,
	evaluateCanMigrate,
} from "./can-migrate.js";
export {
	createContractAssertedConfigFixtures,
	type DevConfigFixture,
} from "./config-dev-fixtures.js";
export {
	type ConfigResolutionResult,
	type ConfigResolverOptions,
	resolveConfigSchema,
} from "./config-resolver.js";
export type {
	ConfigFieldDef,
	ConfigSchema,
	SecretSourceRank,
} from "./config-types.js";
export {
	type AuthorizeConnectionInput,
	CONNECTION_SCHEMA_VERSION,
	type ConnectionPolicyDecision,
	type ConnectionPolicyGate,
	type ConnectionRecord,
	ConnectionService,
	type ConnectionView,
	type CreateConnectionInput,
	defaultConnectionPolicyGate,
	foldConnectionEvents,
} from "./connection.js";
export {
	CONNECTION_EVENT_SCHEMA_VERSION,
	CONNECTION_EVENTS,
	type ConnectionEvent,
	type ConnectionEventType,
	type ConnectionFlow,
	type ConnectionPrincipalRef,
	type ConnectionStatus,
	createConnectionAuthorizationStartedEvent,
	createConnectionAuthorizedEvent,
	createConnectionCreatedEvent,
	createConnectionHealthChangedEvent,
	createConnectionRevokedEvent,
	createConnectionRotatedEvent,
	createConnectionTokenIssuedEvent,
	isConnectionEventType,
	validateConnectionEvent,
} from "./connection-events.js";
export {
	type AdapterClaims,
	agentRebindHint,
	type DualAudienceGrant,
	type DualVerifyResult,
	dualConsistencyDigest,
	dualVerifyClaims,
	mintDualAudienceGrant,
	verifyDualAudienceGrant,
} from "./dual-adapter.js";
export {
	createDevEvaluationContext,
	enrichEvaluationContext,
	type HoBoScopeAttributes,
	type PrincipalRefLike,
} from "./evaluation-context.js";
export {
	CREDENTIAL_AUDIT_RETENTION,
	createIdentityIssuedEvent,
	createIdentityRotatedEvent,
	createTokenGrantedEvent,
	createTokenRevokedEvent,
	createTokenUsedEvent,
	IDENTITY_EVENT_SCHEMA_VERSION,
	type IdentityEvent,
	TOKEN_EVENT_SCHEMA_VERSION,
	type TokenEvent,
	type TokenScope,
	validateIdentityEvent,
	validateTokenEvent,
} from "./events.js";
export {
	FEATURE_FLAG_BACKEND_RANKS,
	type FeatureFlagBackendRank,
	type RankedBackend,
	selectFeatureFlagBackend,
} from "./feature-flag-ranking.js";
export {
	bucket,
	createMigrationFlagId,
	type DetailEvaluation,
	FEATURE_FLAG_PORT,
	FeatureFlagStore,
	FLAG_EVENT_SCHEMA_VERSION,
	FLAG_EVENTS,
	type FlagDefinition,
	type FlagDefinitionInput,
	type FlagEvalContext,
	type FlagEvaluation,
	type FlagEvent,
	type FlagEventType,
	type FlagState,
	type FlagTargeting,
	type FlagValue,
	type FractionalVariant,
	migrationCohortFlagKey,
	pickFractionalVariant,
} from "./feature-flag-store.js";
export {
	applyPolicyGatedDefine,
	classifyFlagMutationRisk,
	FLAG_CHANGE_ACTION,
	FLAG_POLICY_SCHEMA,
	type FlagMutationDecision,
	type FlagMutationEffect,
	type FlagMutationObligation,
	type FlagMutationRequest,
	type FlagMutationRiskReason,
	gateFlagMutation,
	ROLLOUT_START_ACTION,
} from "./flag-policy.js";
export {
	applyRolloutToGatewayRouting,
	composeGatewayWeightFromRollout,
	DOMAIN_ROUTING_EVENTS,
	type DomainRoutingEvent,
	GATEWAY_WEIGHT_SCHEMA,
	type TrafficWeightSplit,
	trafficWeightSplitFromPercent,
} from "./gateway-weight.js";
export {
	analyzeExperimentFromEngine,
	createBuiltinDeliveryAdapter,
	createBuiltinExperimentAnalysis,
	createCdResidualDeliveryAdapter,
	createMediatedFlagEvaluator,
	createOfrepResidualBackend,
	createResidualExperimentAnalysis,
	DELIVERY_ADAPTER_SCHEMA,
	type DeliveryAdapter,
	type DeliveryAdapterKind,
	EXPERIMENT_ANALYSIS_SCHEMA,
	type ExperimentAnalysisPort,
	type ExperimentAnalysisResult,
	type MediatedFlagEvaluator,
	OFREP_RESIDUAL_SCHEMA,
	selectDeliveryAdapter,
} from "./harness-adapters.js";
export {
	createHarness,
	HARNESS_SCHEMA,
	Harness,
	type HarnessPorts,
	type ProgressiveRun,
} from "./harness-compose.js";
export {
	applyRolloutEvent,
	contentHashRollout,
	DELIVERY_PORT,
	type DeliveryHealthSignal,
	OpenDeliveryEngine,
	ROLLOUT_EVENT_SCHEMA,
	ROLLOUT_EVENTS,
	type RolloutEvent,
	type RolloutPendingApproval,
	type RolloutPolicy,
	type RolloutResumePoint,
	type RolloutStage,
	type RolloutState,
	type RolloutTargetGroup,
	type RolloutTargetOutcome,
	replayRolloutJournal,
	type StagedRolloutProgress,
} from "./harness-delivery.js";
export {
	createExperimentId,
	EXPERIMENT_EVENT_SCHEMA,
	EXPERIMENT_EVENTS,
	EXPERIMENT_PORT,
	type ExperimentAssignment,
	type ExperimentDefinition,
	type ExperimentEvent,
	OpenExperimentEngine,
} from "./harness-experiment.js";
export {
	createContractAssertedHarnessFixtures,
	type LocalHarnessFixtures,
} from "./harness-fixtures.js";
export {
	type AdapterVerifyResult,
	ContractAssertedIdentityAdapter,
	createDualAdapterPair,
	type DualAdapterPair,
	IDENTITY_ADAPTER_INTERFACE,
	type IdentityAdapter,
	type IdentityAdapterKind,
	verifyDualAdapters,
} from "./identity-adapter-port.js";
export {
	type ActiveSvidRecord,
	type GatewayAuthResult,
	IDENTITY_BOUNDARY_SCHEMA,
	IdentityService,
	type IssueSvidResult,
	type RotateSvidResult,
	type ScopeEntry,
} from "./identity-service.js";
export {
	createInMemoryKms,
	type JsonWebKeySet,
	JWT_ALGORITHM,
	type JwtSvidClaims,
	JwtSvidIssuer,
	type KmsLike,
	type OidcDiscovery,
	verifyJwtWithJwks,
} from "./issuer.js";
export {
	decryptLocalOverrides,
	encryptLocalOverrides,
	type LocalOverrideFile,
} from "./local-overrides.js";
export {
	applyClaimTransform,
	type ClaimMapping,
	defaultContinuousMappingSpec,
	MAPPING_SPEC_SCHEMA_VERSION,
	type MappingSpec,
	type MappingSpecInput,
	parseMappingSpec,
} from "./mapping-spec.js";
export {
	foldIdentityMigrationEvents,
	IDENTITY_MIGRATION_SCHEMA,
	type IdentityMigrationRecord,
	IdentityMigrationService,
	type MigrationMode,
	type MigrationReason,
	type MigrationState,
	type PrincipalLink,
	type StartMigrationInput,
} from "./migration-aggregate.js";
export {
	type ControlPlaneProgress,
	IDENTITY_MATCH_DECIDED,
	type IdentityMatchDecidedAudit,
	IdentityMigrationControlPlane,
	matchingSignalsFromResourceDecision,
	startContinuousMigrationFromMatch,
} from "./migration-control-plane.js";
export {
	createContractAssertedDualFixtures,
	DUAL_FIXTURE_FIDELITY,
	type DualIdentityFixtures,
} from "./migration-dual-fixtures.js";
export {
	createDualConsistencyCheckedEvent,
	createDualLinkedEvent,
	createMigratedEvent,
	createMigrationAbortedEvent,
	createMigrationCompensatedEvent,
	createMigrationCutoverEvent,
	createMigrationProgressedEvent,
	createMigrationStartedEvent,
	createShadowVerifiedEvent,
	IDENTITY_MIGRATION_EVENT_SCHEMA,
	IDENTITY_MIGRATION_EVENTS,
	type IdentityMigrationEvent,
	type IdentityMigrationEventType,
	isIdentityMigrationEventType,
	validateIdentityMigrationEvent,
} from "./migration-events.js";
export {
	advanceMigrationRamp,
	createMigrationCohortFlag,
	MIGRATION_COHORT_FLAG_SCHEMA,
	type MigrationCohortFlag,
	principalInMigrationCohort,
} from "./migration-harness.js";
export {
	decideIdentityMigration,
	IDENTITY_MIGRATION_MATCH_SCHEMA,
	type IdentityMigrationMatchDecision,
	type MatchingMigrationInput,
} from "./migration-matching.js";
export {
	type AgentRebindAction,
	agentActionsForMigrationEvents,
	isMigrationReactiveEvent,
	type MigrationStatusView,
	migrationStatusView,
} from "./migration-observe.js";
export {
	createLocalFeatureClient,
	HOBO_OPENFEATURE_PROVIDER_NAME,
	HoboFeatureClient,
	HoboOpenFeatureProvider,
	type OpenFeatureResolutionDetails,
} from "./openfeature-provider.js";
export {
	IDENTITY_INTERFACE,
	IDENTITY_PORT,
	type IdentityProvider,
} from "./port.js";
export {
	assertNoPlaintextConformance,
	type PlaintextConformanceResult,
	type PlaintextScanHit,
	requireNoPlaintextConformance,
} from "./secrets-conformance.js";
export {
	assertNoPlaintextInEvent,
	CONFIG_SECRET_EVENT_SCHEMA,
	type ConfigSecretEvent,
	createConfigResolvedEvent,
	createSecretAccessedEvent,
} from "./secrets-events.js";
export {
	asHoboSecretsStore,
	type ConfigSensitivity,
	createAwsSecretsManagerPort,
	createAwsSecretsManagerStub,
	createAzureKeyVaultPort,
	createAzureKeyVaultStub,
	createCampSecretsPort,
	createLocalStationSecretsPort,
	createMemorySecretsPort,
	createVaultJwtSecretsPort,
	type FetchLike,
	type ResolutionLadderInput,
	type ResolvedConfigEntry,
	resolveConfigEntry,
	type SecretsAccessResult,
	type SecretsPort,
} from "./secrets-port.js";
export {
	createMemoryFencePort,
	createMemoryTenantTransferPort,
	type FencePort,
	runSpectrumIdentityCutover,
	SPECTRUM_CUTOVER_SCHEMA,
	type SpectrumCutoverResult,
	type TenantExportImportPort,
	type TenantLifecycleEvent,
	type TenantLifecyclePhase,
} from "./spectrum-cutover.js";
export {
	BROKER_OIDC_ASSERTION_TTL_SECONDS,
	type BrokeredCredentialSource,
	createInMemoryProviderStsExchange,
	createInMemoryVault,
	type ExchangedProviderCredential,
	type GrantTokenResult,
	mintOidcFederationAssertion,
	type OidcFederationAssertion,
	type ProviderStsExchange,
	type RevokeTokenResult,
	type ScopedTokenGrant,
	type StsExchangeRequest,
	type StsExchangeResult,
	TOKEN_BROKER_DEFAULT_TTL_SECONDS,
	TokenBroker,
	type UseTokenResult,
	type VaultedCredential,
} from "./token-broker.js";

// public-contract: the package id consumers assert against.
export const HOBO_IDENTITY_PACKAGE = "@hobo/identity";
