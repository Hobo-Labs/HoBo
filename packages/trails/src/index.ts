export {
	TRAIL_RUN_STATES,
	type TrailRunRecord,
	TrailRunService,
	type TrailRunState,
} from "./aggregate.js";
export {
	CAN_TRAIL_SCHEMA_VERSION,
	type CanTrailInput,
	type CanTrailPolicyVerdict,
	type CanTrailReason,
	type CanTrailResult,
	evaluateCanTrail,
} from "./can-trail.js";
export type { DataDualPort, LiveDataDualPort } from "./data-dual-port.js";
export {
	applySchemaStep,
	createContractAssertedDataDualFixtures,
	DATA_DUAL_SCHEMA,
	type DataDualEvidence,
	type DataDualFixture,
	type DataDualResult,
	type DataDualView,
	evaluateDataDual,
	evaluateDataDualEvidence,
	type SchemaApplyResult,
} from "./data-steps.js";
export {
	defineTrail,
	orderTrailSteps,
	TRAIL_DATA_PATTERNS,
	TRAIL_DEFINITION_SCHEMA,
	type TrailDataPattern,
	type TrailDefinition,
	type TrailDefinitionInput,
	type TrailStep,
	type TrailStepKind,
	wireTrailPhaseDependencies,
} from "./definition.js";
export {
	createTrailEvent,
	TRAIL_EVENT_SCHEMA,
	TRAIL_EVENTS,
	type TrailEvent,
	type TrailEventType,
} from "./events.js";
export {
	createContractAssertedTrailFixtures,
	type LocalTrailFixtures,
} from "./fixtures.js";
export {
	goldenCompensation,
	goldenDualConsistency,
	goldenFailClosed,
	goldenHistoryIdempotent,
	goldenIdentityHandsOff,
	goldenJunctionIntegrity,
	goldenProgressiveAbort,
	goldenZeroLoss,
	runTrailGoldenSuite,
	TRAIL_GOLDEN_SCHEMA,
	type TrailGoldenOracleId,
	type TrailGoldenVerdict,
} from "./golden.js";
export {
	stepChecksum,
	TRAIL_HISTORY_SCHEMA,
	type TrailHistoryEntry,
	TrailHistoryStore,
} from "./history.js";
export {
	activateIdentityContinuousFromMatching,
	advanceIdentityTrailRamp,
	assertIdentityContinuousHandsOff,
	createHandsOffIdentityTrail,
	IDENTITY_TRAIL_SCHEMA,
	type IdentityTrailHandle,
	type TrailCanMigrateEvidence,
	type TrailIdentityFixturesView,
	type TrailIdentityProgress,
} from "./identity-trail.js";
export {
	type CompatGateEvidence,
	type DataMigrationJournal,
	type DataMigrationPlan,
	type DataMigrationPolicyVerdict,
	type DataMigrationResult,
	type DataMigrationStatus,
	type ExecuteDataMigrationOptions,
	executeDataMigration,
	MIGRATION_EVENTS,
	MIGRATION_EXECUTOR_SCHEMA,
	type MigrationFact,
} from "./migration-executor.js";
export {
	composeTrailWithRecipes,
	expandRecipes,
	getPlatformRecipe,
	identityContinuousTrail,
	listPlatformRecipes,
	PLATFORM_RECIPES,
	type PlatformRecipe,
	type PlatformRecipeId,
} from "./recipes.js";
export {
	TRAIL_RUNNER_SCHEMA,
	type TrailPlanEvidence,
	TrailRunner,
	type TrailRunnerOptions,
	type TrailRunResult,
} from "./runner.js";
export type {
	PortResult,
	SchemaApplyPort,
	SchemaPhase,
	SchemaPhaseResult,
	SchemaSnapshotRef,
} from "./schema-apply-port.js";
export {
	type CreateTenantMovePortsOptions,
	createTenantMovePorts,
	TENANT_MOVE_SCHEMA,
	type TenantFencePort,
	type TenantMovePorts,
	type TenantTransferPort,
} from "./tenant-move-port.js";
export {
	assertUpgradeScopeBoundary,
	COMPATIBILITY_INPUT_MATRIX,
	type CompatibilityInputs,
	classifyUpgradeDryRunDecision,
	evaluateUpgradeDryRun,
	parseCompatibilityInputs,
	parseRollbackEvidence,
	type RollbackEvidence,
	type SupportHandoffRecord,
	stableDigest,
	UPGRADE_DRY_RUN_FIXTURES,
	UPGRADE_DRY_RUN_SCHEMA,
	UPGRADE_SCOPE_BOUNDARIES,
	type UpgradeDryRunReport,
	type UpgradeDryRunRequest,
	UpgradePreflightParseError,
} from "./upgrade-preflight.js";

// public-contract: package id consumers assert against.
export const HOBO_TRAILS_PACKAGE = "@hobo/trails";
