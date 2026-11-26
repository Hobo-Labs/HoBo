import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const REQUIRED_OPERATIONS = [
  "plan",
  "apply-up",
  "inspect-run",
  "tail-logs",
  "import-adopt",
  "migrate",
  "rollback",
  "support-evidence-pack",
] as const;

export const REQUIRED_BOUNDARY_CASES = [
  "policy-denied",
  "contract-incompatible",
  "provider-capability-partial",
  "provider-capability-none",
  "stale-projection",
  "unknown-evidence",
  "non-reactive-sink",
  "destructive-migration-blocked",
] as const;

export const REQUIRED_ACCEPTANCE_DOMAIN_TERMS = [
  "DeploymentPlan",
  "Deployment Set",
  "Delta",
  "ResourceActorState",
  "GatekeeperDecision",
  "DriftReport",
  "RunProjection",
  "LogCursor",
  "MigrationPhase",
] as const;

type OperationId = (typeof REQUIRED_OPERATIONS)[number];
type BoundaryCase = (typeof REQUIRED_BOUNDARY_CASES)[number];

export type ProofMode = "reference-fixture" | "contract-fixture" | "projection-snapshot" | "support-safe-evidence";
export type RedactionClass = "public" | "tenant-safe" | "support-redacted";

export type ControlPlaneOperationContract = {
  readonly id: OperationId;
  readonly humanName: string;
  readonly cliCommand: string;
  readonly apiEndpoint: `/${string}`;
  readonly mcpTool: `hobo_${string}`;
  readonly requestContract: readonly string[];
  readonly responseContract: readonly string[];
  readonly domainTerms: readonly string[];
  readonly sharedResultEnvelope: true;
  readonly fixtureId: string;
};

export type ControlPlaneRefusalEnvelope = {
  readonly code: BoundaryCase;
  readonly trigger: string;
  readonly remediation: string;
  readonly proofMode: ProofMode;
  readonly fixtureId: string;
  readonly redactionClass: RedactionClass;
};

export type ControlPlaneContractFixtures = {
  readonly protobuf: "architecture/control_plane_api_resource_lifecycle_shapes.proto";
  readonly cue: "architecture/control_plane_api_resource_lifecycle_shapes.cue";
  readonly pact: "architecture/pacts/control_plane_api_resource_lifecycle_shapes.pact.json";
};

export type ControlPlaneApiResourceLifecycleProof = {
  readonly issue: "HOBO-569";
  readonly phase: "M1";
  readonly targetPackage: "src/draft/exp-proofs/api/control-plane-api-resource-lifecycle-shapes";
  readonly proofNote: "docs/design/proofs/control-plane-api-resource-lifecycle-shapes/README.md";
  readonly designRefs: readonly string[];
  readonly operations: readonly ControlPlaneOperationContract[];
  readonly refusalEnvelopes: readonly ControlPlaneRefusalEnvelope[];
  readonly contractFixtures: ControlPlaneContractFixtures;
  readonly scopeOut: readonly string[];
  readonly __brand: "ParsedControlPlaneApiResourceLifecycleProof";
};

type UnparsedControlPlaneApiResourceLifecycleProof = Omit<
  ControlPlaneApiResourceLifecycleProof,
  "__brand"
>;

const commonResultFields = [
  "status",
  "proofMode",
  "fixtureId",
  "correlationId",
  "redactionClass",
  "warnings",
  "refusal",
] as const;

export const CONTROL_PLANE_API_RESOURCE_LIFECYCLE_PROOF = {
  issue: "HOBO-569",
  phase: "M1",
  targetPackage: "src/draft/exp-proofs/api/control-plane-api-resource-lifecycle-shapes",
  proofNote: "docs/design/proofs/control-plane-api-resource-lifecycle-shapes/README.md",
  designRefs: [
    "docs/design/control-plane.md#plan-04",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/cli-spec.md",
    "docs/design/platform-engineering.md#plan-25",
    "docs/design/authoring-resources-wiring.md#plan-21",
    "docs/design/contracts-policy-flags.md#plan-29",
    "docs/design/data-plane.md#plan-11",
    "docs/design/upgrade-migration-engine.md",
    "docs/design/adr/03-data-plane.md#adr-0014",
    "docs/design/adr/02-identity-security.md#adr-0015",
  ],
  operations: [
    {
      id: "plan",
      humanName: "Build a DeploymentPlan without mutation",
      cliCommand: "hobo plan --camp preview --json",
      apiEndpoint: "/control-plane/plan",
      mcpTool: "hobo_plan",
      requestContract: ["manifestRef", "campRef", "objective", "requestedBy", "proofMode"],
      responseContract: ["DeploymentPlan", "GatekeeperDecision", "PlanWarning[]", ...commonResultFields],
      domainTerms: ["DeploymentPlan", "ResourcePlan", "Gatekeeper", "match.Decided"],
      sharedResultEnvelope: true,
      fixtureId: "fixture.plan.preview.success",
    },
    {
      id: "apply-up",
      humanName: "Apply an accepted plan into a Deployment Set Delta",
      cliCommand: "hobo up --camp preview --json",
      apiEndpoint: "/control-plane/apply",
      mcpTool: "hobo_up",
      requestContract: ["deploymentPlanId", "approvalRef", "campRef", "expectedSetId", "dryRun"],
      responseContract: ["DeploymentSet", "Delta", "ResourceActorEvent[]", ...commonResultFields],
      domainTerms: ["Deployment Set", "Delta", "ResourceActor", "deployment.Planned"],
      sharedResultEnvelope: true,
      fixtureId: "fixture.apply.preview.accepted",
    },
    {
      id: "inspect-run",
      humanName: "Read run, deploy, and topology projections",
      cliCommand: "hobo inspect run --last --json",
      apiEndpoint: "/control-plane/inspect/run",
      mcpTool: "hobo_inspect_run",
      requestContract: ["runId", "campRef", "projectionSeq", "freshnessBound", "redactionClass"],
      responseContract: [
        "RunProjection",
        "ResourceActorState",
        "ResourceActorTimeline",
        "DriftReport",
        "freshness",
        ...commonResultFields,
      ],
      domainTerms: ["ResourceActor", "projection.Lagged", "drift", "materialized view", "snapshot"],
      sharedResultEnvelope: true,
      fixtureId: "fixture.inspect.run.fresh",
    },
    {
      id: "tail-logs",
      humanName: "Read support-safe log slices by cursor",
      cliCommand: "hobo logs --follow api --json",
      apiEndpoint: "/control-plane/logs/tail",
      mcpTool: "hobo_tail_logs",
      requestContract: ["resourceId", "LogCursor", "since", "redactionClass", "limit"],
      responseContract: ["LogSlice", "LogCursor", "nextCursor", "redactionSummary", ...commonResultFields],
      domainTerms: ["support-safe evidence", "read store", "projection", "ResourceActor"],
      sharedResultEnvelope: true,
      fixtureId: "fixture.logs.api.support-safe",
    },
    {
      id: "import-adopt",
      humanName: "Preview brownfield import and adopted-resource posture",
      cliCommand: "hobo import terraform ./infra --dry-run --json",
      apiEndpoint: "/control-plane/import/adopt",
      mcpTool: "hobo_import_terraform",
      requestContract: ["sourceKind", "stateDigest", "adoptionPolicy", "campRef", "dryRun"],
      responseContract: ["AdoptionPlan", "ExternalResource[]", "migrationPreview", ...commonResultFields],
      domainTerms: ["resource.Adopted", "authoritative-external", "echo driver", "migration.*"],
      sharedResultEnvelope: true,
      fixtureId: "fixture.import.terraform.adopted",
    },
    {
      id: "migrate",
      humanName: "Plan expand, backfill, contract, and cutover phases",
      cliCommand: "hobo migrate --dry-run --json",
      apiEndpoint: "/control-plane/migrate/dry-run",
      mcpTool: "hobo_migrate_dry_run",
      requestContract: ["currentVersion", "targetVersion", "schemaDigest", "snapshotRef", "campRef"],
      responseContract: ["MigrationPlan", "MigrationPhase", "blockedReason", "rollbackEvidence", ...commonResultFields],
      domainTerms: ["migration.Planned", "migration.PhaseApplied", "expand", "backfill", "contract"],
      sharedResultEnvelope: true,
      fixtureId: "fixture.migrate.expand-backfill-contract",
    },
    {
      id: "rollback",
      humanName: "Return to a prior immutable Deployment Set",
      cliCommand: "hobo up --camp prod --rollback deployment-set:previous --json",
      apiEndpoint: "/control-plane/rollback",
      mcpTool: "hobo_rollback",
      requestContract: ["currentSetId", "targetSetId", "rollbackReason", "snapshotRef", "approvalRef"],
      responseContract: ["RollbackPlan", "Delta", "restoreRequirement", ...commonResultFields],
      domainTerms: ["Deployment Set", "Delta", "migration.RolledBack", "snapshot"],
      sharedResultEnvelope: true,
      fixtureId: "fixture.rollback.previous-set",
    },
    {
      id: "support-evidence-pack",
      humanName: "Assemble redacted support evidence for a run or resource",
      cliCommand: "hobo doctor --support-bundle run:latest --json",
      apiEndpoint: "/control-plane/support/evidence-pack",
      mcpTool: "hobo_support_evidence_pack",
      requestContract: ["subjectRef", "evidenceKinds", "redactionClass", "supportRoute", "correlationId"],
      responseContract: ["EvidencePack", "ownerRoute", "redactionSummary", ...commonResultFields],
      domainTerms: ["support handoff", "CredentialAudit", "event-store", "read store"],
      sharedResultEnvelope: true,
      fixtureId: "fixture.support.evidence.redacted",
    },
  ],
  refusalEnvelopes: [
    {
      code: "policy-denied",
      trigger: "Gatekeeper policy plane returns deny for a requested apply.",
      remediation: "Change the plan, request approval, or select a permitted Camp.",
      proofMode: "contract-fixture",
      fixtureId: "fixture.refusal.policy-denied",
      redactionClass: "tenant-safe",
    },
    {
      code: "contract-incompatible",
      trigger: "Contract plane finds a running consumer incompatible with the proposed Delta.",
      remediation: "Dual-publish or upgrade the consumer before applying the contract phase.",
      proofMode: "contract-fixture",
      fixtureId: "fixture.refusal.contract-incompatible",
      redactionClass: "public",
    },
    {
      code: "provider-capability-partial",
      trigger: "Provider capability satisfies prefer but loses a requested soft objective.",
      remediation: "Accept the degraded plan warning or choose a provider with full support.",
      proofMode: "reference-fixture",
      fixtureId: "fixture.refusal.provider-partial",
      redactionClass: "public",
    },
    {
      code: "provider-capability-none",
      trigger: "No registered provider satisfies a required capability.",
      remediation: "Register a provider or remove the hard require.",
      proofMode: "reference-fixture",
      fixtureId: "fixture.refusal.provider-none",
      redactionClass: "public",
    },
    {
      code: "stale-projection",
      trigger: "Inspect reads a projection beyond the freshness bound.",
      remediation: "Refresh/replay the projection or re-run plan before apply.",
      proofMode: "projection-snapshot",
      fixtureId: "fixture.refusal.stale-projection",
      redactionClass: "tenant-safe",
    },
    {
      code: "unknown-evidence",
      trigger: "A plan references an evidence digest not present in the read store.",
      remediation: "Attach accepted evidence or downgrade the claim to unknown.",
      proofMode: "support-safe-evidence",
      fixtureId: "fixture.refusal.unknown-evidence",
      redactionClass: "support-redacted",
    },
    {
      code: "non-reactive-sink",
      trigger: "A projection sink cannot satisfy live inspect/log subscription semantics.",
      remediation: "Expose a snapshot-only result or bind a reactive sink provider.",
      proofMode: "projection-snapshot",
      fixtureId: "fixture.refusal.non-reactive-sink",
      redactionClass: "public",
    },
    {
      code: "destructive-migration-blocked",
      trigger: "A contract/drop phase would break a still-running app version.",
      remediation: "Complete expand/backfill, deploy compatible app version, then retry contract.",
      proofMode: "contract-fixture",
      fixtureId: "fixture.refusal.destructive-migration-blocked",
      redactionClass: "tenant-safe",
    },
  ],
  contractFixtures: {
    protobuf: "architecture/control_plane_api_resource_lifecycle_shapes.proto",
    cue: "architecture/control_plane_api_resource_lifecycle_shapes.cue",
    pact: "architecture/pacts/control_plane_api_resource_lifecycle_shapes.pact.json",
  },
  scopeOut: [
    "No production REST server, CLI parser, SDK package, MCP server, persistence layer, or dashboard is implemented.",
    "No live provider calls, cloud accounts, customer data, real credentials, or live support systems are used.",
    "No endpoint may bypass Planner, Gatekeeper, ResourceActor, event-store, materialized-view, snapshot, or read-store boundaries.",
  ],
} as const satisfies UnparsedControlPlaneApiResourceLifecycleProof;

export type ControlPlaneApiScopeDecision =
  | { readonly allowed: true; readonly reason: "fixture-contract" }
  | {
      readonly allowed: false;
      readonly reason:
        | "production-api-implementation"
        | "real-persistence"
        | "live-provider-or-credential"
        | "planner-gatekeeper-bypass";
    };

export function classifyControlPlaneApiScope(proposal: string): ControlPlaneApiScopeDecision {
  const normalized = proposal.toLowerCase();

  if (/production.*(rest|api|server|cli|sdk|mcp|implementation)|build.*production/.test(normalized)) {
    return { allowed: false, reason: "production-api-implementation" };
  }

  if (/persist.*real|live database|real database|write.*database|stored procedure/.test(normalized)) {
    return { allowed: false, reason: "real-persistence" };
  }

  if (/live provider|real credential|aws|azure|gcp|secret|cloud account/.test(normalized)) {
    return { allowed: false, reason: "live-provider-or-credential" };
  }

  if (/bypass.*(planner|gatekeeper)|without.*(planner|gatekeeper)|skip.*(planner|gatekeeper)/.test(normalized)) {
    return { allowed: false, reason: "planner-gatekeeper-bypass" };
  }

  return { allowed: true, reason: "fixture-contract" };
}

export function parseControlPlaneApiResourceLifecycleProof(
  contract: JsonValue,
): ControlPlaneApiResourceLifecycleProof {
  assertObject(contract, "contract");
  assertLiteral(contract.issue, "HOBO-569", "issue");
  assertLiteral(contract.phase, "M1", "phase");
  assertLiteral(
    contract.targetPackage,
    "src/draft/exp-proofs/api/control-plane-api-resource-lifecycle-shapes",
    "targetPackage",
  );
  assertLiteral(
    contract.proofNote,
    "docs/design/proofs/control-plane-api-resource-lifecycle-shapes/README.md",
    "proofNote",
  );
  assertNonEmptyStringArray(contract.designRefs, "designRefs");
  assertNonEmptyStringArray(contract.scopeOut, "scopeOut");

  const operations = assertOperationArray(contract.operations);
  const refusals = assertRefusalArray(contract.refusalEnvelopes);
  assertRequiredOperations(operations);
  assertRequiredAcceptanceTerms(operations);
  assertRequiredBoundaryCases(refusals);
  assertContractFixtures(contract.contractFixtures);

  return {
    // SAFETY: `...(contract as UnparsedControlPlaneApiResourceLifecycleProof),` is required at this I/O or test boundary.
    ...(contract as UnparsedControlPlaneApiResourceLifecycleProof),
    __brand: "ParsedControlPlaneApiResourceLifecycleProof",
  };
}

export function summarizeOperationParity(contract: ControlPlaneApiResourceLifecycleProof): ReadonlyArray<{
  readonly operation: OperationId;
  readonly apiEndpoint: `/${string}`;
  readonly mcpTool: `hobo_${string}`;
  readonly sharedResultEnvelope: true;
}> {
  return contract.operations.map((operation) => ({
    operation: operation.id,
    apiEndpoint: operation.apiEndpoint,
    mcpTool: operation.mcpTool,
    sharedResultEnvelope: operation.sharedResultEnvelope,
  }));
}

function assertObject(value: JsonValue, name: string): asserts value is JsonObject {
  if (!isJsonObject(value) || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertLiteral<T extends string>(value: JsonValue, expected: T, name: string): asserts value is T {
  if (value !== expected) {
    throw new TypeError(`${name} must be ${expected}`);
  }
}

function assertStringArray(value: JsonValue, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => !isJsonString(entry))) {
    throw new TypeError(`${name} must be a string array`);
  }

  return value;
}

function assertNonEmptyStringArray(value: JsonValue, name: string): void {
  const entries = assertStringArray(value, name);
  if (entries.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function readContractFields(
  entry: JsonObject,
  field: "requestContract" | "responseContract",
): string[] {
  const wireKey = field === "requestContract" ? "requestShape" : "responseShape";
  const value = entry[field] ?? entry[wireKey];
  const entries = assertStringArray(value, `${String(entry.id)}.${field}`);
  if (entries.length === 0) {
    throw new TypeError(`${String(entry.id)}.${field} must not be empty`);
  }
  return entries;
}

function assertOperationArray(value: JsonValue): ControlPlaneOperationContract[] {
  if (!Array.isArray(value)) {
    throw new TypeError("operations must be an array");
  }

  return value.map((entry, index) => {
    assertObject(entry, `operation ${index}`);
    assertRequiredOperation(entry.id);
    const requestContract = readContractFields(entry, "requestContract");
    const responseContract = readContractFields(entry, "responseContract");
    const domainTerms = assertStringArray(entry.domainTerms, `${entry.id}.domainTerms`);
    if (domainTerms.length === 0) {
      throw new TypeError(`${entry.id}.domainTerms must not be empty`);
    }

    for (const field of ["humanName", "cliCommand", "fixtureId"] as const) {
      if (!isJsonString(entry[field]) || entry[field].length === 0) {
        throw new TypeError(`${entry.id}.${field} must not be empty`);
      }
    }
    if (!isJsonString(entry.apiEndpoint) || !entry.apiEndpoint.startsWith("/")) {
      throw new TypeError(`${entry.id}.apiEndpoint must start with /`);
    }
    if (!isJsonString(entry.mcpTool) || !entry.mcpTool.startsWith("hobo_")) {
      throw new TypeError(`${entry.id}.mcpTool must start with hobo_`);
    }
    if (entry.sharedResultEnvelope !== true) {
      throw new TypeError(`${entry.id}.sharedResultEnvelope must be true`);
    }

    return {
      id: entry.id,
      humanName: entry.humanName,
      cliCommand: entry.cliCommand,
      apiEndpoint: entry.apiEndpoint,
      mcpTool: entry.mcpTool,
      requestContract,
      responseContract,
      domainTerms,
      sharedResultEnvelope: true as const,
      fixtureId: entry.fixtureId,
    };
  });
}

function assertRefusalArray(value: JsonValue): ControlPlaneRefusalEnvelope[] {
  if (!Array.isArray(value)) {
    throw new TypeError("refusalEnvelopes must be an array");
  }

  return value.map((entry, index) => {
    assertObject(entry, `refusal ${index}`);
    assertRequiredBoundaryCase(entry.code);
    for (const field of ["trigger", "remediation", "fixtureId", "redactionClass"] as const) {
      if (!isJsonString(entry[field]) || entry[field].length === 0) {
        throw new TypeError(`${entry.code}.${field} must not be empty`);
      }
    }
    if (!isProofMode(entry.proofMode)) {
      throw new TypeError(`${entry.code}.proofMode is not supported`);
    }

    // SAFETY: `return entry as ControlPlaneRefusalEnvelope;` is required at this I/O or test boundary.
    return entry as ControlPlaneRefusalEnvelope;
  });
}

function assertRequiredOperation(value: JsonValue): asserts value is OperationId {
  // SAFETY: `if (!REQUIRED_OPERATIONS.includes(value as OperationId)) {` is required at this I/O or test boundary.
  if (!REQUIRED_OPERATIONS.includes(value as OperationId)) {
    throw new TypeError(`unknown operation ${String(value)}`);
  }
}

function assertRequiredBoundaryCase(value: JsonValue): asserts value is BoundaryCase {
  // SAFETY: `if (!REQUIRED_BOUNDARY_CASES.includes(value as BoundaryCase)) {` is required at this I/O or test boundary.
  if (!REQUIRED_BOUNDARY_CASES.includes(value as BoundaryCase)) {
    throw new TypeError(`unknown boundary case ${String(value)}`);
  }
}

function assertRequiredOperations(operations: readonly ControlPlaneOperationContract[]): void {
  const ids = operations.map((operation) => operation.id);

  for (const operation of REQUIRED_OPERATIONS) {
    if (!ids.includes(operation)) {
      throw new TypeError(`missing operation ${operation}`);
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("operations must be unique");
  }
}

function assertRequiredAcceptanceTerms(operations: readonly ControlPlaneOperationContract[]): void {
  const acceptanceTerms = new Set(
    operations.flatMap((operation) => [
      ...operation.requestContract,
      ...operation.responseContract,
      ...operation.domainTerms,
    ]),
  );

  for (const term of REQUIRED_ACCEPTANCE_DOMAIN_TERMS) {
    if (!acceptanceTerms.has(term)) {
      throw new TypeError(`missing acceptance shape ${term}`);
    }
  }
}

function assertRequiredBoundaryCases(refusals: readonly ControlPlaneRefusalEnvelope[]): void {
  const codes = refusals.map((refusal) => refusal.code);

  for (const code of REQUIRED_BOUNDARY_CASES) {
    if (!codes.includes(code)) {
      throw new TypeError(`missing boundary case ${code}`);
    }
  }
}

function assertContractFixtures(value: JsonValue): asserts value is ControlPlaneContractFixtures {
  assertObject(value, "contractFixtures");
  assertLiteral(value.protobuf, "architecture/control_plane_api_resource_lifecycle_shapes.proto", "protobuf");
  assertLiteral(value.cue, "architecture/control_plane_api_resource_lifecycle_shapes.cue", "cue");
  assertLiteral(value.pact, "architecture/pacts/control_plane_api_resource_lifecycle_shapes.pact.json", "pact");
}

function isProofMode(value: JsonValue): value is ProofMode {
  return (
    value === "reference-fixture" ||
    value === "contract-fixture" ||
    value === "projection-snapshot" ||
    value === "support-safe-evidence"
  );
}
