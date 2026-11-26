import { isJsonObject, type JsonValue } from "./json.js";
export const REQUIRED_BLOCKED_REASONS = [
  "policy denied",
  "contract incompatible",
  "stale or unknown evidence",
] as const;

export const REQUIRED_FIXTURE_KINDS = [
  "deployment-plan",
  "deployment-set",
  "delta",
  "gatekeeper-decision",
  "resource-actor-event",
  "projection",
  "log",
] as const;

export type BlockedReason = (typeof REQUIRED_BLOCKED_REASONS)[number];
export type FixtureKind = (typeof REQUIRED_FIXTURE_KINDS)[number];
export type ProofMode = "reference fixture" | "simulated" | "live" | "scope-out";
export type DeployOutcome = "deployed" | "blocked";

// domain-view: parse-produced draft-proof record; its wire form is the DeployFixtureReference proto message in data-models/.
export interface DeployFixtureReference {
  kind: FixtureKind;
  id: string;
  source: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the CliDeployScenario proto message in data-models/.
export interface CliDeployScenario {
  id: string;
  title: string;
  actor: "app-developer" | "platform-engineer" | "agent-mcp-caller" | "support-operator";
  outcome: DeployOutcome;
  reason?: BlockedReason;
  deploymentPlanId: string;
  deploymentSetId: string;
  deltaId: string;
  gatekeeperDecisionId: string;
  gatekeeperExplanation: string;
  resourceActorEventId: string;
  projectionId: string;
  logFixtureId: string;
  valueProof: string;
  proofMode: ProofMode;
  supportWording: string;
  accessibilityNote: string;
  mcpEquivalent: boolean;
  fixtures: DeployFixtureReference[];
}

// domain-view: parse-produced draft-proof record; its wire form is the CliDeployTranscriptPrototype proto message in data-models/.
export interface CliDeployTranscriptPrototype {
  schema: "hobo.cli-deploy-transcript-prototype/v1";
  issue: "HOBO-573";
  targetPackagePath: "src/draft/exp-proofs/dx/cli-deploy-transcript-prototype";
  proofNotePath: "docs/design/proofs/cli-deploy-transcript-prototype/README.md";
  audience: string[];
  scenarios: CliDeployScenario[];
  scopeOut: string[];
}

// domain-view: parse-produced draft-proof record; its wire form is the McpToolResult proto message in data-models/.
export interface McpToolResult {
  operation: "hobo.up";
  status: DeployOutcome;
  reason: BlockedReason | "deployed";
  planId: string;
  deploymentSetId: string;
  deltaId: string;
  gatekeeperDecisionId: string;
  gatekeeperExplanation: string;
  fixtureIds: string[];
  proofMode: ProofMode;
  valueProof: string;
  customerSafeSummary: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the ScopeCreepDenial proto message in data-models/.
export interface ScopeCreepDenial {
  decision: "reject";
  reason: string;
  request: string;
}

type EvaluationAccepted = {
  successfulDeploys: number;
  blockedReasons: BlockedReason[];
};

export const CLI_DEPLOY_TRANSCRIPT_PROTOTYPE: CliDeployTranscriptPrototype = {
  schema: "hobo.cli-deploy-transcript-prototype/v1",
  issue: "HOBO-573",
  targetPackagePath: "src/draft/exp-proofs/dx/cli-deploy-transcript-prototype",
  proofNotePath: "docs/design/proofs/cli-deploy-transcript-prototype/README.md",
  audience: [
    "app developer validating a first deployment",
    "platform engineer reviewing Gatekeeper output",
    "agent/MCP caller needing machine-readable parity",
    "support operator reading customer-safe evidence",
  ],
  scenarios: [
    scenario({
      id: "deploy.preview.success",
      title: "successful preview deploy",
      actor: "app-developer",
      outcome: "deployed",
      deploymentPlanId: "deployment-plan.preview-success",
      deploymentSetId: "deployment-set.preview-v1",
      deltaId: "delta.preview-apply",
      gatekeeperDecisionId: "gatekeeper.allow.preview",
      gatekeeperExplanation:
        "Gatekeeper approved preview deploy because policy, contract, and fixture evidence matched.",
      resourceActorEventId: "resource.api.provisioned",
      projectionId: "projection.deployment-view.ready",
      logFixtureId: "log.api.ready",
      valueProof:
        "Value proof: preview endpoint readiness is backed by projection.deployment-view.ready and log.api.ready.",
      supportWording:
        "Customer-safe support summary: preview deploy completed from reference fixtures; cite run cli-preview-success if a support ticket needs reproduction.",
      accessibilityNote:
        "Plain text output includes stable headings, non-color status words, and screen reader friendly line order.",
    }),
    scenario({
      id: "deploy.blocked.policy-denied",
      title: "policy denied deploy",
      actor: "platform-engineer",
      outcome: "blocked",
      reason: "policy denied",
      deploymentPlanId: "deployment-plan.policy-denied",
      deploymentSetId: "deployment-set.not-created.policy",
      deltaId: "delta.policy-denied",
      gatekeeperDecisionId: "gatekeeper.deny.policy",
      gatekeeperExplanation:
        "Gatekeeper refused provider work because the policy pack denied the requested capability.",
      resourceActorEventId: "resource.api.not-started.policy",
      projectionId: "projection.deployment-view.blocked-policy",
      logFixtureId: "log.gatekeeper.policy-denied",
      valueProof:
        "Value proof: no provider apply started, so the denied policy prevented unsafe resource mutation.",
      supportWording:
        "Customer-safe support summary: policy denied this deploy before provider work; support can point to the Gatekeeper decision without exposing policy pack internals.",
      accessibilityNote:
        "Plain text denial uses a non-color blocked label and keeps remediation on its own stable line.",
    }),
    scenario({
      id: "deploy.blocked.contract-incompatible",
      title: "contract incompatible deploy",
      actor: "agent-mcp-caller",
      outcome: "blocked",
      reason: "contract incompatible",
      deploymentPlanId: "deployment-plan.contract-incompatible",
      deploymentSetId: "deployment-set.not-created.contract",
      deltaId: "delta.contract-incompatible",
      gatekeeperDecisionId: "gatekeeper.deny.contract",
      gatekeeperExplanation:
        "Gatekeeper refused deployment because the producer and consumer contract versions were incompatible.",
      resourceActorEventId: "resource.worker.not-started.contract",
      projectionId: "projection.deployment-view.blocked-contract",
      logFixtureId: "log.contract.incompatible",
      valueProof:
        "Value proof: contract incompatibility is visible before orchestration dispatch, preserving rollback-free safety.",
      supportWording:
        "Customer-safe support summary: contract incompatibility blocked the deploy; ticket evidence should cite producer and consumer versions, not customer payloads.",
      accessibilityNote:
        "Screen reader output names the incompatible edge before suggested fixes, with no icon-only status.",
    }),
    scenario({
      id: "deploy.blocked.stale-evidence",
      title: "stale or unknown evidence deploy",
      actor: "support-operator",
      outcome: "blocked",
      reason: "stale or unknown evidence",
      deploymentPlanId: "deployment-plan.stale-evidence",
      deploymentSetId: "deployment-set.not-created.stale",
      deltaId: "delta.stale-evidence",
      gatekeeperDecisionId: "gatekeeper.hold.stale-evidence",
      gatekeeperExplanation:
        "Gatekeeper refused readiness claims because projection and log evidence were stale or unknown.",
      resourceActorEventId: "resource.api.not-started.stale",
      projectionId: "projection.deployment-view.unknown-evidence",
      logFixtureId: "log.projection.stale-evidence",
      valueProof:
        "Value proof: the transcript asks for fixture refresh instead of presenting unknown evidence as success.",
      supportWording:
        "Customer-safe support summary: evidence was stale or unknown, so support should request a fixture refresh before claiming readiness.",
      accessibilityNote:
        "Stable wording says unknown evidence instead of success; terminal output does not rely on color or spinner state.",
    }),
  ],
  scopeOut: [
    "No production hobo up implementation.",
    "No live provider apply.",
    "No real account login or credentials.",
    "No launch demo claims.",
    "No visual dashboard substitute for the CLI flow.",
  ],
};

export function renderCliTranscript(record: CliDeployTranscriptPrototype) {
  return record.scenarios.map(renderScenarioTranscript).join("\n\n");
}

export function renderMcpToolResult(scenario: CliDeployScenario): McpToolResult {
  return {
    operation: "hobo.up",
    status: scenario.outcome,
    reason: scenario.reason ?? "deployed",
    planId: scenario.deploymentPlanId,
    deploymentSetId: scenario.deploymentSetId,
    deltaId: scenario.deltaId,
    gatekeeperDecisionId: scenario.gatekeeperDecisionId,
    gatekeeperExplanation: scenario.gatekeeperExplanation,
    fixtureIds: scenario.fixtures.map((fixture) => fixture.id),
    proofMode: scenario.proofMode,
    valueProof: scenario.valueProof,
    customerSafeSummary: scenario.supportWording,
  };
}

export function evaluateCliDeployTranscriptPrototype(input: JsonValue) {
  const parsed = parseCliDeployTranscriptPrototype(input);
  const errors = [...parsed.errors];

  if (!parsed.record) {
    return {
      ok: false,
      errors,
      // SAFETY: `accepted: { successfulDeploys: 0, blockedReasons: [] as BlockedReason[] },` is required at this I/O or test boundary.
      accepted: { successfulDeploys: 0, blockedReasons: [] as BlockedReason[] },
    };
  }

  const { record } = parsed;
  const successfulDeploys = record.scenarios.filter((scenario) => scenario.outcome === "deployed").length;
  if (successfulDeploys !== 1) {
    errors.push("transcript must contain exactly one successful deploy");
  }

  const blockedReasons = REQUIRED_BLOCKED_REASONS.filter((reason) =>
    record.scenarios.some((scenario) => scenario.outcome === "blocked" && scenario.reason === reason),
  );
  for (const reason of REQUIRED_BLOCKED_REASONS) {
    if (!blockedReasons.includes(reason)) {
      errors.push(`missing blocked deploy reason: ${reason}`);
    }
  }

  for (const scenario of record.scenarios) {
    const fixtureKinds = new Set(scenario.fixtures.map((fixture) => fixture.kind));
    for (const kind of REQUIRED_FIXTURE_KINDS) {
      if (!fixtureKinds.has(kind)) {
        errors.push(`${scenario.id} missing fixture kind: ${kind}`);
      }
    }

    if (!scenario.mcpEquivalent) {
      errors.push(`${scenario.id}: MCP tool result must be equivalent to the CLI transcript`);
    }
    if (scenario.proofMode === "live") {
      errors.push(`${scenario.id}: live proof mode is out of scope for HOBO-573`);
    }
    if (!/Gatekeeper.*(approved|refused|hold|held)/i.test(scenario.gatekeeperExplanation)) {
      errors.push(`${scenario.id}: Gatekeeper approval/refusal explanation is required`);
    }
    if (!/Value proof:/i.test(scenario.valueProof)) {
      errors.push(`${scenario.id}: value proof is required`);
    }
    if (!/support|ticket|customer-safe|operator/i.test(scenario.supportWording)) {
      errors.push(`${scenario.id}: support/customer-safe wording is required`);
    }
    if (!/plain text|screen reader|non-color|stable/i.test(scenario.accessibilityNote)) {
      errors.push(`${scenario.id}: accessibility note is required`);
    }
  }

  const accepted: EvaluationAccepted = {
    successfulDeploys,
    blockedReasons,
  };

  return { ok: errors.length === 0, errors, accepted };
}

export function rejectDeployTranscriptScopeCreep(requests: string[]): ScopeCreepDenial[] {
  return requests.flatMap((request) => {
    const reason = forbiddenReason(request);
    return reason ? [{ decision: "reject" as const, reason, request }] : [];
  });
}

export function parseCliDeployTranscriptPrototype(input: JsonValue) {
  const errors: string[] = [];

  if (!input || !isJsonObject(input)) {
    return { record: undefined, errors: ["CLI deploy transcript prototype record is required"] };
  }

  // SAFETY: `const record = input as Partial<CliDeployTranscriptPrototype>;` is required at this I/O or test boundary.
  const record = input as Partial<CliDeployTranscriptPrototype>;
  if (record.schema !== "hobo.cli-deploy-transcript-prototype/v1") {
    errors.push("schema must be hobo.cli-deploy-transcript-prototype/v1");
  }
  if (record.issue !== "HOBO-573") {
    errors.push("issue must be HOBO-573");
  }
  if (record.targetPackagePath !== "src/draft/exp-proofs/dx/cli-deploy-transcript-prototype") {
    errors.push("target package path must match HOBO-573 acceptance");
  }
  if (record.proofNotePath !== "docs/design/proofs/cli-deploy-transcript-prototype/README.md") {
    errors.push("proof note path must match HOBO-573 acceptance");
  }
  if (!Array.isArray(record.scenarios) || record.scenarios.length < 4) {
    errors.push("at least four deploy scenarios are required");
  }

  return {
    // SAFETY: `record: Array.isArray(record.scenarios) ? (record as CliDeployTranscriptPrototyp` is required at this I/O or test boundary.
    record: Array.isArray(record.scenarios) ? (record as CliDeployTranscriptPrototype) : undefined,
    errors,
  };
}

function scenario(input: Omit<CliDeployScenario, "fixtures" | "mcpEquivalent" | "proofMode">): CliDeployScenario {
  return {
    ...input,
    proofMode: "reference fixture",
    mcpEquivalent: true,
    fixtures: REQUIRED_FIXTURE_KINDS.map((kind) => ({
      kind,
      id: fixtureIdFor(kind, input),
      source: "M1 resource lifecycle fixture corpus",
    })),
  };
}

function fixtureIdFor(kind: FixtureKind, input: Omit<CliDeployScenario, "fixtures" | "mcpEquivalent" | "proofMode">) {
  switch (kind) {
    case "deployment-plan":
      return input.deploymentPlanId;
    case "deployment-set":
      return input.deploymentSetId;
    case "delta":
      return input.deltaId;
    case "gatekeeper-decision":
      return input.gatekeeperDecisionId;
    case "resource-actor-event":
      return input.resourceActorEventId;
    case "projection":
      return input.projectionId;
    case "log":
      return input.logFixtureId;
  }
}

function renderScenarioTranscript(scenario: CliDeployScenario) {
  const upResult =
    scenario.outcome === "deployed"
      ? `deployed: ${scenario.deploymentSetId} via ${scenario.deltaId}`
      : `blocked: ${scenario.reason}`;

  return [
    `# ${scenario.title}`,
    `$ hobo collect --camp preview --fixture ${scenario.id}`,
    `manifest: ${scenario.fixtures.find((fixture) => fixture.kind === "deployment-plan")?.id}`,
    "$ hobo plan --camp preview --json",
    `DeploymentPlan: ${scenario.deploymentPlanId}`,
    `Gatekeeper: ${scenario.gatekeeperDecisionId}`,
    `Gatekeeper explanation: ${scenario.gatekeeperExplanation}`,
    '$ hobo up --camp preview --proof-mode "reference fixture"',
    `approval/refusal: ${scenario.outcome === "deployed" ? "approved" : `refused: ${scenario.reason}`}`,
    upResult,
    `$ hobo inspect run ${scenario.resourceActorEventId}`,
    `projection: ${scenario.projectionId}`,
    `$ hobo logs --follow ${scenario.logFixtureId}`,
    scenario.valueProof,
    scenario.supportWording,
    scenario.accessibilityNote,
  ].join("\n");
}

function forbiddenReason(request: string) {
  if (/\bproduction\b|\bprod\b|AWS|Azure|GCP|Cloudflare|live provider/i.test(request)) {
    return "production or live provider execution is out of scope";
  }
  if (/credential|account login|real account|secret/i.test(request)) {
    return "real account login and credentials are out of scope";
  }
  if (/launch.*claim|final launch|marketing claim/i.test(request)) {
    return "launch claims require accepted evidence outside this proof";
  }
  if (/dashboard|visual tour|UI tour/i.test(request)) {
    return "visual dashboard substitutes are out of scope";
  }
  return undefined;
}
