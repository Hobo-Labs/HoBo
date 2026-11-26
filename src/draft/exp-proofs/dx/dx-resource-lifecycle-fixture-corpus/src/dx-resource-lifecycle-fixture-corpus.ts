import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const REQUIRED_SCENARIOS = [
  "deploy",
  "manage",
  "migrate",
  "rollback",
  "import-adopt",
  "drift",
  "stale-projection",
  "policy-denial",
  "contract-incompatibility",
  "support-evidence",
] as const;

export const REQUIRED_ARTIFACTS = [
  "resources",
  "links",
  "manifest-ir",
  "deployment-plan",
  "deployment-set",
  "delta",
  "gatekeeper-decision",
  "resourceactor-events",
  "projection-snapshot",
  "logs",
] as const;

export const REQUIRED_FACT_KINDS = [
  ...REQUIRED_ARTIFACTS,
  "drift-report",
  "import-adopt-state",
  "migration-phase",
  "support-evidence",
] as const;

export const REQUIRED_BOUNDARY_CONTRACTS = [
  "protobuf",
  "CUE",
  "Pact",
  "fixture-json",
  "type-consumer",
] as const;

export const REQUIRED_CONSUMERS = [
  "sdk-compile-consumer",
  "cli-transcript-generator",
  "control-plane-api-example",
  "docs-snippet",
  "visual-mockup-fixture",
] as const;

const VALID_PROOF_MODES = new Set(["reference fixture", "simulated", "live", "scope-out"]);
const REQUIRED_SOURCE_REFS = [
  "docs/design/developer-experience.md#plan-07",
  "docs/design/cli-spec.md",
  "docs/design/authoring-resources-wiring.md#plan-21",
  "docs/design/control-plane.md#plan-04",
  "docs/design/data-plane.md#plan-32",
  "docs/design/walkthrough.md",
  "docs/design/worked-example.md#plan-19",
] as const;

const SCOPE_CREEP_PATTERNS = [
  /\blive provider\b/i,
  /\breal provider\b/i,
  /\bcustomer data\b/i,
  /\breal secrets?\b/i,
  /\bproduction catalog\b/i,
  /\bone-off fixture\b/i,
  /\bembedded inside mockups?\b/i,
  /\bcloud credential\b/i,
];

type RequiredScenario = (typeof REQUIRED_SCENARIOS)[number];
type Artifact = (typeof REQUIRED_ARTIFACTS)[number];
type FixtureFactKind = (typeof REQUIRED_FACT_KINDS)[number];
type BoundaryContract = (typeof REQUIRED_BOUNDARY_CONTRACTS)[number];
type Consumer = (typeof REQUIRED_CONSUMERS)[number];
type ProofMode = "reference fixture" | "simulated" | "live" | "scope-out";

interface LifecycleFixtureFact {
  kind: FixtureFactKind;
  id: string;
  summary: string;
  redacted: boolean;
  tenantSafe: boolean;
  proofMode: ProofMode;
  source: "fixture-corpus";
}

interface LifecycleScenario {
  id: RequiredScenario | string;
  persona: string;
  lifecycleStep: string;
  commands: string[];
  artifacts: Artifact[];
  fixtureIds: string[];
  fixtureFacts: LifecycleFixtureFact[];
  migrationPhase?: "expand" | "backfill" | "contract";
  deterministic: boolean;
  redacted: boolean;
  tenantSafe: boolean;
  proofMode: ProofMode;
  liveEvidenceRef?: string;
  simulationRef?: string;
  scopeOutGuard: string;
}

interface ResourceLifecycleFixtureCorpus {
  issue: string;
  packagePath: string;
  proofNote: string;
  audience: string[];
  sourceRefs: string[];
  boundaryContracts: BoundaryContract[];
  consumers: Consumer[];
  scenarios: LifecycleScenario[];
}

export type ParsedDxResourceLifecycleFixtureCorpus = ResourceLifecycleFixtureCorpus & {
  readonly __parsed: "DxResourceLifecycleFixtureCorpus";
};

interface FixtureFactSummaries {
  readonly resources: string;
  readonly links: string;
  readonly "manifest-ir": string;
  readonly "deployment-plan": string;
  readonly "deployment-set": string;
  readonly delta: string;
  readonly "gatekeeper-decision": string;
  readonly "resourceactor-events": string;
  readonly "projection-snapshot": string;
  readonly logs: string;
  readonly "drift-report": string;
  readonly "import-adopt-state": string;
  readonly "migration-phase": string;
  readonly "support-evidence": string;
}

const FACT_SUMMARIES: FixtureFactSummaries = {
  resources: "Resource fixture entries for component, database, image, queue, and ownership examples.",
  links: "Typed relation fixture entries connecting manifests, deployment sets, actors, and evidence packs.",
  "manifest-ir": "Manifest IR fixture entries describing stable resource ids, ports, and capability references.",
  "deployment-plan": "DeploymentPlan fixture entries for ordered actions, checks, rollback handles, and refusal points.",
  "deployment-set": "Deployment Set fixture entries for target camps, revisions, ownership, and selected resources.",
  delta: "Delta fixture entries for proposed, accepted, denied, and rollback state transitions.",
  "gatekeeper-decision": "Gatekeeper decision fixture entries for allow, deny, incompatibility, and remediation labels.",
  "resourceactor-events": "ResourceActor event fixture entries for provisioned, drifted, adopted, denied, and rolled-back evidence.",
  "projection-snapshot": "Projection snapshot fixture entries for fresh, stale, and support-safe read-model states.",
  logs: "Redacted log fixture entries for command output, run traces, and support bundles.",
  "drift-report": "DriftReport fixture entries for observed differences, proposed reconcile deltas, and safe next actions.",
  "import-adopt-state": "Import/adopt fixture entries for redacted external state, adopted resources, and no-op plans.",
  "migration-phase": "Migration phase fixture entries for expand, backfill, contract, and blocked destructive changes.",
  "support-evidence": "Support evidence fixture entries for redacted bundles, owner routes, and customer-safe status updates.",
};

function lifecycleFixtureFacts(scenarioId: RequiredScenario): LifecycleFixtureFact[] {
  return REQUIRED_FACT_KINDS.map((kind) => ({
    kind,
    id: `dx.lifecycle.${scenarioId}.${kind}.v1`,
    summary: FACT_SUMMARIES[kind],
    redacted: true,
    tenantSafe: true,
    proofMode: "reference fixture",
    source: "fixture-corpus",
  }));
}

export const DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS: ResourceLifecycleFixtureCorpus = {
  issue: "HOBO-572",
  packagePath: "src/draft/exp-proofs/dx/dx-resource-lifecycle-fixture-corpus",
  proofNote: "docs/design/proofs/dx-resource-lifecycle-fixture-corpus/README.md",
  audience: [
    "app developer",
    "platform engineer",
    "GitOps operator",
    "SecOps reviewer",
    "DevOps operator",
    "SRE",
    "agent/MCP caller",
  ],
  sourceRefs: [...REQUIRED_SOURCE_REFS],
  boundaryContracts: [...REQUIRED_BOUNDARY_CONTRACTS],
  consumers: [...REQUIRED_CONSUMERS],
  scenarios: [
    {
      id: "deploy",
      persona: "app developer",
      lifecycleStep: "collect -> plan -> up -> inspect",
      commands: ["hobo collect --out manifest.json", "hobo plan --camp preview", "hobo up --camp preview", "hobo inspect run --last"],
      artifacts: [...REQUIRED_ARTIFACTS],
      fixtureIds: ["snapshop-api", "snapshop-db", "snapshop-images", "gatekeeper-allow", "resource.Provisioned"],
      fixtureFacts: lifecycleFixtureFacts("deploy"),
      deterministic: true,
      redacted: true,
      tenantSafe: true,
      proofMode: "reference fixture",
      scopeOutGuard: "No live providers, customer data, or production catalog generation are needed to prove the deploy corpus.",
    },
    {
      id: "manage",
      persona: "SRE",
      lifecycleStep: "inspect -> logs -> support bundle",
      commands: ["hobo inspect topology", "hobo logs --follow api", "hobo doctor --support-bundle"],
      artifacts: [...REQUIRED_ARTIFACTS],
      fixtureIds: ["projection-fresh", "run-log-redacted", "support-bundle-safe", "topology-readmodel"],
      fixtureFacts: lifecycleFixtureFacts("manage"),
      deterministic: true,
      redacted: true,
      tenantSafe: true,
      proofMode: "reference fixture",
      scopeOutGuard: "Management fixtures expose redacted projection and log records, not live customer telemetry.",
    },
    {
      id: "migrate",
      persona: "platform engineer",
      lifecycleStep: "expand -> backfill -> contract",
      commands: ["hobo plan --camp prod --migration expand", "hobo up --camp prod --to migration-expand"],
      artifacts: [...REQUIRED_ARTIFACTS],
      fixtureIds: ["migration-expand", "migration-backfill", "migration-contract", "schema-change-additive"],
      fixtureFacts: lifecycleFixtureFacts("migrate"),
      migrationPhase: "expand",
      deterministic: true,
      redacted: true,
      tenantSafe: true,
      proofMode: "reference fixture",
      scopeOutGuard: "Migration fixtures model phases and blocked destructive contract steps without executing live migrations.",
    },
    {
      id: "rollback",
      persona: "GitOps operator",
      lifecycleStep: "failed rollout -> rollback available -> prior revision",
      commands: ["hobo up --camp prod --rollback", "hobo inspect deploy --last"],
      artifacts: [...REQUIRED_ARTIFACTS],
      fixtureIds: ["rollback-last-good", "delta-reverts-to-set", "rollout-health-failed"],
      fixtureFacts: lifecycleFixtureFacts("rollback"),
      deterministic: true,
      redacted: true,
      tenantSafe: true,
      proofMode: "reference fixture",
      scopeOutGuard: "Rollback fixtures prove revision selection and event evidence, not a production rollback executor.",
    },
    {
      id: "import-adopt",
      persona: "DevOps operator",
      lifecycleStep: "import terraform -> adopted resources -> no-op plan",
      commands: ["hobo import terraform ./infra", "hobo plan --camp prod"],
      artifacts: [...REQUIRED_ARTIFACTS],
      fixtureIds: ["terraform-state-redacted", "resource-adopted", "authoritative-external", "no-op-plan"],
      fixtureFacts: lifecycleFixtureFacts("import-adopt"),
      deterministic: true,
      redacted: true,
      tenantSafe: true,
      proofMode: "reference fixture",
      scopeOutGuard: "Import/adopt fixtures are redacted state examples and do not read real Terraform state or cloud credentials.",
    },
    {
      id: "drift",
      persona: "SRE",
      lifecycleStep: "refresh -> DriftReport -> reconcile proposal",
      commands: ["hobo inspect deploy --drift", "hobo plan --camp prod"],
      artifacts: [...REQUIRED_ARTIFACTS],
      fixtureIds: ["resource.DriftDetected", "drift-report-safe", "reconcile-delta-proposed"],
      fixtureFacts: lifecycleFixtureFacts("drift"),
      deterministic: true,
      redacted: true,
      tenantSafe: true,
      proofMode: "reference fixture",
      scopeOutGuard: "Drift fixtures do not poll providers or mutate ResourceActor runtime state.",
    },
    {
      id: "stale-projection",
      persona: "agent/MCP caller",
      lifecycleStep: "read projection -> freshness warning -> retry route",
      commands: ["hobo inspect topology --json", "mcp.hobo.inspectTopology"],
      artifacts: [...REQUIRED_ARTIFACTS],
      fixtureIds: ["projection-stale", "freshness-lag-warning", "safe-next-action"],
      fixtureFacts: lifecycleFixtureFacts("stale-projection"),
      deterministic: true,
      redacted: true,
      tenantSafe: true,
      proofMode: "reference fixture",
      scopeOutGuard: "Projection fixtures label stale evidence without building a projection runtime.",
    },
    {
      id: "policy-denial",
      persona: "SecOps reviewer",
      lifecycleStep: "plan -> Gatekeeper denial -> support-safe explanation",
      commands: ["hobo plan --camp prod", "hobo up --camp prod"],
      artifacts: [...REQUIRED_ARTIFACTS],
      fixtureIds: ["policy.Decided-deny", "gatekeeper-denial", "approval-required"],
      fixtureFacts: lifecycleFixtureFacts("policy-denial"),
      deterministic: true,
      redacted: true,
      tenantSafe: true,
      proofMode: "reference fixture",
      scopeOutGuard: "Policy fixtures show refusal envelopes and do not implement the policy engine or approval workflow.",
    },
    {
      id: "contract-incompatibility",
      persona: "app developer",
      lifecycleStep: "contract change -> Gatekeeper denial -> remediation route",
      commands: ["hobo verify --target prod", "hobo up --camp prod"],
      artifacts: [...REQUIRED_ARTIFACTS],
      fixtureIds: ["compat.GateFailed", "consumer-still-reads-field", "dual-publish-remediation"],
      fixtureFacts: lifecycleFixtureFacts("contract-incompatibility"),
      deterministic: true,
      redacted: true,
      tenantSafe: true,
      proofMode: "reference fixture",
      scopeOutGuard: "Contract fixtures capture incompatibility and remediation labels without implementing contract promotion.",
    },
    {
      id: "support-evidence",
      persona: "support operator",
      lifecycleStep: "customer issue -> redacted evidence pack -> owner route",
      commands: ["hobo doctor --support-bundle", "hobo inspect run --last --redacted"],
      artifacts: [...REQUIRED_ARTIFACTS],
      fixtureIds: ["redacted-evidence-pack", "owner-route-support", "customer-safe-update"],
      fixtureFacts: lifecycleFixtureFacts("support-evidence"),
      deterministic: true,
      redacted: true,
      tenantSafe: true,
      proofMode: "reference fixture",
      scopeOutGuard: "Support fixtures contain redacted evidence only and do not open tickets, access customer data, or promise SLAs.",
    },
  ],
};

export function validateDxResourceLifecycleFixtureCorpus(corpus: ResourceLifecycleFixtureCorpus) {
  const errors: string[] = [];
  const sourceRefs = stringList(corpus.sourceRefs);
  const boundaryContracts = stringList(corpus.boundaryContracts);
  const consumers = stringList(corpus.consumers);
  const scenarioRecords = recordList(corpus.scenarios);

  if (corpus.issue !== "HOBO-572") {
    errors.push("issue must be HOBO-572");
  }
  if (corpus.packagePath !== "src/draft/exp-proofs/dx/dx-resource-lifecycle-fixture-corpus") {
    errors.push("target package path must match the Linear issue");
  }
  if (corpus.proofNote !== "docs/design/proofs/dx-resource-lifecycle-fixture-corpus/README.md") {
    errors.push("target proof note must match the Linear issue");
  }
  if (!Array.isArray(corpus.sourceRefs)) {
    errors.push("source refs must be an array");
  }
  if (!Array.isArray(corpus.boundaryContracts)) {
    errors.push("boundary contracts must be an array");
  }
  if (!Array.isArray(corpus.consumers)) {
    errors.push("consumers must be an array");
  }
  if (!Array.isArray(corpus.scenarios)) {
    errors.push("scenarios must be an array");
  }

  for (const sourceRef of REQUIRED_SOURCE_REFS) {
    if (!sourceRefs.includes(sourceRef)) {
      errors.push(`missing source ref: ${sourceRef}`);
    }
  }
  for (const contract of REQUIRED_BOUNDARY_CONTRACTS) {
    if (!boundaryContracts.includes(contract)) {
      errors.push(`missing boundary contract: ${contract}`);
    }
  }
  for (const consumer of REQUIRED_CONSUMERS) {
    if (!consumers.includes(consumer)) {
      errors.push(`missing consumer: ${consumer}`);
    }
  }

  const scenarios = new Map(scenarioRecords.map((scenario) => [scenario.id, scenario]));
  for (const requiredScenario of REQUIRED_SCENARIOS) {
    if (!scenarios.has(requiredScenario)) {
      errors.push(`missing required scenario: ${requiredScenario}`);
    }
  }

  for (const scenario of scenarioRecords) {
    const scenarioId = isJsonString(scenario.id) ? scenario.id : "unknown";
    const artifacts = stringList(scenario.artifacts);
    const fixtureIds = stringList(scenario.fixtureIds);
    const fixtureFacts = recordList(scenario.fixtureFacts);
    const factKinds = new Set(fixtureFacts.map((fact) => fact.kind));
    const scopeOutGuard = isJsonString(scenario.scopeOutGuard) ? scenario.scopeOutGuard : "";

    if (!scenario.deterministic) {
      errors.push(`scenario ${scenarioId} must be deterministic`);
    }
    if (!scenario.redacted) {
      errors.push(`scenario ${scenarioId} must be redacted`);
    }
    if (!scenario.tenantSafe) {
      errors.push(`scenario ${scenarioId} must be tenant-safe`);
    }
    if (!VALID_PROOF_MODES.has(scenario.proofMode)) {
      errors.push(`scenario ${scenarioId} has unsupported proof mode`);
    }
    if (scenario.proofMode === "live" && !scenario.liveEvidenceRef) {
      errors.push(`scenario ${scenarioId} needs live proof evidence before using live proof mode`);
    }
    if (scenario.proofMode === "simulated" && !scenario.simulationRef) {
      errors.push(`scenario ${scenarioId} needs simulation evidence before using simulated proof mode`);
    }
    for (const artifact of REQUIRED_ARTIFACTS) {
      if (!artifacts.includes(artifact)) {
        errors.push(`scenario ${scenarioId} missing artifact: ${artifact}`);
      }
    }
    if (fixtureIds.length < 3) {
      errors.push(`scenario ${scenarioId} must name deterministic fixture ids`);
    }
    for (const factKind of REQUIRED_FACT_KINDS) {
      if (!factKinds.has(factKind)) {
        errors.push(`scenario ${scenarioId} missing fixture fact: ${factKind}`);
      }
    }
    for (const fact of fixtureFacts) {
      const factId = isJsonString(fact.id) ? fact.id : "";
      const factSummary = isJsonString(fact.summary) ? fact.summary : "";
      if (!factId) {
        errors.push(`scenario ${scenarioId} has fixture fact without an id`);
      }
      if (!factSummary) {
        errors.push(`scenario ${scenarioId} fixture fact ${String(fact.kind)} must have a summary`);
      }
      if (fact.redacted !== true) {
        errors.push(`scenario ${scenarioId} fixture fact ${factId || String(fact.kind)} must be redacted`);
      }
      if (fact.tenantSafe !== true) {
        errors.push(`scenario ${scenarioId} fixture fact ${factId || String(fact.kind)} must be tenant-safe`);
      }
      if (fact.proofMode !== scenario.proofMode) {
        errors.push(`scenario ${scenarioId} fixture fact ${factId || String(fact.kind)} must match scenario proof mode`);
      }
      if (fact.source !== "fixture-corpus") {
        errors.push(`scenario ${scenarioId} fixture fact ${factId || String(fact.kind)} must come from the fixture corpus`);
      }
      if (SCOPE_CREEP_PATTERNS.some((pattern) => pattern.test(factSummary))) {
        errors.push(`scenario ${scenarioId} fixture fact ${factId || String(fact.kind)} has scope creep in summary`);
      }
    }
    if (!scopeOutGuard) {
      errors.push(`scenario ${scenarioId} must name its scope-out guard`);
    }
    if (
      /^(use|read|execute|generate|build|call)\b/i.test(scopeOutGuard) &&
      SCOPE_CREEP_PATTERNS.some((pattern) => pattern.test(scopeOutGuard))
    ) {
      errors.push(`scenario ${scenarioId} has scope creep in guard: ${scopeOutGuard}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function parseDxResourceLifecycleFixtureCorpus(input: JsonValue) {
  if (!input || !isJsonObject(input)) {
    return { ok: false as const, errors: ["fixture corpus object is required"] };
  }

  // SAFETY: `const result = validateDxResourceLifecycleFixtureCorpus(input as ResourceLifecyc` is required at this I/O or test boundary.
  const result = validateDxResourceLifecycleFixtureCorpus(input as ResourceLifecycleFixtureCorpus);
  if (!result.ok) {
    // SAFETY: `return result as { ok: false; errors: string[] };` is required at this I/O or test boundary.
    return result as { ok: false; errors: string[] };
  }

  return {
    ok: true as const,
    errors: [],
    value: {
      // SAFETY: `...(input as ResourceLifecycleFixtureCorpus),` is required at this I/O or test boundary.
      ...(input as ResourceLifecycleFixtureCorpus),
      __parsed: "DxResourceLifecycleFixtureCorpus",
    } satisfies ParsedDxResourceLifecycleFixtureCorpus,
  };
}

function stringList(value: JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => isJsonString(item)) : [];
}

function recordList(value: JsonValue): Array<JsonObject> {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => isJsonObject(item) && item !== null)
    : [];
}
