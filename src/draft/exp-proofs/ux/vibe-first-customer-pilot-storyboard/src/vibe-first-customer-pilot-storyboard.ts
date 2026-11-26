export const REQUIRED_PILOT_STORYBOARD_PERSONAS = [
  "pilot customer champion",
  "customer success lead",
  "support engineer",
  "release owner",
  "security reviewer",
] as const;

export const REQUIRED_PILOT_STORYBOARD_STAGES = [
  "invite",
  "workspace-setup",
  "project-choice",
  "first-proof",
  "failure-recovery",
  "support-handoff",
  "feedback-capture",
] as const;

export const REQUIRED_PILOT_STORYBOARD_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_PILOT_STORYBOARD_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_PILOT_QUICKSTART_FIXTURE_IDS = [
  "rlq-define-object-graph-v1",
  "rlq-plan-safe-preview-v1",
  "rlq-deploy-run-accepted-v1",
  "rlq-manage-stale-evidence-v1",
  "rlq-recover-scope-out-v1",
] as const;

type PilotPersona = (typeof REQUIRED_PILOT_STORYBOARD_PERSONAS)[number];
type PilotStage = (typeof REQUIRED_PILOT_STORYBOARD_STAGES)[number];
type PilotScenario = (typeof REQUIRED_PILOT_STORYBOARD_SCENARIOS)[number];
type PilotProofMode = (typeof REQUIRED_PILOT_STORYBOARD_PROOF_MODES)[number];
type PilotQuickstartFixtureId = (typeof REQUIRED_PILOT_QUICKSTART_FIXTURE_IDS)[number];

type StoryboardStep = {
  readonly stage: PilotStage;
  readonly title: string;
  readonly personas: readonly PilotPersona[];
  readonly operatingQuestion: string;
  readonly evidenceSource: string;
};

type ScriptArtifact = {
  readonly stage: PilotStage;
  readonly entryCriteria: string;
  readonly exitCriteria: string;
  readonly consentState: string;
  readonly proofMode: PilotProofMode;
  readonly blockerCategory: string;
  readonly owner: string;
  readonly safeNextAction: string;
  readonly customerSafeMessage: string;
};

type ScenarioPath = {
  readonly id: PilotScenario;
  readonly stageIds: readonly PilotStage[];
  readonly narrative: string;
  readonly safeOutcome: string;
};

type QuickstartFixtureRef = {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: PilotQuickstartFixtureId;
  readonly pilotUse: string;
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

type VibeFirstCustomerPilotStoryboard = {
  readonly issue: "HOBO-549";
  readonly phase: "M1";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-first-customer-pilot-storyboard";
  readonly proofPath: "docs/design/proofs/vibe-first-customer-pilot-storyboard/README.md";
  readonly designRefs: readonly string[];
  readonly quickstartFixtureRefs: readonly QuickstartFixtureRef[];
  readonly personas: readonly PilotPersona[];
  readonly storyboard: readonly StoryboardStep[];
  readonly scriptArtifacts: readonly ScriptArtifact[];
  readonly scenarioPaths: readonly ScenarioPath[];
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

declare const parsedPilotStoryboardBrand: unique symbol;

export type ParsedVibeFirstCustomerPilotStoryboard = VibeFirstCustomerPilotStoryboard & {
  readonly [parsedPilotStoryboardBrand]: true;
};

const QUICKSTART_REFS: readonly QuickstartFixtureRef[] = [
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-define-object-graph-v1",
    pilotUse: "Invite and project-choice copy reuse the canonical object-graph fixture instead of collecting customer project data.",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-plan-safe-preview-v1",
    pilotUse: "Workspace setup and first proof stages reuse the accepted plan preview fixture for safe readiness wording.",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-deploy-run-accepted-v1",
    pilotUse: "The first proof step cites deploy-run evidence as simulated acceptance, not a live provider deployment.",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-manage-stale-evidence-v1",
    pilotUse: "Failure recovery uses the stale evidence fixture to route blockers without treating unknown evidence as green.",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-scope-out-v1",
    pilotUse: "Support and feedback stages inherit the quickstart scope-out label for production restore, tenant mutation, and launch claims.",
  },
];

export const VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD: VibeFirstCustomerPilotStoryboard = {
  issue: "HOBO-549",
  phase: "M1",
  packagePath: "src/draft/exp-proofs/ux/vibe-first-customer-pilot-storyboard",
  proofPath: "docs/design/proofs/vibe-first-customer-pilot-storyboard/README.md",
  designRefs: [
    "docs/design/customer-onboarding.md",
    "docs/design/workspace-onboarding-ux.md",
    "docs/design/beta-pilot-feedback.md",
    "docs/design/launch-demo-golden-path.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/launch-blocker-taxonomy.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  quickstartFixtureRefs: QUICKSTART_REFS,
  personas: REQUIRED_PILOT_STORYBOARD_PERSONAS,
  storyboard: [
    {
      stage: "invite",
      title: "Pilot invite and consent checkpoint",
      personas: ["pilot customer champion", "customer success lead", "security reviewer"],
      operatingQuestion: "Can the customer champion see the pilot purpose, support window, consent boundary, and safe first step?",
      evidenceSource: "Customer onboarding script fixture plus HOBO-577 object-graph quickstart source",
    },
    {
      stage: "workspace-setup",
      title: "Workspace setup with missing-prerequisite state",
      personas: ["pilot customer champion", "customer success lead", "support engineer"],
      operatingQuestion: "Which workspace prerequisite is ready, blocked, or not collected, and who owns the next safe action?",
      evidenceSource: "Workspace onboarding state fixture and safe plan preview quickstart source",
    },
    {
      stage: "project-choice",
      title: "Sample or real project choice",
      personas: ["pilot customer champion", "customer success lead", "security reviewer"],
      operatingQuestion: "Does the pilot choose sample fixture evidence or a redacted real-project path without exposing customer data?",
      evidenceSource: "Reference project-choice script artifact and quickstart fixture labels",
    },
    {
      stage: "first-proof",
      title: "First accepted proof or explicit blocker",
      personas: ["pilot customer champion", "release owner", "support engineer"],
      operatingQuestion: "Is there accepted simulated proof, a routed blocker, or a stop condition before any provider claim is made?",
      evidenceSource: "HOBO-577 deploy-run and stale-evidence fixtures",
    },
    {
      stage: "failure-recovery",
      title: "Recovery route for blocked or stale evidence",
      personas: ["support engineer", "release owner", "security reviewer"],
      operatingQuestion: "What blocker category, owner, safe next action, and customer-safe wording prevent a false green state?",
      evidenceSource: "Launch blocker taxonomy and stale evidence quickstart fixture",
    },
    {
      stage: "support-handoff",
      title: "Support handoff record",
      personas: ["support engineer", "customer success lead", "release owner"],
      operatingQuestion: "Can support receive the stage, severity, owner route, evidence link, and redacted customer message?",
      evidenceSource: "Launch support escalation handoff shape",
    },
    {
      stage: "feedback-capture",
      title: "Feedback capture and release routing",
      personas: ["release owner", "customer success lead", "security reviewer"],
      operatingQuestion: "Can the release owner classify feedback into cutline, docs, product UX, support, or engineering follow-up?",
      evidenceSource: "Beta pilot feedback and release cutline routing fixtures",
    },
  ],
  scriptArtifacts: [
    {
      stage: "invite",
      entryCriteria: "consent request prepared with workspace owner and support window",
      exitCriteria: "accepted pilot invite routed with owner and safe next action",
      consentState: "captured before any live customer conversation",
      proofMode: "live",
      blockerCategory: "none",
      owner: "customer success lead",
      safeNextAction: "continue to workspace setup using fixture-safe prep",
      customerSafeMessage: "Pilot starts with no secrets and no provider access.",
    },
    {
      stage: "workspace-setup",
      entryCriteria: "workspace fixture selected and missing prerequisite list is visible",
      exitCriteria: "workspace setup owner routed with next action and accepted limitation",
      consentState: "captured; raw tenant identifiers redacted",
      proofMode: "simulated",
      blockerCategory: "product ux",
      owner: "workspace onboarding ux",
      safeNextAction: "retry setup with simulated prerequisite fixture",
      customerSafeMessage: "Workspace readiness is simulated until production tenant mutation is approved.",
    },
    {
      stage: "project-choice",
      entryCriteria: "project fixture or customer-redacted sample choice is ready",
      exitCriteria: "choice captured with owner, proof mode, and next action",
      consentState: "captured for sample; redacted for real-project discussion",
      proofMode: "reference fixture",
      blockerCategory: "security",
      owner: "security reviewer",
      safeNextAction: "choose sample fixture when customer data is not approved",
      customerSafeMessage: "Reference fixture avoids customer data while preserving the journey shape.",
    },
    {
      stage: "first-proof",
      entryCriteria: "proof fixture and support owner are ready before first accepted proof",
      exitCriteria: "accepted proof or blocker routed with owner and next action",
      consentState: "not required for checked-in fixture proof",
      proofMode: "simulated",
      blockerCategory: "engineering",
      owner: "pilot customer champion",
      safeNextAction: "continue only after simulated proof evidence is accepted",
      customerSafeMessage: "First proof is safe and simulated; it is not a live provider deploy.",
    },
    {
      stage: "failure-recovery",
      entryCriteria: "blocker or stale evidence detected in proof fixture",
      exitCriteria: "blocker routed with owner and safe next action",
      consentState: "redacted evidence packet only",
      proofMode: "reference fixture",
      blockerCategory: "docs",
      owner: "support engineer",
      safeNextAction: "handoff to support with stale evidence route",
      customerSafeMessage: "Evidence is not ready; support can proceed from redacted fixture details.",
    },
    {
      stage: "support-handoff",
      entryCriteria: "support severity and blocker category are known",
      exitCriteria: "handoff captured with owner and next action",
      consentState: "redacted support packet",
      proofMode: "scope-out",
      blockerCategory: "support",
      owner: "support engineer",
      safeNextAction: "handoff to support queue owner without building support tooling",
      customerSafeMessage: "Support has safe redacted context; support tooling is not implemented here.",
    },
    {
      stage: "feedback-capture",
      entryCriteria: "feedback note, support owner, and proof outcome are available",
      exitCriteria: "feedback captured and routed to cutline owner with next action",
      consentState: "captured with customer-safe feedback summary",
      proofMode: "reference fixture",
      blockerCategory: "cutline",
      owner: "release owner",
      safeNextAction: "route feedback to cutline, docs, product ux, support, or engineering",
      customerSafeMessage: "Feedback is captured as safe fixture evidence, not as launch readiness.",
    },
  ],
  scenarioPaths: [
    {
      id: "happy-path",
      stageIds: ["invite", "workspace-setup", "project-choice", "first-proof", "feedback-capture"],
      narrative: "Customer accepts the pilot, chooses fixture-safe setup, reaches simulated first proof, and records feedback.",
      safeOutcome: "continue pilot evidence review without provider deployment claims",
    },
    {
      id: "blocked-path",
      stageIds: ["workspace-setup", "project-choice", "failure-recovery"],
      narrative: "Missing workspace prerequisite or customer-data boundary blocks progress with owner and next action visible.",
      safeOutcome: "stop and route blocker to workspace, security, docs, support, or engineering owner",
    },
    {
      id: "stale-or-unknown-evidence",
      stageIds: ["first-proof", "failure-recovery", "support-handoff"],
      narrative: "Stale proof evidence renders as not ready and is handed off instead of becoming green customer wording.",
      safeOutcome: "handoff stale evidence with fixture id and customer-safe message",
    },
    {
      id: "support-handoff",
      stageIds: ["failure-recovery", "support-handoff", "feedback-capture"],
      narrative: "Support receives redacted evidence, severity, owner route, and a feedback channel for release decisions.",
      safeOutcome: "capture support outcome and release-owner cutline route",
    },
  ],
  accessibilityNotes: [
    "Keyboard order follows invite, workspace setup, project choice, first proof, recovery, support handoff, and feedback capture.",
    "Screen reader labels include stage, owner, proof mode, consent state, blocker category, and safe next action.",
    "Color is never the only signal for blocked, stale, scope-out, or accepted states.",
    "Motion is optional; storyboard transitions and recording scripts must respect reduced-motion preferences.",
  ],
  scopeOut: [
    "No CRM implementation.",
    "No customer-success automation.",
    "No support tooling or queue implementation.",
    "No live customer data or raw tenant identifiers.",
    "No production tenant mutation.",
    "No provider deployment or credentials.",
    "No launch claims without evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(crm|salesforce|hubspot)\b/i,
  /\b(customer success automation|automated onboarding|cs automation)\b/i,
  /\b(support tooling|support queue|ticketing|helpdesk)\b/i,
  /\b(live customer data|raw customer|customer pii|tenant data)\b/i,
  /\b(production tenant|mutate tenant|tenant mutation)\b/i,
  /\b(provider deployment|real provider|live provider|cloud credential|credential)\b/i,
  /\b(launch claim|launch readiness|go live).*\b(evidence|without evidence)?\b/i,
];

export type PilotStoryboardRequestClassification = "in-scope-proof" | "scope-out";

export class VibeFirstCustomerPilotStoryboardParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Vibe first-customer pilot storyboard failed parsing: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "VibeFirstCustomerPilotStoryboardParseError";
  }
}

export function parseVibeFirstCustomerPilotStoryboard(
  storyboard: VibeFirstCustomerPilotStoryboard,
): ParsedVibeFirstCustomerPilotStoryboard {
  const validation = validateVibeFirstCustomerPilotStoryboard(storyboard);

  if (!validation.ok) {
    throw new VibeFirstCustomerPilotStoryboardParseError(validation.errors);
  }

  // SAFETY: `return storyboard as ParsedVibeFirstCustomerPilotStoryboard;` is required at this I/O or test boundary.
  return storyboard as ParsedVibeFirstCustomerPilotStoryboard;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibeFirstCustomerPilotStoryboard(
  storyboard: VibeFirstCustomerPilotStoryboard,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (storyboard.issue !== "HOBO-549") {
    errors.push({ code: "wrong-issue", message: "storyboard contract must pin HOBO-549" });
  }
  if (storyboard.phase !== "M1") {
    errors.push({ code: "wrong-phase", message: "storyboard contract must stay in M1" });
  }
  if (storyboard.packagePath !== "src/draft/exp-proofs/ux/vibe-first-customer-pilot-storyboard") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (storyboard.proofPath !== "docs/design/proofs/vibe-first-customer-pilot-storyboard/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }
  if (!arraysEqual(storyboard.personas, REQUIRED_PILOT_STORYBOARD_PERSONAS)) {
    errors.push({ code: "missing-persona", message: "required persona set must be exact" });
  }

  validateQuickstartRefs(storyboard.quickstartFixtureRefs, errors);

  if (!arraysEqual(storyboard.storyboard.map((step) => step.stage), REQUIRED_PILOT_STORYBOARD_STAGES)) {
    errors.push({
      code: "missing-storyboard-stage",
      message: "storyboard must cover every required pilot stage in accepted order",
    });
  }

  const artifactStages = new Set(storyboard.scriptArtifacts.map((artifact) => artifact.stage));
  const proofModes = new Set<PilotProofMode>();
  for (const artifact of storyboard.scriptArtifacts) {
    if (!REQUIRED_PILOT_STORYBOARD_STAGES.includes(artifact.stage)) {
      errors.push({ code: "unknown-artifact-stage", message: `${artifact.stage} is not a required stage` });
    }
    for (const [field, value] of [
      ["entryCriteria", artifact.entryCriteria],
      ["exitCriteria", artifact.exitCriteria],
      ["consentState", artifact.consentState],
      ["blockerCategory", artifact.blockerCategory],
      ["owner", artifact.owner],
      ["safeNextAction", artifact.safeNextAction],
      ["customerSafeMessage", artifact.customerSafeMessage],
    ] as const) {
      if (value.trim().length === 0) {
        errors.push({ code: "missing-script-metadata", message: `${artifact.stage}.${field} must not be empty` });
      }
    }
    if (!REQUIRED_PILOT_STORYBOARD_PROOF_MODES.includes(artifact.proofMode)) {
      errors.push({
        code: "unsupported-proof-mode",
        message: `${artifact.stage} uses unsupported proof mode ${String(artifact.proofMode)}`,
      });
    } else {
      proofModes.add(artifact.proofMode);
    }
  }
  for (const stage of REQUIRED_PILOT_STORYBOARD_STAGES) {
    if (!artifactStages.has(stage)) {
      errors.push({ code: "missing-script-stage", message: `${stage} needs a script artifact` });
    }
  }
  if (!arraysEqual([...proofModes], REQUIRED_PILOT_STORYBOARD_PROOF_MODES)) {
    errors.push({
      code: "missing-proof-mode-label",
      message: "proof modes must cover live, simulated, reference fixture, and scope-out",
    });
  }

  if (!arraysEqual(storyboard.scenarioPaths.map((scenario) => scenario.id), REQUIRED_PILOT_STORYBOARD_SCENARIOS)) {
    errors.push({
      code: "missing-scenario-path",
      message: "scenario paths must cover happy, blocked, stale/unknown, and support handoff",
    });
  }
  for (const scenario of storyboard.scenarioPaths) {
    if (!scenario.narrative || !scenario.safeOutcome || scenario.stageIds.length === 0) {
      errors.push({ code: "incomplete-scenario", message: `${scenario.id} must name narrative and outcome` });
    }
  }

  const accessibilityText = storyboard.accessibilityNotes.join(" ").toLowerCase();
  for (const requiredNote of ["keyboard", "screen reader", "color", "motion"]) {
    if (!accessibilityText.includes(requiredNote)) {
      errors.push({
        code: "missing-accessibility-note",
        message: `accessibility notes must include ${requiredNote}`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function classifyPilotStoryboardRequest(summary: string): PilotStoryboardRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

function validateQuickstartRefs(
  refs: readonly QuickstartFixtureRef[],
  errors: ValidationError[],
): void {
  const fixtureIds = refs.map((ref) => ref.fixtureId);

  if (!arraysEqual(fixtureIds, REQUIRED_PILOT_QUICKSTART_FIXTURE_IDS)) {
    errors.push({
      code: "missing-quickstart-fixture",
      message: "pilot storyboard must cite required HOBO-577 fixture ids",
    });
  }
  for (const ref of refs) {
    if (ref.sourceIssue !== "HOBO-577") {
      errors.push({
        code: "wrong-quickstart-source",
        message: `${ref.fixtureId} must cite HOBO-577 as the quickstart source`,
      });
    }
    if (!REQUIRED_PILOT_QUICKSTART_FIXTURE_IDS.includes(ref.fixtureId)) {
      errors.push({
        code: "unknown-quickstart-fixture",
        message: `${ref.fixtureId} is not an accepted HOBO-549 fixture source`,
      });
    }
    if (!ref.pilotUse) {
      errors.push({
        code: "missing-quickstart-pilot-use",
        message: `${ref.fixtureId} must explain pilot storyboard consumption`,
      });
    }
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
