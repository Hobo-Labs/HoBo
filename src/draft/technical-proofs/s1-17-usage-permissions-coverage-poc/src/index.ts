export { createResourceHandle, type AllowFacts, type ResourceHandle, type ResourceVerb } from "./allow.js";
export {
  appendGateEvent,
  createGateEventLog,
  resetGateEventSeq,
  type GateEvent,
  type GateEventLog,
} from "./events.js";
export {
  analyzeDeclaredResources,
  assertCanDeployCollectionCoverage,
  CollectionCoverageError,
  evaluateCollectionCoverage,
  reconcileCollectionCoverage,
  type CoverageDiagnostic,
  type CoverageEvaluationResult,
  type CoverageResult,
  type DeclaredBind,
  type DeclaredResource,
} from "./collection-coverage.js";
export {
  buildUsagePermissionManifest,
  parseUsagePermissionInput,
  PermissionContractError,
  projectPermissionTriple,
  type AllowEntry,
  type AllowProvenance,
  type CapabilityContract,
  type LoweredResourcePermission,
  type ParsedUsagePermissionInput,
  type PermissionManifestResult,
  type PermissionTriple,
  type ResourceLink,
  type ResourcePermissionInput,
  type UsagePermissionInput,
  type UsagePermissionManifest,
} from "./usage-permissions.js";
