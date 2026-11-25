import {
  RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES,
  listQuickstartSnippets,
  parseResourceLifecycleQuickstartExamples,
} from "../../../dx/resource-lifecycle-quickstart-examples/src/resource-lifecycle-quickstart-examples.js";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const REQUIRED_ROLE_JOURNEY_ROLES = [
  "app-developer",
  "platform-engineer",
  "gitops",
  "secops",
  "devops",
  "sre",
] as const;

export const REQUIRED_ROLE_JOURNEY_COVERAGE = [
  "deploy",
  "manage",
  "migrate",
  "rollback",
  "policy-or-contract-denial",
  "support-handoff",
] as const;

export const REQUIRED_ROLE_JOURNEY_NEGATIVE_PATHS = [
  "blocked",
  "stale-or-unknown-evidence",
] as const;

type RoleJourneyRole = (typeof REQUIRED_ROLE_JOURNEY_ROLES)[number];
type RoleJourneyCoverage = (typeof REQUIRED_ROLE_JOURNEY_COVERAGE)[number];
type RoleJourneyNegativePath = (typeof REQUIRED_ROLE_JOURNEY_NEGATIVE_PATHS)[number];
type RoleJourneyProofMode = "reference-fixture" | "simulated" | "scope-out";
type StepStatus = "ready" | "blocked" | "stale" | "support" | "rollback" | "migrate" | "deploy";

// domain-view: parse-produced draft-proof record; its wire form is the RoleJourneyJsonResult proto message in data-models/.
export type RoleJourneyJsonResult = {
  readonly schema: "hobo.role-journey-cli-mcp-result/v1";
  readonly status: StepStatus;
  readonly fixtureId: string;
  readonly proofMode: RoleJourneyProofMode;
  readonly summary: string;
  readonly supportHandoff: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the RoleJourneyMcpResult proto message in data-models/.
export type RoleJourneyMcpResult = {
  readonly tool: `hobo_${string}`;
  readonly status: StepStatus;
  readonly fixtureId: string;
  readonly proofMode: RoleJourneyProofMode;
  readonly resultSchema: "hobo.role-journey-cli-mcp-result/v1";
};

// domain-view: parse-produced draft-proof record; its wire form is the RoleJourneyStep proto message in data-models/.
export type RoleJourneyStep = {
  readonly id: string;
  readonly command: `hobo ${string}`;
  readonly expectedTerminalOutput: string;
  readonly quickstartFixtureId: string;
  readonly proofMode: RoleJourneyProofMode;
  readonly jsonResult: RoleJourneyJsonResult;
  readonly mcpResult: RoleJourneyMcpResult;
  readonly supportHandoff: string;
  readonly accessibilityNote: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the RoleJourney proto message in data-models/.
export type RoleJourney = {
  readonly role: RoleJourneyRole;
  readonly title: string;
  readonly audience: string;
  readonly intent: string;
  readonly primaryQuickstartFixtureId: string;
  readonly coverage: readonly RoleJourneyCoverage[];
  readonly negativePaths: readonly RoleJourneyNegativePath[];
  readonly sequence: readonly RoleJourneyStep[];
};

// domain-view: parse-produced draft-proof record; its wire form is the RoleJourneyCliMcpTranscripts proto message in data-models/.
export type RoleJourneyCliMcpTranscripts = {
  readonly issue: "HOBO-557";
  readonly phase: "M2";
  readonly targetPackage: "src/draft/exp-proofs/ax/role-journey-cli-mcp-transcripts";
  readonly proofNote: "docs/design/proofs/role-journey-cli-mcp-transcripts/README.md";
  readonly sourceQuickstartIssue: "HOBO-577";
  readonly sourceQuickstartProof: "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md";
  readonly designRefs: readonly string[];
  readonly scopeOut: readonly string[];
  readonly journeys: readonly RoleJourney[];
  readonly __brand: "ParsedRoleJourneyCliMcpTranscripts";
};

type UnparsedRoleJourneyCliMcpTranscripts = Omit<RoleJourneyCliMcpTranscripts, "__brand">;

const acceptedFixtureIds = listAcceptedQuickstartFixtureIds();

export const ROLE_JOURNEY_CLI_MCP_TRANSCRIPTS = {
  issue: "HOBO-557",
  phase: "M2",
  targetPackage: "src/draft/exp-proofs/ax/role-journey-cli-mcp-transcripts",
  proofNote: "docs/design/proofs/role-journey-cli-mcp-transcripts/README.md",
  sourceQuickstartIssue: "HOBO-577",
  sourceQuickstartProof: "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  designRefs: [
    "docs/design/developer-experience.md#plan-07",
    "docs/design/cli-spec.md",
    "docs/design/walkthrough.md",
    "docs/design/proofs/dx-resource-lifecycle-scenario-matrix/README.md",
    "docs/design/proofs/cli-mcp-parity-resource-lifecycle-contracts/README.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  scopeOut: [
    "production CLI implementation",
    "live provider calls",
    "real credentials",
    "customer data",
    "visual mockups that do not trace to the DX quickstart",
  ],
  journeys: [
    journey({
      role: "app-developer",
      title: "App developer deploys and verifies a first app",
      audience: "Application developer validating the resource lifecycle from code to proof.",
      intent: "Keep the first app path CLI-first while preserving SDK, API, and MCP parity through fixture ids.",
      primaryQuickstartFixtureId: "rlq-define-object-graph-v1",
      coverage: ["deploy", "support-handoff"],
      sequence: [
        step({
          id: "app.define",
          command: "hobo collect ./examples/shop-api --fixture rlq-define-object-graph-v1 --json",
          status: "ready",
          fixtureId: "rlq-define-object-graph-v1",
          proofMode: "reference-fixture",
          output: "ready: manifest fixture rlq-define-object-graph-v1 collected for plan preview",
          tool: "hobo_collect",
        }),
        step({
          id: "app.plan",
          command: "hobo plan --fixture rlq-collect-manifest-ir-v1 --camp preview --json",
          status: "ready",
          fixtureId: "rlq-plan-safe-preview-v1",
          proofMode: "simulated",
          output: "ready: DeploymentPlan fixture includes Gatekeeper approval and support handoff",
          tool: "hobo_plan",
        }),
        step({
          id: "app.deploy",
          command: "hobo up --plan-fixture rlq-plan-safe-preview-v1 --mode simulated --json",
          status: "deploy",
          fixtureId: "rlq-deploy-run-accepted-v1",
          proofMode: "simulated",
          output: "deploy: simulated Deployment Set accepted; support handoff cites run fixture",
          tool: "hobo_up",
        }),
      ],
    }),
    journey({
      role: "platform-engineer",
      title: "Platform engineer manages provider readiness",
      audience: "Platform engineer reviewing readiness, stale evidence, and safe next action.",
      intent: "Show management through plan, inspect, and doctor commands without adding platform-only verbs.",
      primaryQuickstartFixtureId: "rlq-plan-safe-preview-v1",
      coverage: ["manage", "support-handoff"],
      sequence: [
        step({
          id: "platform.plan",
          command: "hobo plan ./platform --fixture rlq-plan-safe-preview-v1 --camp prod --json",
          status: "ready",
          fixtureId: "rlq-plan-safe-preview-v1",
          proofMode: "simulated",
          output: "ready: plan groups provider match, cost, and policy evidence for review",
          tool: "hobo_plan",
        }),
        step({
          id: "platform.inspect",
          command: "hobo inspect deployment-set --fixture rlq-inspect-event-projection-v1 --current --json",
          status: "stale",
          fixtureId: "rlq-inspect-event-projection-v1",
          proofMode: "reference-fixture",
          output: "stale: projection evidence is labelled before any readiness claim",
          tool: "hobo_inspect_deployment_set",
        }),
        step({
          id: "platform.doctor",
          command: "hobo doctor --fixture rlq-manage-stale-evidence-v1 --focus stale-projection",
          status: "support",
          fixtureId: "rlq-manage-stale-evidence-v1",
          proofMode: "reference-fixture",
          output: "support: doctor routes stale evidence to platform owner and fixture refresh",
          tool: "hobo_doctor",
        }),
      ],
    }),
    journey({
      role: "gitops",
      title: "GitOps promotes and rolls back by Deployment Set",
      audience: "Release owner using CI transcripts for preview, promotion, and rollback.",
      intent: "Keep promotion and rollback under hobo up with deployment-set fixtures and no standalone verbs.",
      primaryQuickstartFixtureId: "rlq-deploy-run-accepted-v1",
      coverage: ["deploy", "rollback"],
      sequence: [
        step({
          id: "gitops.preview",
          command: "hobo up --camp pr-42 --plan-fixture rlq-plan-safe-preview-v1 --json",
          status: "deploy",
          fixtureId: "rlq-deploy-run-accepted-v1",
          proofMode: "simulated",
          output: "deploy: preview camp accepted from simulated quickstart fixture",
          tool: "hobo_up",
        }),
        step({
          id: "gitops.promote",
          command: "hobo up --camp prod --to git:main --fixture rlq-deploy-run-accepted-v1 --json",
          status: "ready",
          fixtureId: "rlq-deploy-run-accepted-v1",
          proofMode: "simulated",
          output: "ready: promotion uses existing Deployment Set evidence and Gatekeeper receipt",
          tool: "hobo_up",
        }),
        step({
          id: "gitops.rollback",
          command: "hobo up --camp prod --rollback deployment-set:previous --fixture rlq-recover-snapshot-restore-v1",
          status: "rollback",
          fixtureId: "rlq-recover-snapshot-restore-v1",
          proofMode: "reference-fixture",
          output: "rollback: dry-run recovery preserves previous Deployment Set and support handoff",
          tool: "hobo_up",
        }),
      ],
    }),
    journey({
      role: "secops",
      title: "SecOps reviews policy and contract refusal evidence",
      audience: "Security reviewer checking deny outcomes before sensitive changes proceed.",
      intent: "Expose policy and contract denial through CLI output and equivalent MCP result shapes.",
      primaryQuickstartFixtureId: "rlq-plan-safe-preview-v1",
      coverage: ["policy-or-contract-denial", "support-handoff"],
      sequence: [
        step({
          id: "secops.can-deploy",
          command: "hobo up --camp prod --plan-fixture rlq-plan-safe-preview-v1 --dry-run --json",
          status: "blocked",
          fixtureId: "rlq-plan-safe-preview-v1",
          proofMode: "simulated",
          output: "blocked: policy or contract denial returns Gatekeeper explanation",
          tool: "hobo_up",
        }),
        step({
          id: "secops.doctor-policy",
          command: "hobo doctor --fixture rlq-manage-stale-evidence-v1 --policy-pack platform",
          status: "support",
          fixtureId: "rlq-manage-stale-evidence-v1",
          proofMode: "reference-fixture",
          output: "support: customer-safe policy wording routes owner without exposing internals",
          tool: "hobo_doctor",
        }),
        step({
          id: "secops.scope-out",
          command: "hobo quickstart-scope --fixture rlq-recover-scope-out-v1 --json",
          status: "blocked",
          fixtureId: "rlq-recover-scope-out-v1",
          proofMode: "scope-out",
          output: "blocked: scope-out prevents live credential or launch claim escalation",
          tool: "hobo_quickstart_scope_out",
        }),
      ],
    }),
    journey({
      role: "devops",
      title: "DevOps migrates brownfield resources safely",
      audience: "DevOps operator previewing import, migration, and restore evidence.",
      intent: "Make migration a dry-run transcript that feeds plan before any deploy-like action.",
      primaryQuickstartFixtureId: "rlq-migrate-brownfield-preview-v1",
      coverage: ["migrate", "rollback", "manage"],
      sequence: [
        step({
          id: "devops.import",
          command: "hobo import terraform ./infra --fixture rlq-migrate-brownfield-preview-v1 --dry-run --json",
          status: "migrate",
          fixtureId: "rlq-migrate-brownfield-preview-v1",
          proofMode: "simulated",
          output: "migrate: dry-run import emits migration preview events without adoption authority",
          tool: "hobo_import_terraform",
        }),
        step({
          id: "devops.plan",
          command: "hobo plan --fixture rlq-migrate-brownfield-preview-v1 --camp prod --json",
          status: "blocked",
          fixtureId: "rlq-migrate-brownfield-preview-v1",
          proofMode: "simulated",
          output: "blocked: destructive migration waits on Gatekeeper and Pact compatibility",
          tool: "hobo_plan",
        }),
        step({
          id: "devops.restore",
          command: "hobo up --rollback deployment-set:previous --fixture rlq-recover-snapshot-restore-v1 --dry-run",
          status: "rollback",
          fixtureId: "rlq-recover-snapshot-restore-v1",
          proofMode: "reference-fixture",
          output: "rollback: restore preview names snapshot fixture and support handoff",
          tool: "hobo_up",
        }),
      ],
    }),
    journey({
      role: "sre",
      title: "SRE diagnoses incident evidence and hands off safely",
      audience: "SRE reading projections, logs, rollback evidence, and support packets.",
      intent: "Keep incident diagnosis read-only until gated rollback evidence exists.",
      primaryQuickstartFixtureId: "rlq-inspect-event-projection-v1",
      coverage: ["manage", "rollback", "support-handoff"],
      sequence: [
        step({
          id: "sre.inspect",
          command: "hobo inspect run --fixture rlq-inspect-event-projection-v1 --last --json",
          status: "stale",
          fixtureId: "rlq-inspect-event-projection-v1",
          proofMode: "reference-fixture",
          output: "stale: run projection labels unknown evidence before success wording",
          tool: "hobo_inspect_run",
        }),
        step({
          id: "sre.logs",
          command: "hobo logs --follow api --fixture rlq-manage-stale-evidence-v1 --since incident",
          status: "support",
          fixtureId: "rlq-manage-stale-evidence-v1",
          proofMode: "reference-fixture",
          output: "support: redacted log transcript points support to fixture refresh",
          tool: "hobo_logs",
        }),
        step({
          id: "sre.rollback",
          command: "hobo up --camp prod --rollback deployment-set:previous --fixture rlq-recover-snapshot-restore-v1",
          status: "rollback",
          fixtureId: "rlq-recover-snapshot-restore-v1",
          proofMode: "reference-fixture",
          output: "rollback: rollback preview includes customer-safe support handoff",
          tool: "hobo_up",
        }),
      ],
    }),
  ],
} as const satisfies UnparsedRoleJourneyCliMcpTranscripts;

export type RoleJourneyScopeDecision =
  | { readonly allowed: true; readonly reason: "role-journey-fixture" }
  | {
      readonly allowed: false;
      readonly reason: "production-cli" | "live-provider-or-credential" | "customer-data" | "dashboard-first";
    };

export function listAcceptedQuickstartFixtureIds(): readonly string[] {
  const quickstart = parseResourceLifecycleQuickstartExamples(RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES);
  const fixtureIds = new Set([
    ...listQuickstartSnippets(quickstart).map((snippet) => snippet.fixtureId),
    ...quickstart.handoffs.flatMap((handoff) => handoff.fixtureIds),
  ]);

  return [...fixtureIds].sort();
}

export function parseRoleJourneyCliMcpTranscripts(input: JsonValue): RoleJourneyCliMcpTranscripts {
  assertObject(input, "role journey proof");
  assertLiteral(input.issue, "HOBO-557", "issue");
  assertLiteral(input.phase, "M2", "phase");
  assertLiteral(
    input.targetPackage,
    "src/draft/exp-proofs/ax/role-journey-cli-mcp-transcripts",
    "targetPackage",
  );
  assertLiteral(
    input.proofNote,
    "docs/design/proofs/role-journey-cli-mcp-transcripts/README.md",
    "proofNote",
  );
  assertLiteral(input.sourceQuickstartIssue, "HOBO-577", "sourceQuickstartIssue");
  assertLiteral(
    input.sourceQuickstartProof,
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
    "sourceQuickstartProof",
  );
  assertNonEmptyStringArray(input.designRefs, "designRefs");
  assertNonEmptyStringArray(input.scopeOut, "scopeOut");

  const journeys = assertJourneyArray(input.journeys);
  assertRoleCoverage(journeys);
  assertAggregateCoverage(journeys);

  return {
    // SAFETY: `...(input as UnparsedRoleJourneyCliMcpTranscripts),` is required at this I/O or test boundary.
    ...(input as UnparsedRoleJourneyCliMcpTranscripts),
    __brand: "ParsedRoleJourneyCliMcpTranscripts",
  };
}

export function renderRoleJourneyTranscript(journey: RoleJourney): string {
  return [
    `# ${journey.title}`,
    `role: ${journey.role}`,
    `intent: ${journey.intent}`,
    ...journey.sequence.flatMap((step) => [
      `$ ${step.command}`,
      step.expectedTerminalOutput,
      `json: ${JSON.stringify(step.jsonResult)}`,
      `mcp: ${JSON.stringify(renderStepMcpResult(step))}`,
      `proof-mode: ${step.proofMode}`,
      `support handoff: ${step.supportHandoff}`,
      `accessibility: ${step.accessibilityNote}`,
    ]),
  ].join("\n");
}

export function renderStepMcpResult(step: RoleJourneyStep): RoleJourneyMcpResult {
  return step.mcpResult;
}

export function classifyRoleJourneyScope(proposal: string): RoleJourneyScopeDecision {
  const normalized = proposal.toLowerCase();

  if (/production.*cli|cli parser|implement.*cli/.test(normalized)) {
    return { allowed: false, reason: "production-cli" };
  }
  if (/live provider|aws|azure|gcp|cloudflare|real credential|credential|secret/.test(normalized)) {
    return { allowed: false, reason: "live-provider-or-credential" };
  }
  if (/customer data|customer tenant|tenant data|customer payload/.test(normalized)) {
    return { allowed: false, reason: "customer-data" };
  }
  if (/enterprise dashboard|dashboard tour|visual mockup.*replace|replace.*dashboard/.test(normalized)) {
    return { allowed: false, reason: "dashboard-first" };
  }

  return { allowed: true, reason: "role-journey-fixture" };
}

function journey(input: Omit<RoleJourney, "negativePaths">): RoleJourney {
  return {
    ...input,
    negativePaths: [...REQUIRED_ROLE_JOURNEY_NEGATIVE_PATHS],
  };
}

function step(input: {
  readonly id: string;
  readonly command: `hobo ${string}`;
  readonly status: StepStatus;
  readonly fixtureId: string;
  readonly proofMode: RoleJourneyProofMode;
  readonly output: string;
  readonly tool: `hobo_${string}`;
}): RoleJourneyStep {
  const supportHandoff = `Support handoff cites ${input.fixtureId} with customer-safe reproduction notes.`;
  const accessibilityNote =
    "Plain text terminal output uses stable headings, non-color status words, and screen reader friendly order.";

  return {
    id: input.id,
    command: input.command,
    expectedTerminalOutput: input.output,
    quickstartFixtureId: input.fixtureId,
    proofMode: input.proofMode,
    jsonResult: {
      schema: "hobo.role-journey-cli-mcp-result/v1",
      status: input.status,
      fixtureId: input.fixtureId,
      proofMode: input.proofMode,
      summary: input.output,
      supportHandoff,
    },
    mcpResult: {
      tool: input.tool,
      status: input.status,
      fixtureId: input.fixtureId,
      proofMode: input.proofMode,
      resultSchema: "hobo.role-journey-cli-mcp-result/v1",
    },
    supportHandoff,
    accessibilityNote,
  };
}

function assertJourneyArray(value: JsonValue): RoleJourney[] {
  if (!Array.isArray(value)) {
    throw new TypeError("journeys must be an array");
  }

  return value.map((entry, index) => {
    assertObject(entry, `journey ${index}`);
    assertRole(entry.role);
    assertNonEmptyString(entry.title, `${entry.role}.title`);
    assertNonEmptyString(entry.audience, `${entry.role}.audience`);
    assertNonEmptyString(entry.intent, `${entry.role}.intent`);
    assertAcceptedFixtureId(entry.primaryQuickstartFixtureId, `${entry.role}.primaryQuickstartFixtureId`);
    assertCoverageArray(entry.coverage, `${entry.role}.coverage`);
    assertNegativePaths(entry.negativePaths, entry.role);
    const sequence = assertStepArray(entry.sequence, entry.role);
    if (!sequence.some((step) => step.quickstartFixtureId === entry.primaryQuickstartFixtureId)) {
      throw new TypeError(`${entry.role} must use its primary quickstart fixture`);
    }

    // SAFETY: `return entry as RoleJourney;` is required at this I/O or test boundary.
    return entry as RoleJourney;
  });
}

function assertStepArray(value: JsonValue, role: string): RoleJourneyStep[] {
  if (!Array.isArray(value) || value.length < 3) {
    throw new TypeError(`${role}.sequence must contain at least three CLI-first steps`);
  }

  return value.map((entry, index) => {
    assertObject(entry, `${role}.sequence.${index}`);
    assertNonEmptyString(entry.id, `${role}.sequence.${index}.id`);
    assertCliCommand(entry.command, `${role}.sequence.${index}.command`);
    assertNonEmptyString(entry.expectedTerminalOutput, `${role}.sequence.${index}.expectedTerminalOutput`);
    assertAcceptedFixtureId(entry.quickstartFixtureId, `${role}.sequence.${index}.quickstartFixtureId`);
    assertProofMode(entry.proofMode, `${role}.sequence.${index}.proofMode`);
    assertObject(entry.jsonResult, `${role}.sequence.${index}.jsonResult`);
    assertObject(entry.mcpResult, `${role}.sequence.${index}.mcpResult`);
    assertLiteral(entry.jsonResult.schema, "hobo.role-journey-cli-mcp-result/v1", `${entry.id}.json.schema`);
    assertLiteral(entry.jsonResult.fixtureId, entry.quickstartFixtureId, `${entry.id}.json.fixtureId`);
    assertLiteral(entry.jsonResult.proofMode, entry.proofMode, `${entry.id}.json.proofMode`);
    assertLiteral(entry.mcpResult.fixtureId, entry.quickstartFixtureId, `${entry.id}.mcp.fixtureId`);
    assertLiteral(entry.mcpResult.proofMode, entry.proofMode, `${entry.id}.mcp.proofMode`);
    assertLiteral(
      entry.mcpResult.resultSchema,
      "hobo.role-journey-cli-mcp-result/v1",
      `${entry.id}.mcp.resultSchema`,
    );
    assertMcpTool(entry.mcpResult.tool, `${entry.id}.mcp.tool`);
    assertNonEmptyString(entry.supportHandoff, `${entry.id}.supportHandoff`);
    assertNonEmptyString(entry.accessibilityNote, `${entry.id}.accessibilityNote`);

    // SAFETY: `return entry as RoleJourneyStep;` is required at this I/O or test boundary.
    return entry as RoleJourneyStep;
  });
}

function assertRoleCoverage(journeys: readonly RoleJourney[]): void {
  const roles = new Set(journeys.map((journey) => journey.role));
  for (const role of REQUIRED_ROLE_JOURNEY_ROLES) {
    if (!roles.has(role)) {
      throw new TypeError(`missing role journey ${role}`);
    }
  }
  if (roles.size !== journeys.length) {
    throw new TypeError("role journeys must be unique");
  }
}

function assertAggregateCoverage(journeys: readonly RoleJourney[]): void {
  const coverage = new Set(journeys.flatMap((journey) => journey.coverage));
  for (const required of REQUIRED_ROLE_JOURNEY_COVERAGE) {
    if (!coverage.has(required)) {
      throw new TypeError(`missing role journey coverage ${required}`);
    }
  }
}

function assertCoverageArray(value: JsonValue, name: string): void {
  const entries = assertStringArray(value, name);
  for (const entry of entries) {
    // SAFETY: `if (!REQUIRED_ROLE_JOURNEY_COVERAGE.includes(entry as RoleJourneyCoverage)) {` is required at this I/O or test boundary.
    if (!REQUIRED_ROLE_JOURNEY_COVERAGE.includes(entry as RoleJourneyCoverage)) {
      throw new TypeError(`${name} contains unsupported coverage ${entry}`);
    }
  }
}

function assertNegativePaths(value: JsonValue, role: JsonValue): void {
  const entries = assertStringArray(value, `${String(role)}.negativePaths`);
  for (const path of REQUIRED_ROLE_JOURNEY_NEGATIVE_PATHS) {
    if (!entries.includes(path)) {
      throw new TypeError(`${String(role)} missing negative path ${path}`);
    }
  }
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

function assertNonEmptyString(value: JsonValue, name: string): asserts value is string {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function assertRole(value: JsonValue): asserts value is RoleJourneyRole {
  // SAFETY: `if (!REQUIRED_ROLE_JOURNEY_ROLES.includes(value as RoleJourneyRole)) {` is required at this I/O or test boundary.
  if (!REQUIRED_ROLE_JOURNEY_ROLES.includes(value as RoleJourneyRole)) {
    throw new TypeError(`unknown role ${String(value)}`);
  }
}

function assertCliCommand(value: JsonValue, name: string): asserts value is `hobo ${string}` {
  if (!isJsonString(value) || !value.startsWith("hobo ")) {
    throw new TypeError(`${name} must be CLI-first and start with hobo`);
  }
}

function assertMcpTool(value: JsonValue, name: string): asserts value is `hobo_${string}` {
  if (!isJsonString(value) || !value.startsWith("hobo_")) {
    throw new TypeError(`${name} must use the hobo MCP namespace`);
  }
}

function assertProofMode(value: JsonValue, name: string): asserts value is RoleJourneyProofMode {
  if (value !== "reference-fixture" && value !== "simulated" && value !== "scope-out") {
    throw new TypeError(`${name} must be a non-live proof mode`);
  }
}

function assertAcceptedFixtureId(value: JsonValue, name: string): asserts value is string {
  if (!isJsonString(value) || !acceptedFixtureIds.includes(value)) {
    throw new TypeError(`${name} must reference an accepted HOBO-577 quickstart fixture id`);
  }
}
