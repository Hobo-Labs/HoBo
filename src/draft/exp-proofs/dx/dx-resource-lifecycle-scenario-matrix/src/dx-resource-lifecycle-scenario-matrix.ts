import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const REQUIRED_ROLES = [
  "app-developer",
  "platform-engineer",
  "gitops",
  "secops",
  "devops",
  "sre",
  "agent-mcp-caller",
] as const;

export const REQUIRED_SCENARIO_PATHS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "migration-or-rollback",
  "support-handoff",
] as const;

export const REQUIRED_DESIGN_TERMS = [
  "hobo up",
  "hobo plan",
  "hobo collect",
  "hobo inspect",
  "hobo logs",
  "hobo doctor",
  "hobo import terraform",
  "DeploymentPlan",
  "Deployment Set",
  "Delta",
  "Gatekeeper",
  "ResourceActor",
  "migration.*",
] as const;

type RequiredRole = (typeof REQUIRED_ROLES)[number];
type RequiredScenarioPath = (typeof REQUIRED_SCENARIO_PATHS)[number];
type RequiredDesignTerm = (typeof REQUIRED_DESIGN_TERMS)[number];

export type ProofMode =
  | "command-transcript"
  | "contract-fixture"
  | "projection-snapshot"
  | "support-safe-evidence";

// domain-view: parse-produced draft-proof record; its wire form is the DxScenarioJourney proto message in data-models/.
export type DxScenarioJourney = {
  readonly id: string;
  readonly role: RequiredRole;
  readonly intent: string;
  readonly commands: readonly string[];
  readonly sdkCalls: readonly string[];
  readonly apiCalls: readonly string[];
  readonly mcpTools: readonly string[];
  readonly expectedArtifacts: readonly string[];
  readonly proofMode: ProofMode;
  readonly fixtureRequirements: readonly string[];
  readonly scenarioPaths: readonly RequiredScenarioPath[];
  readonly designTerms: readonly RequiredDesignTerm[];
};

// domain-view: parse-produced draft-proof record; its wire form is the DxResourceLifecycleScenarioMatrix proto message in data-models/.
export type DxResourceLifecycleScenarioMatrix = {
  readonly issue: "HOBO-567";
  readonly phase: "M1";
  readonly targetPackage: "src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix";
  readonly proofNote: "docs/design/proofs/dx-resource-lifecycle-scenario-matrix/README.md";
  readonly designRefs: readonly string[];
  readonly designTerms: readonly RequiredDesignTerm[];
  readonly scopeOut: readonly string[];
  readonly journeys: readonly DxScenarioJourney[];
  readonly __brand: "ParsedDxResourceLifecycleScenarioMatrix";
};

type UnparsedDxResourceLifecycleScenarioMatrix = Omit<
  DxResourceLifecycleScenarioMatrix,
  "__brand"
>;

const allScenarioPaths = [...REQUIRED_SCENARIO_PATHS] as const;

export const DX_RESOURCE_LIFECYCLE_SCENARIO_MATRIX = {
  issue: "HOBO-567",
  phase: "M1",
  targetPackage: "src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix",
  proofNote: "docs/design/proofs/dx-resource-lifecycle-scenario-matrix/README.md",
  designRefs: [
    "docs/design/developer-experience.md#plan-07",
    "docs/design/cli-spec.md",
    "docs/design/control-plane.md#plan-04",
    "docs/design/platform-engineering.md#plan-25",
    "docs/design/authoring-resources-wiring.md#plan-21",
    "docs/design/contracts-policy-flags.md#plan-29",
    "docs/design/data-plane.md#plan-11",
    "docs/design/walkthrough.md",
    "docs/design/worked-example.md",
  ],
  designTerms: [...REQUIRED_DESIGN_TERMS],
  scopeOut: [
    "production CLI/API/SDK implementation",
    "live providers",
    "real credentials",
    "customer data",
    "visual mockups that invent resource behavior before the matrix exists",
  ],
  journeys: [
    {
      id: "app-developer-resource-deploy",
      role: "app-developer",
      intent: "Deploy, inspect, and debug a generated resource app without authoring cloud glue.",
      commands: [
        "hobo collect ./src",
        "hobo plan --camp preview",
        "hobo up --camp preview",
        "hobo inspect run --last",
        "hobo logs --follow api",
      ],
      sdkCalls: [
        "bindle('snapshop', builder)",
        "b.api('orders', handler)",
        "b.bucket('product-images')",
        "resource.dependsOn(database)",
      ],
      apiCalls: [
        "POST /deployments/plan",
        "POST /deployments/up",
        "GET /runs/{runId}",
        "GET /projections/resource/{resourceId}",
      ],
      mcpTools: ["hobo_collect", "hobo_plan", "hobo_up", "hobo_inspect_run", "hobo_tail_logs"],
      expectedArtifacts: [
        "hobo.manifest/v1",
        "DeploymentPlan",
        "Gatekeeper decision",
        "ResourceActor event timeline",
        "support-safe log slice",
      ],
      proofMode: "command-transcript",
      fixtureRequirements: [
        "manifest IR with generated resource identifiers and dependsOn edges",
        "blocked Gatekeeper fixture with remediation copy",
        "stale projection fixture for hobo inspect",
      ],
      scenarioPaths: allScenarioPaths,
      designTerms: [
        "hobo collect",
        "hobo plan",
        "hobo up",
        "hobo inspect",
        "hobo logs",
        "DeploymentPlan",
        "Gatekeeper",
        "ResourceActor",
      ],
    },
    {
      id: "platform-engineer-provider-defaults",
      role: "platform-engineer",
      intent: "Ship platform defaults, provider matches, and deployment set policy as reusable camp behavior.",
      commands: [
        "hobo plan ./platform --camp prod",
        "hobo up ./platform --camp prod",
        "hobo doctor --camp prod",
        "hobo inspect deployment-set --current",
      ],
      sdkCalls: [
        "yard('prod')",
        "camp('prod')",
        "defineResource('postgres')",
        "providerCatalog.register(matchRules)",
      ],
      apiCalls: [
        "POST /platform/deployment-sets",
        "POST /matching/decisions",
        "GET /deployment-sets/{setId}",
        "GET /deltas/{deltaId}",
      ],
      mcpTools: ["hobo_plan_platform", "hobo_up_platform", "hobo_doctor", "hobo_inspect_deployment_set"],
      expectedArtifacts: [
        "ResourceDefinition bundle",
        "provider match decision",
        "Deployment Set",
        "Delta",
        "Gatekeeper compatibility receipt",
      ],
      proofMode: "contract-fixture",
      fixtureRequirements: [
        "provider catalog fixture with accepted and rejected matches",
        "Deployment Set and Delta snapshots with monotonic identifiers",
        "doctor warning fixture for missing portability metadata",
      ],
      scenarioPaths: allScenarioPaths,
      designTerms: [
        "hobo plan",
        "hobo up",
        "hobo doctor",
        "Deployment Set",
        "Delta",
        "Gatekeeper",
        "ResourceActor",
      ],
    },
    {
      id: "gitops-plan-apply-promotion",
      role: "gitops",
      intent: "Plan and apply resource changes from CI while keeping previews, promotion, and rollback auditable.",
      commands: [
        "hobo plan --camp pr-42 --json",
        "hobo up --camp pr-42 --json",
        "hobo up --camp prod --to git:main",
        "hobo up --camp prod --rollback deployment-set:previous",
      ],
      sdkCalls: [
        "workflow.previewCamp('pr-42')",
        "workflow.promoteDeploymentSet(previousSet, nextSet)",
        "workflow.rollbackDeploymentSet(previousSet)",
      ],
      apiCalls: [
        "POST /ci/plans",
        "POST /ci/applies",
        "POST /deployment-sets/{setId}/promotions",
        "POST /deployment-sets/{setId}/rollback",
      ],
      mcpTools: ["hobo_plan_ci", "hobo_up_ci", "hobo_promote", "hobo_rollback"],
      expectedArtifacts: [
        "PR plan comment",
        "preview camp URL",
        "Deployment Set promotion receipt",
        "rollback Delta",
        "drift event",
      ],
      proofMode: "contract-fixture",
      fixtureRequirements: [
        "CI environment fixture with preview and prod camps",
        "stale plan fixture that forces re-plan",
        "rollback fixture keyed by previous Deployment Set",
      ],
      scenarioPaths: allScenarioPaths,
      designTerms: ["hobo plan", "hobo up", "DeploymentPlan", "Deployment Set", "Delta", "Gatekeeper"],
    },
    {
      id: "secops-policy-gate",
      role: "secops",
      intent: "Review deployability, evidence, and policy decisions before sensitive resource changes proceed.",
      commands: [
        "hobo can-deploy --target prod",
        "hobo verify --target prod",
        "hobo up --camp prod --policy required",
        "hobo doctor --policy-pack platform",
      ],
      sdkCalls: [
        "policyPack('platform').allow(resourceChange)",
        "connector('compliance').attest(evidence)",
        "gatekeeper.evaluate(plan)",
      ],
      apiCalls: [
        "POST /gatekeeper/can-deploy",
        "POST /policy/decisions",
        "GET /attestations/{subjectId}",
        "POST /compatibility/checks",
      ],
      mcpTools: ["hobo_can_deploy", "hobo_verify", "hobo_policy_decision", "hobo_doctor_policy"],
      expectedArtifacts: [
        "policy.Decided event",
        "compat.GateFailed event",
        "attestation envelope",
        "waiver request stub",
        "redacted evidence packet",
      ],
      proofMode: "support-safe-evidence",
      fixtureRequirements: [
        "accepted and rejected Gatekeeper decisions",
        "missing attestation fixture",
        "redacted policy evidence fixture without customer data",
      ],
      scenarioPaths: allScenarioPaths,
      designTerms: ["hobo up", "hobo doctor", "Gatekeeper", "DeploymentPlan", "Delta"],
    },
    {
      id: "devops-self-hosted-platform",
      role: "devops",
      intent: "Operate self-hosted HoBo resources, restore state, and hand off runner health without secrets.",
      commands: [
        "hobo up ./platform --seed",
        "hobo inspect topology --camp prod",
        "hobo logs --follow runner",
        "hobo doctor --self-hosted",
      ],
      sdkCalls: [
        "executionHost('self-hosted')",
        "runnerPool('prod').restore(seedLog)",
        "stateStore.snapshots().latest()",
      ],
      apiCalls: [
        "POST /platform/seed",
        "GET /topology/current",
        "GET /runner-pools/{poolId}/health",
        "POST /state/restore",
      ],
      mcpTools: ["hobo_seed_platform", "hobo_inspect_topology", "hobo_tail_runner_logs", "hobo_doctor_self_hosted"],
      expectedArtifacts: [
        "identity.SeedTokenUsed event",
        "topology projection",
        "runner health snapshot",
        "restore receipt",
        "support handoff packet",
      ],
      proofMode: "projection-snapshot",
      fixtureRequirements: [
        "seed run fixture with redacted token reference",
        "stale topology projection fixture",
        "restore receipt fixture for support handoff",
      ],
      scenarioPaths: allScenarioPaths,
      designTerms: ["hobo up", "hobo inspect", "hobo logs", "hobo doctor", "ResourceActor"],
    },
    {
      id: "sre-incident-and-rollback",
      role: "sre",
      intent: "Diagnose resource incidents from projections, events, logs, and rollback-safe runbooks.",
      commands: [
        "hobo inspect run --last --camp prod",
        "hobo inspect resource api --timeline",
        "hobo logs --follow api --since incident",
        "hobo up --camp prod --rollback deployment-set:previous",
      ],
      sdkCalls: [
        "runbook('api-latency').replay(snapshot)",
        "slo('checkout').observe(resourceProjection)",
        "crew('oncall').handoff(packet)",
      ],
      apiCalls: [
        "GET /incidents/{incidentId}/timeline",
        "GET /projections/resource/{resourceId}",
        "GET /logs?resource=api",
        "POST /runbooks/{runbookId}/replay",
      ],
      mcpTools: ["hobo_inspect_incident", "hobo_inspect_resource", "hobo_tail_logs", "hobo_runbook_replay"],
      expectedArtifacts: [
        "incident timeline",
        "ResourceActor history",
        "SLO projection snapshot",
        "rollback Deployment Set receipt",
        "support-safe handoff packet",
      ],
      proofMode: "projection-snapshot",
      fixtureRequirements: [
        "lagged projection fixture labeled stale",
        "rollback receipt fixture",
        "support handoff fixture with redacted logs",
      ],
      scenarioPaths: allScenarioPaths,
      designTerms: ["hobo inspect", "hobo logs", "hobo up", "Deployment Set", "ResourceActor"],
    },
    {
      id: "agent-mcp-resource-caller",
      role: "agent-mcp-caller",
      intent: "Let agents inspect, plan, and request resource work through MCP without receiving hidden authority.",
      commands: [
        "hobo plan --json",
        "hobo up --json --dry-run",
        "hobo inspect run --json --last",
        "hobo import terraform ./infra --dry-run",
      ],
      sdkCalls: [
        "agentSession('codex').plan(resourceRequest)",
        "agentSession('codex').requestApproval(delta)",
        "agentSession('codex').readProjection(resourceId)",
      ],
      apiCalls: [
        "POST /mcp/tools/hobo_plan",
        "POST /mcp/tools/hobo_up",
        "POST /mcp/tools/hobo_inspect_run",
        "POST /mcp/tools/hobo_import_terraform",
      ],
      mcpTools: ["hobo_plan", "hobo_up", "hobo_inspect_run", "hobo_import_terraform"],
      expectedArtifacts: [
        "MCP tool transcript",
        "dry-run DeploymentPlan",
        "approval-required Gatekeeper receipt",
        "migration.* event preview",
        "agent support handoff packet",
      ],
      proofMode: "command-transcript",
      fixtureRequirements: [
        "MCP caller fixture with explicit authority boundary",
        "dry-run import fixture with migration.* preview events",
        "unknown evidence fixture that blocks hobo up",
      ],
      scenarioPaths: allScenarioPaths,
      designTerms: [
        "hobo plan",
        "hobo up",
        "hobo inspect",
        "hobo import terraform",
        "DeploymentPlan",
        "Gatekeeper",
        "migration.*",
      ],
    },
  ],
} as const satisfies UnparsedDxResourceLifecycleScenarioMatrix;

export type DxScenarioScopeDecision =
  | { readonly allowed: true; readonly reason: "matrix-fixture" }
  | {
      readonly allowed: false;
      readonly reason:
        | "customer-data"
        | "live-provider-or-credential"
        | "premature-visual-behavior"
        | "production-implementation";
    };

export function classifyDxScenarioScope(proposal: string): DxScenarioScopeDecision {
  const normalized = proposal.toLowerCase();

  if (/customer data|customer payload|tenant data/.test(normalized)) {
    return { allowed: false, reason: "customer-data" };
  }

  if (/live provider|real credential|aws|azure|gcp|secret/.test(normalized)) {
    return { allowed: false, reason: "live-provider-or-credential" };
  }

  if (/visual mockup|mockup.*invent|invent.*resource behavior/.test(normalized)) {
    return { allowed: false, reason: "premature-visual-behavior" };
  }

  if (/production.*(cli|api|sdk|implementation)|implement.*production/.test(normalized)) {
    return { allowed: false, reason: "production-implementation" };
  }

  return { allowed: true, reason: "matrix-fixture" };
}

export function parseDxResourceLifecycleScenarioMatrix(
  matrix: JsonValue,
): DxResourceLifecycleScenarioMatrix {
  assertObject(matrix, "matrix");
  assertLiteral(matrix.issue, "HOBO-567", "issue");
  assertLiteral(matrix.phase, "M1", "phase");
  assertLiteral(
    matrix.targetPackage,
    "src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix",
    "targetPackage",
  );
  assertLiteral(
    matrix.proofNote,
    "docs/design/proofs/dx-resource-lifecycle-scenario-matrix/README.md",
    "proofNote",
  );
  assertNonEmptyStringArray(matrix.designRefs, "designRefs");
  assertNonEmptyStringArray(matrix.scopeOut, "scopeOut");

  const designTerms = assertStringArray(matrix.designTerms, "designTerms");
  const journeys = assertJourneyArray(matrix.journeys);
  assertRoles(journeys);
  assertDesignTerms(designTerms, journeys);

  return {
    // SAFETY: `...(matrix as UnparsedDxResourceLifecycleScenarioMatrix),` is required at this I/O or test boundary.
    ...(matrix as UnparsedDxResourceLifecycleScenarioMatrix),
    __brand: "ParsedDxResourceLifecycleScenarioMatrix",
  };
}

export function summarizeMatrixByRole(matrix: DxResourceLifecycleScenarioMatrix): ReadonlyArray<{
  readonly role: RequiredRole;
  readonly proofMode: ProofMode;
  readonly fixtureRequirements: readonly string[];
  readonly artifacts: readonly string[];
}> {
  return matrix.journeys.map((journey) => ({
    role: journey.role,
    proofMode: journey.proofMode,
    fixtureRequirements: journey.fixtureRequirements,
    artifacts: journey.expectedArtifacts,
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

function assertJourneyArray(value: JsonValue): DxScenarioJourney[] {
  if (!Array.isArray(value)) {
    throw new TypeError("journeys must be an array");
  }

  return value.map((entry, index) => {
    assertObject(entry, `journey ${index}`);
    assertRequiredRole(entry.role);
    assertNonEmptyStringArray(entry.commands, `${entry.role}.commands`);
    assertNonEmptyStringArray(entry.sdkCalls, `${entry.role}.sdkCalls`);
    assertNonEmptyStringArray(entry.apiCalls, `${entry.role}.apiCalls`);
    assertNonEmptyStringArray(entry.mcpTools, `${entry.role}.mcpTools`);
    assertNonEmptyStringArray(entry.expectedArtifacts, `${entry.role}.expectedArtifacts`);
    assertNonEmptyStringArray(entry.fixtureRequirements, `${entry.role}.fixtureRequirements`);
    assertScenarioPaths(entry.scenarioPaths, entry.role);
    assertNonEmptyStringArray(entry.designTerms, `${entry.role}.designTerms`);

    if (!isJsonString(entry.id) || entry.id.length === 0) {
      throw new TypeError(`${entry.role}.id must not be empty`);
    }
    if (!isJsonString(entry.intent) || entry.intent.length === 0) {
      throw new TypeError(`${entry.role}.intent must not be empty`);
    }
    if (!isProofMode(entry.proofMode)) {
      throw new TypeError(`${entry.role}.proofMode is not supported`);
    }

    // SAFETY: `return entry as DxScenarioJourney;` is required at this I/O or test boundary.
    return entry as DxScenarioJourney;
  });
}

function assertRequiredRole(value: JsonValue): asserts value is RequiredRole {
  // SAFETY: `if (!REQUIRED_ROLES.includes(value as RequiredRole)) {` is required at this I/O or test boundary.
  if (!REQUIRED_ROLES.includes(value as RequiredRole)) {
    throw new TypeError(`unknown role ${String(value)}`);
  }
}

function assertRoles(journeys: readonly DxScenarioJourney[]): void {
  const roles = new Set(journeys.map((journey) => journey.role));

  for (const role of REQUIRED_ROLES) {
    if (!roles.has(role)) {
      throw new TypeError(`missing required role ${role}`);
    }
  }

  if (roles.size !== journeys.length) {
    throw new TypeError("matrix must define each required role once");
  }
}

function assertScenarioPaths(value: JsonValue, role: string): void {
  const paths = assertStringArray(value, `${role}.scenarioPaths`);

  for (const path of REQUIRED_SCENARIO_PATHS) {
    if (!paths.includes(path)) {
      throw new TypeError(`${role} missing scenario path ${path}`);
    }
  }
}

function assertDesignTerms(
  topLevelTerms: readonly string[],
  journeys: readonly DxScenarioJourney[],
): void {
  const allTerms = new Set([
    ...topLevelTerms,
    ...journeys.flatMap((journey) => journey.designTerms),
  ]);

  for (const term of REQUIRED_DESIGN_TERMS) {
    if (!allTerms.has(term)) {
      throw new TypeError(`missing required design term ${term}`);
    }
  }
}

function isProofMode(value: JsonValue): value is ProofMode {
  return (
    value === "command-transcript" ||
    value === "contract-fixture" ||
    value === "projection-snapshot" ||
    value === "support-safe-evidence"
  );
}
