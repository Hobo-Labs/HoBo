import {
  ACTIVATION_RAIL_STAGES,
  VIBE_FIRST_RUN_ACTIVATION_RAIL,
} from "../../../ux/vibe-first-run-activation-rail/src/vibe-first-run-activation-rail.ts";
import {
  WORKSPACE_PROJECT_STATES,
  VIBE_WORKSPACE_PROJECT_STATE_MODEL,
} from "../../../ux/vibe-workspace-project-states/src/vibe-workspace-project-states.ts";

export const REQUIRED_FIRST_RUN_WALKTHROUGH_STAGES = [
  "workspace-entry",
  "project-setup",
  "plan-preview",
  "blocked-recovery",
  "value-proof",
] as const;

export const REQUIRED_FIRST_RUN_WALKTHROUGH_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_FIRST_RUN_WALKTHROUGH_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_FIRST_RUN_HANDOFF_SURFACES = [
  "docs-portal",
  "tutorials",
  "troubleshooting",
  "support-workflow",
] as const;

type WalkthroughStage = (typeof REQUIRED_FIRST_RUN_WALKTHROUGH_STAGES)[number];
type WalkthroughScenario = (typeof REQUIRED_FIRST_RUN_WALKTHROUGH_SCENARIOS)[number];
type WalkthroughProofMode = (typeof REQUIRED_FIRST_RUN_WALKTHROUGH_PROOF_MODES)[number];
type HandoffSurface = (typeof REQUIRED_FIRST_RUN_HANDOFF_SURFACES)[number];
type ActivationRailStage = (typeof ACTIVATION_RAIL_STAGES)[number];
type WorkspaceProjectState = (typeof WORKSPACE_PROJECT_STATES)[number];

type ConsumedActivationRail = {
  readonly sourceIssue: "HOBO-540";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-first-run-activation-rail";
  readonly proofPath: "docs/design/proofs/vibe-first-run-activation-rail/README.md";
  readonly stages: readonly ActivationRailStage[];
};

type ConsumedWorkspaceProjectStates = {
  readonly sourceIssue: "HOBO-541";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-workspace-project-states";
  readonly proofPath: "docs/design/proofs/vibe-workspace-project-states/README.md";
  readonly states: readonly WorkspaceProjectState[];
};

type SnapshopFixtureRef = {
  readonly fixtureId: string;
  readonly snapshopContext: string;
  readonly quickstartFixtureId: string;
};

type WalkthroughStep = {
  readonly stage: WalkthroughStage;
  readonly activationRailStage: ActivationRailStage;
  readonly workspaceProjectState: WorkspaceProjectState;
  readonly title: string;
  readonly persona: string;
  readonly clickableAction: string;
  readonly snapshopFixture: SnapshopFixtureRef;
  readonly proofMode: WalkthroughProofMode;
  readonly docsHandoff: string;
  readonly supportHandoff: string;
  readonly accessibilityNote: string;
};

type ScenarioPath = {
  readonly id: WalkthroughScenario;
  readonly stageIds: readonly WalkthroughStage[];
  readonly narrative: string;
  readonly safeOutcome: string;
};

type HandoffRoute = {
  readonly surface: HandoffSurface;
  readonly trigger: string;
  readonly owner: string;
  readonly evidenceAnchor: string;
  readonly customerSafeMessage: string;
};

type SupportHandoffEvidence = {
  readonly severity: string;
  readonly redactionState: string;
  readonly evidenceLink: string;
  readonly nextUpdateCondition: string;
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

export type VibeClickableFirstRunWalkthrough = {
  readonly issue: "HOBO-559";
  readonly phase: "M2";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough";
  readonly proofPath: "docs/design/proofs/vibe-clickable-first-run-walkthrough/README.md";
  readonly designRefs: readonly string[];
  readonly consumedActivationRail: ConsumedActivationRail;
  readonly consumedWorkspaceProjectStates: ConsumedWorkspaceProjectStates;
  readonly steps: readonly WalkthroughStep[];
  readonly scenarioPaths: readonly ScenarioPath[];
  readonly handoffRoutes: readonly HandoffRoute[];
  readonly supportHandoffEvidence: SupportHandoffEvidence;
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

declare const parsedClickableFirstRunWalkthroughBrand: unique symbol;

export type ParsedVibeClickableFirstRunWalkthrough = VibeClickableFirstRunWalkthrough & {
  readonly [parsedClickableFirstRunWalkthroughBrand]: true;
};

export const VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH: VibeClickableFirstRunWalkthrough = {
  issue: "HOBO-559",
  phase: "M2",
  packagePath: "src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough",
  proofPath: "docs/design/proofs/vibe-clickable-first-run-walkthrough/README.md",
  designRefs: [
    "docs/design/workspace-onboarding-ux.md",
    "docs/design/outcome-activation-rail.md",
    "docs/design/walkthrough.md",
    "docs/design/proofs/vibe-first-run-activation-rail/README.md",
    "docs/design/proofs/vibe-workspace-project-states/README.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  consumedActivationRail: {
    sourceIssue: "HOBO-540",
    packagePath: "src/draft/exp-proofs/ux/vibe-first-run-activation-rail",
    proofPath: "docs/design/proofs/vibe-first-run-activation-rail/README.md",
    stages: ACTIVATION_RAIL_STAGES,
  },
  consumedWorkspaceProjectStates: {
    sourceIssue: "HOBO-541",
    packagePath: "src/draft/exp-proofs/ux/vibe-workspace-project-states",
    proofPath: "docs/design/proofs/vibe-workspace-project-states/README.md",
    states: WORKSPACE_PROJECT_STATES,
  },
  steps: [
    {
      stage: "workspace-entry",
      activationRailStage: "workspace",
      workspaceProjectState: "empty",
      title: "Enter snapshop workspace from invite or try-it",
      persona: "app developer",
      clickableAction: "Open the snapshop try-it link and review workspace empty-state fixture",
      snapshopFixture: {
        fixtureId: "vcfrw-workspace-entry-v1",
        snapshopContext: "snapshop anonymous try-it workspace with no project selected",
        quickstartFixtureId: "rlq-define-object-graph-v1",
      },
      proofMode: "live",
      docsHandoff: "docs/design/proofs/vibe-docs-portal-ia-states/README.md#getting-started",
      supportHandoff: "support receives invite context only when access prerequisite blocks entry",
      accessibilityNote: "Workspace entry exposes keyboard focus order and text status, not color-only invite state.",
    },
    {
      stage: "project-setup",
      activationRailStage: "project",
      workspaceProjectState: "ready",
      title: "Create snapshop project from deterministic fixture",
      persona: "team admin",
      clickableAction: "Select create-project and bind the snapshop manifest fixture",
      snapshopFixture: {
        fixtureId: "vcfrw-project-setup-v1",
        snapshopContext: "snapshop project context with collected manifest IR fixture",
        quickstartFixtureId: "rlq-collect-manifest-ir-v1",
      },
      proofMode: "simulated",
      docsHandoff: "docs/design/proofs/vibe-role-tutorial-outlines/README.md#app-developer",
      supportHandoff: "support routes missing project prerequisite to workspace onboarding owner",
      accessibilityNote: "Project setup labels owner, blocker, and next action as headings.",
    },
    {
      stage: "plan-preview",
      activationRailStage: "plan-preview",
      workspaceProjectState: "blocked",
      title: "Preview snapshop plan with policy and risk annotations",
      persona: "platform engineer",
      clickableAction: "Open plan preview and inspect Gatekeeper disposition on snapshop deployment plan",
      snapshopFixture: {
        fixtureId: "vcfrw-plan-preview-v1",
        snapshopContext: "snapshop plan preview with policy-blocked deploy annotation",
        quickstartFixtureId: "rlq-plan-safe-preview-v1",
      },
      proofMode: "simulated",
      docsHandoff: "docs/design/proofs/vibe-plan-review-states/README.md#blocked",
      supportHandoff: "support handoff includes plan id, blocker owner, and customer-safe refusal wording",
      accessibilityNote: "Plan preview announces blocked versus safe states in plain language.",
    },
    {
      stage: "blocked-recovery",
      activationRailStage: "recovery",
      workspaceProjectState: "recovering",
      title: "Recover from blocked or stale snapshop evidence",
      persona: "support operator",
      clickableAction: "Follow recovery route when projection evidence is stale or unknown",
      snapshopFixture: {
        fixtureId: "vcfrw-blocked-recovery-v1",
        snapshopContext: "snapshop recovery path after stale projection evidence",
        quickstartFixtureId: "rlq-manage-stale-evidence-v1",
      },
      proofMode: "reference fixture",
      docsHandoff: "docs/design/proofs/vibe-troubleshooting-decision-trees/README.md#stale-evidence",
      supportHandoff: "support receives redacted evidence pack with owner route and next update condition",
      accessibilityNote: "Recovery step never presents stale evidence as a green success state.",
    },
    {
      stage: "value-proof",
      activationRailStage: "value-proof",
      workspaceProjectState: "value-proven",
      title: "Show snapshop value proof from accepted fixture evidence",
      persona: "app developer",
      clickableAction: "Inspect simulated deploy acceptance and value-proof summary for snapshop",
      snapshopFixture: {
        fixtureId: "vcfrw-value-proof-v1",
        snapshopContext: "snapshop value proof after simulated deploy acceptance",
        quickstartFixtureId: "rlq-deploy-run-accepted-v1",
      },
      proofMode: "scope-out",
      docsHandoff: "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md#recover",
      supportHandoff: "support references proof package link without creating live tickets",
      accessibilityNote: "Value proof distinguishes simulated acceptance from live launch claims.",
    },
  ],
  scenarioPaths: [
    {
      id: "happy-path",
      stageIds: ["workspace-entry", "project-setup", "plan-preview", "value-proof"],
      narrative:
        "Developer enters snapshop workspace, creates project, previews safe plan, and reaches simulated value proof.",
      safeOutcome: "continue with fixture-backed simulated evidence without live provider or launch claims",
    },
    {
      id: "blocked-path",
      stageIds: ["project-setup", "plan-preview", "blocked-recovery"],
      narrative: "Missing prerequisite or policy block stops snapshop plan preview and routes to recovery owner.",
      safeOutcome: "stop and route blocker to docs, support, or owning surface before any deploy action",
    },
    {
      id: "stale-or-unknown-evidence",
      stageIds: ["plan-preview", "blocked-recovery", "value-proof"],
      narrative: "Stale or unknown projection evidence keeps snapshop walkthrough non-green until recovery refreshes proof.",
      safeOutcome: "mark not ready, preserve redacted evidence, and wait for owner route",
    },
    {
      id: "support-handoff",
      stageIds: ["blocked-recovery", "value-proof"],
      narrative: "Support receives redacted snapshop context, severity, docs anchor, and next update condition.",
      safeOutcome: "customer receives support-safe update while docs owner tracks guidance impact",
    },
  ],
  handoffRoutes: [
    {
      surface: "docs-portal",
      trigger: "user needs getting-started or architecture context during workspace entry",
      owner: "docs portal owner",
      evidenceAnchor: "docs/design/proofs/vibe-docs-portal-ia-states/README.md",
      customerSafeMessage: "Docs link references fixture evidence; no live tenant data is exposed.",
    },
    {
      surface: "tutorials",
      trigger: "project setup or first proof needs role tutorial guidance",
      owner: "tutorial owner",
      evidenceAnchor: "docs/design/proofs/vibe-role-tutorial-outlines/README.md",
      customerSafeMessage: "Tutorial path stays simulated and cites accepted quickstart fixture ids.",
    },
    {
      surface: "troubleshooting",
      trigger: "blocked or stale evidence needs diagnostic tree routing",
      owner: "troubleshooting owner",
      evidenceAnchor: "docs/design/proofs/vibe-troubleshooting-decision-trees/README.md",
      customerSafeMessage: "Troubleshooting tree names owner and safe next action without live repair.",
    },
    {
      surface: "support-workflow",
      trigger: "recovery or blocked path needs customer-safe support update",
      owner: "support workflow owner",
      evidenceAnchor: "docs/design/proofs/vibe-support-workflow-mockups/README.md",
      customerSafeMessage: "Support handoff stays redacted and does not open live queues in this proof.",
    },
  ],
  supportHandoffEvidence: {
    severity: "SEV3 first-run workflow blocked",
    redactionState: "customer-safe redacted snapshop fixture evidence only",
    evidenceLink: "docs/design/proofs/vibe-clickable-first-run-walkthrough/README.md",
    nextUpdateCondition:
      "support updates customer when owner route accepts evidence or blocker status changes",
  },
  accessibilityNotes: [
    "Keyboard order follows workspace entry, project setup, plan preview, blocked recovery, and value proof.",
    "Screen reader labels include stage, proof mode, blocker owner, support severity, and safe next action.",
    "Color is never the only signal for blocked, stale, support-routed, or accepted fixture states.",
    "Motion is optional and walkthrough transitions must respect reduced-motion preferences.",
  ],
  scopeOut: [
    "No production onboarding UI.",
    "No auth, account, or billing services.",
    "No live provider calls or cloud credentials.",
    "No customer data or raw tenant identifiers.",
    "No launch claims without evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(production onboarding|ship onboarding ui|production ui)\b/i,
  /\b(auth service|account service|billing service|billing flow)\b/i,
  /\b(live provider|provider call|real provider|cloud credential|credential)\b/i,
  /\b(customer data|tenant data|raw tenant|customer pii)\b/i,
  /\b(launch claim|go live|launch ready).*\b(without evidence)?\b/i,
];

export type ClickableFirstRunRequestClassification = "in-scope-proof" | "scope-out";

export class VibeClickableFirstRunWalkthroughParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(
      `Vibe clickable first-run walkthrough failed parsing: ${errors.map((error) => error.code).join(", ")}`,
    );
    this.name = "VibeClickableFirstRunWalkthroughParseError";
  }
}

export function parseVibeClickableFirstRunWalkthrough(
  walkthrough: VibeClickableFirstRunWalkthrough,
): ParsedVibeClickableFirstRunWalkthrough {
  const validation = validateVibeClickableFirstRunWalkthrough(walkthrough);

  if (!validation.ok) {
    throw new VibeClickableFirstRunWalkthroughParseError(validation.errors);
  }

  // SAFETY: `return walkthrough as ParsedVibeClickableFirstRunWalkthrough;` is required at this I/O or test boundary.
  return walkthrough as ParsedVibeClickableFirstRunWalkthrough;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibeClickableFirstRunWalkthrough(
  walkthrough: VibeClickableFirstRunWalkthrough,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (walkthrough.issue !== "HOBO-559") {
    errors.push({ code: "wrong-issue", message: "walkthrough must pin HOBO-559" });
  }
  if (walkthrough.phase !== "M2") {
    errors.push({ code: "wrong-phase", message: "walkthrough must stay in M2" });
  }
  if (walkthrough.packagePath !== "src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (walkthrough.proofPath !== "docs/design/proofs/vibe-clickable-first-run-walkthrough/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }

  validateConsumedActivationRail(walkthrough.consumedActivationRail, errors);
  validateConsumedWorkspaceProjectStates(walkthrough.consumedWorkspaceProjectStates, errors);
  validateSteps(walkthrough.steps, errors);
  validateScenarios(walkthrough.scenarioPaths, errors);
  validateHandoffRoutes(walkthrough.handoffRoutes, errors);
  validateSupportHandoff(walkthrough.supportHandoffEvidence, errors);
  validateAccessibility(walkthrough.accessibilityNotes, errors);

  return { ok: errors.length === 0, errors };
}

export function classifyClickableFirstRunWalkthroughRequest(
  summary: string,
): ClickableFirstRunRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

function validateConsumedActivationRail(
  consumed: ConsumedActivationRail,
  errors: ValidationError[],
): void {
  if (consumed.sourceIssue !== "HOBO-540") {
    errors.push({ code: "wrong-consumed-rail-issue", message: "walkthrough must consume HOBO-540" });
  }
  if (consumed.packagePath !== "src/draft/exp-proofs/ux/vibe-first-run-activation-rail") {
    errors.push({ code: "wrong-consumed-rail-package", message: "HOBO-540 package path drifted" });
  }
  if (consumed.proofPath !== "docs/design/proofs/vibe-first-run-activation-rail/README.md") {
    errors.push({ code: "wrong-consumed-rail-proof", message: "HOBO-540 proof path drifted" });
  }
  if (!arraysEqual(consumed.stages, ACTIVATION_RAIL_STAGES)) {
    errors.push({ code: "consumed-rail-stage-drift", message: "HOBO-540 activation rail stages drifted" });
  }
  if (!arraysEqual(consumed.stages, VIBE_FIRST_RUN_ACTIVATION_RAIL.stateModel.map((state) => state.stage))) {
    errors.push({
      code: "consumed-rail-model-drift",
      message: "HOBO-540 state model stages must match consumed activation rail",
    });
  }
}

function validateConsumedWorkspaceProjectStates(
  consumed: ConsumedWorkspaceProjectStates,
  errors: ValidationError[],
): void {
  if (consumed.sourceIssue !== "HOBO-541") {
    errors.push({ code: "wrong-consumed-state-issue", message: "walkthrough must consume HOBO-541" });
  }
  if (consumed.packagePath !== "src/draft/exp-proofs/ux/vibe-workspace-project-states") {
    errors.push({ code: "wrong-consumed-state-package", message: "HOBO-541 package path drifted" });
  }
  if (consumed.proofPath !== "docs/design/proofs/vibe-workspace-project-states/README.md") {
    errors.push({ code: "wrong-consumed-state-proof", message: "HOBO-541 proof path drifted" });
  }
  if (!arraysEqual(consumed.states, WORKSPACE_PROJECT_STATES)) {
    errors.push({ code: "consumed-state-drift", message: "HOBO-541 workspace/project states drifted" });
  }
  if (!arraysEqual(consumed.states, VIBE_WORKSPACE_PROJECT_STATE_MODEL.fixtures.map((fixture) => fixture.state))) {
    errors.push({
      code: "consumed-state-model-drift",
      message: "HOBO-541 fixture states must match consumed workspace/project states",
    });
  }
}

function validateSteps(steps: readonly WalkthroughStep[], errors: ValidationError[]): void {
  if (!arraysEqual(steps.map((step) => step.stage), REQUIRED_FIRST_RUN_WALKTHROUGH_STAGES)) {
    errors.push({
      code: "missing-walkthrough-stage",
      message: "walkthrough must cover all first-run stages",
    });
  }

  const proofModes = new Set<WalkthroughProofMode>();
  for (const step of steps) {
    if (!ACTIVATION_RAIL_STAGES.includes(step.activationRailStage)) {
      errors.push({
        code: "unknown-activation-stage",
        message: `${step.stage} references unknown activation rail stage`,
      });
    }
    if (!WORKSPACE_PROJECT_STATES.includes(step.workspaceProjectState)) {
      errors.push({
        code: "unknown-workspace-state",
        message: `${step.stage} references unknown workspace/project state`,
      });
    }
    for (const [field, value] of [
      ["title", step.title],
      ["persona", step.persona],
      ["clickableAction", step.clickableAction],
      ["docsHandoff", step.docsHandoff],
      ["supportHandoff", step.supportHandoff],
      ["accessibilityNote", step.accessibilityNote],
    ] as const) {
      if (value.trim().length === 0) {
        errors.push({ code: "missing-step-field", message: `${step.stage}.${field} must not be empty` });
      }
    }
    if (!/^vcfrw-[a-z0-9-]+-v[0-9]+$/.test(step.snapshopFixture.fixtureId)) {
      errors.push({ code: "invalid-fixture-id", message: `${step.stage} fixture id is invalid` });
    }
    if (!/^rlq-[a-z0-9-]+-v[0-9]+$/.test(step.snapshopFixture.quickstartFixtureId)) {
      errors.push({
        code: "invalid-quickstart-fixture-id",
        message: `${step.stage} quickstart fixture id is invalid`,
      });
    }
    if (!step.snapshopFixture.snapshopContext.toLowerCase().includes("snapshop")) {
      errors.push({
        code: "missing-snapshop-context",
        message: `${step.stage} must name snapshop fixture context`,
      });
    }
    if (!REQUIRED_FIRST_RUN_WALKTHROUGH_PROOF_MODES.includes(step.proofMode)) {
      errors.push({ code: "unknown-proof-mode", message: `${step.stage} has an unknown proof mode` });
    } else {
      proofModes.add(step.proofMode);
    }
  }
  if (!arraysEqual([...proofModes], REQUIRED_FIRST_RUN_WALKTHROUGH_PROOF_MODES)) {
    errors.push({ code: "missing-proof-mode", message: "walkthrough must cover all proof mode labels" });
  }
}

function validateScenarios(scenarios: readonly ScenarioPath[], errors: ValidationError[]): void {
  if (!arraysEqual(scenarios.map((scenario) => scenario.id), REQUIRED_FIRST_RUN_WALKTHROUGH_SCENARIOS)) {
    errors.push({ code: "missing-scenario-path", message: "walkthrough must cover all scenario paths" });
  }
  for (const scenario of scenarios) {
    if (!scenario.narrative || !scenario.safeOutcome || scenario.stageIds.length === 0) {
      errors.push({ code: "incomplete-scenario", message: `${scenario.id} is missing scenario detail` });
    }
    if (
      scenario.id === "stale-or-unknown-evidence" &&
      /\b(mark ready|green|continue launch|launch ready)\b/i.test(scenario.safeOutcome)
    ) {
      errors.push({
        code: "unsafe-stale-outcome",
        message: "stale or unknown evidence must not become green or launch-ready",
      });
    }
  }
}

function validateHandoffRoutes(routes: readonly HandoffRoute[], errors: ValidationError[]): void {
  if (!arraysEqual(routes.map((route) => route.surface), REQUIRED_FIRST_RUN_HANDOFF_SURFACES)) {
    errors.push({ code: "missing-handoff-route", message: "all docs/support handoff surfaces must be present" });
  }
  for (const route of routes) {
    for (const [field, value] of [
      ["trigger", route.trigger],
      ["owner", route.owner],
      ["evidenceAnchor", route.evidenceAnchor],
      ["customerSafeMessage", route.customerSafeMessage],
    ] as const) {
      if (value.trim().length === 0) {
        errors.push({ code: "missing-handoff-field", message: `${route.surface}.${field} must not be empty` });
      }
    }
    if (!route.evidenceAnchor.startsWith("docs/design/proofs/")) {
      errors.push({
        code: "invalid-handoff-anchor",
        message: `${route.surface} evidence anchor must point to a proof note`,
      });
    }
  }
}

function validateSupportHandoff(support: SupportHandoffEvidence, errors: ValidationError[]): void {
  for (const [field, value] of [
    ["severity", support.severity],
    ["redactionState", support.redactionState],
    ["evidenceLink", support.evidenceLink],
    ["nextUpdateCondition", support.nextUpdateCondition],
  ] as const) {
    if (value.trim().length === 0) {
      errors.push({ code: "missing-support-field", message: `support.${field} must not be empty` });
    }
  }
}

function validateAccessibility(notes: readonly string[], errors: ValidationError[]): void {
  const noteText = notes.join(" ").toLowerCase();
  for (const requiredNote of ["keyboard", "screen reader", "color", "motion"]) {
    if (!noteText.includes(requiredNote)) {
      errors.push({
        code: "missing-accessibility-note",
        message: `accessibility notes must include ${requiredNote}`,
      });
    }
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
