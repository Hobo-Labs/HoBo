import {
  REQUIRED_PILOT_STORYBOARD_STAGES,
} from "../../../ux/vibe-first-customer-pilot-storyboard/src/vibe-first-customer-pilot-storyboard.ts";

export const REQUIRED_PILOT_FIRST_PROOF_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_PILOT_FIRST_PROOF_BLOCKER_ROUTES = [
  "cutline",
  "docs",
  "product-ux",
  "support",
  "engineering",
] as const;

export const REQUIRED_PILOT_FIRST_PROOF_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

type PilotStage = (typeof REQUIRED_PILOT_STORYBOARD_STAGES)[number];
type PilotFirstProofScenario = (typeof REQUIRED_PILOT_FIRST_PROOF_SCENARIOS)[number];
type PilotFirstProofBlockerRoute = (typeof REQUIRED_PILOT_FIRST_PROOF_BLOCKER_ROUTES)[number];
type PilotFirstProofMode = (typeof REQUIRED_PILOT_FIRST_PROOF_PROOF_MODES)[number];

type ConsumedStoryboard = {
  readonly sourceIssue: "HOBO-549";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-first-customer-pilot-storyboard";
  readonly proofPath: "docs/design/proofs/vibe-first-customer-pilot-storyboard/README.md";
  readonly stages: readonly PilotStage[];
};

type WalkthroughStep = {
  readonly stage: PilotStage;
  readonly sourceStoryboardStage: PilotStage;
  readonly title: string;
  readonly persona: string;
  readonly userAction: string;
  readonly expectedEvidence: string;
  readonly blockerRoute: PilotFirstProofBlockerRoute;
  readonly proofMode: PilotFirstProofMode;
  readonly customerSafeMessage: string;
};

type ScenarioPath = {
  readonly id: PilotFirstProofScenario;
  readonly stageIds: readonly PilotStage[];
  readonly narrative: string;
  readonly safeOutcome: string;
};

type BlockerRoute = {
  readonly route: PilotFirstProofBlockerRoute;
  readonly trigger: string;
  readonly owner: string;
  readonly safeNextAction: string;
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

type VibePilotFirstProofWalkthrough = {
  readonly issue: "HOBO-563";
  readonly phase: "M2";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-pilot-first-proof-walkthrough";
  readonly proofPath: "docs/design/proofs/vibe-pilot-first-proof-walkthrough/README.md";
  readonly designRefs: readonly string[];
  readonly consumedStoryboard: ConsumedStoryboard;
  readonly steps: readonly WalkthroughStep[];
  readonly scenarioPaths: readonly ScenarioPath[];
  readonly blockerRoutes: readonly BlockerRoute[];
  readonly supportHandoffEvidence: SupportHandoffEvidence;
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

declare const parsedPilotFirstProofWalkthroughBrand: unique symbol;

export type ParsedVibePilotFirstProofWalkthrough = VibePilotFirstProofWalkthrough & {
  readonly [parsedPilotFirstProofWalkthroughBrand]: true;
};

export const VIBE_PILOT_FIRST_PROOF_WALKTHROUGH: VibePilotFirstProofWalkthrough = {
  issue: "HOBO-563",
  phase: "M2",
  packagePath: "src/draft/exp-proofs/ux/vibe-pilot-first-proof-walkthrough",
  proofPath: "docs/design/proofs/vibe-pilot-first-proof-walkthrough/README.md",
  designRefs: [
    "docs/design/customer-onboarding.md",
    "docs/design/workspace-onboarding-ux.md",
    "docs/design/support-workflow.md",
    "docs/design/beta-pilot-feedback.md",
    "docs/design/launch-blocker-taxonomy.md",
    "docs/design/proofs/vibe-first-customer-pilot-storyboard/README.md",
  ],
  consumedStoryboard: {
    sourceIssue: "HOBO-549",
    packagePath: "src/draft/exp-proofs/ux/vibe-first-customer-pilot-storyboard",
    proofPath: "docs/design/proofs/vibe-first-customer-pilot-storyboard/README.md",
    stages: REQUIRED_PILOT_STORYBOARD_STAGES,
  },
  steps: [
    {
      stage: "invite",
      sourceStoryboardStage: "invite",
      title: "Invite with consent and support window visible",
      persona: "pilot customer champion",
      userAction: "accept invite and confirm no secrets or customer data are required",
      expectedEvidence: "pilot invite fixture with consent, support owner, and safe first action",
      blockerRoute: "cutline",
      proofMode: "live",
      customerSafeMessage: "Pilot begins with no secrets, no provider credentials, and a safe support window.",
    },
    {
      stage: "workspace-setup",
      sourceStoryboardStage: "workspace-setup",
      title: "Workspace setup routes missing prerequisites",
      persona: "customer success lead",
      userAction: "review workspace readiness and identify missing prerequisite owner",
      expectedEvidence: "workspace fixture with blocked, ready, and recovery states",
      blockerRoute: "product-ux",
      proofMode: "simulated",
      customerSafeMessage: "Workspace readiness is simulated until product UX evidence is accepted.",
    },
    {
      stage: "project-choice",
      sourceStoryboardStage: "project-choice",
      title: "Sample-or-real project choice keeps data boundary explicit",
      persona: "security reviewer",
      userAction: "choose sample fixture or stop before exposing customer project data",
      expectedEvidence: "project-choice fixture with proof mode and redaction note",
      blockerRoute: "engineering",
      proofMode: "reference fixture",
      customerSafeMessage: "Reference fixture preserves journey shape without live customer data.",
    },
    {
      stage: "first-proof",
      sourceStoryboardStage: "first-proof",
      title: "First proof records accepted fixture or explicit blocker",
      persona: "pilot customer champion",
      userAction: "run the simulated first proof and inspect accepted or blocked evidence",
      expectedEvidence: "first-proof fixture with accepted simulated proof or blocker category",
      blockerRoute: "engineering",
      proofMode: "simulated",
      customerSafeMessage: "First proof is simulated evidence and is not a live provider deployment.",
    },
    {
      stage: "failure-recovery",
      sourceStoryboardStage: "failure-recovery",
      title: "Failure recovery turns stale evidence into an owner route",
      persona: "support engineer",
      userAction: "recover from blocked proof by routing stale or unknown evidence to owner",
      expectedEvidence: "recovery fixture with stale evidence, owner, safe next action, and route",
      blockerRoute: "docs",
      proofMode: "reference fixture",
      customerSafeMessage: "Evidence is not ready; docs or owner route is visible before continuing.",
    },
    {
      stage: "support-handoff",
      sourceStoryboardStage: "support-handoff",
      title: "Support handoff carries redacted context",
      persona: "support engineer",
      userAction: "handoff to support with severity, redaction, evidence link, and update condition",
      expectedEvidence: "support handoff fixture with customer-safe context and next update condition",
      blockerRoute: "support",
      proofMode: "scope-out",
      customerSafeMessage: "Support receives redacted context; support tooling is outside this proof.",
    },
    {
      stage: "feedback-capture",
      sourceStoryboardStage: "feedback-capture",
      title: "Feedback capture routes to release owner",
      persona: "release owner",
      userAction: "capture pilot feedback and route it to cutline, docs, product UX, support, or engineering",
      expectedEvidence: "feedback fixture with blocker category, owner, and customer-safe summary",
      blockerRoute: "cutline",
      proofMode: "reference fixture",
      customerSafeMessage: "Feedback fixture safely informs readiness routing, not a launch claim.",
    },
  ],
  scenarioPaths: [
    {
      id: "happy-path",
      stageIds: ["invite", "workspace-setup", "project-choice", "first-proof", "feedback-capture"],
      narrative: "Champion accepts the invite, uses fixture-safe setup, reaches simulated first proof, and captures feedback.",
      safeOutcome: "continue as accepted fixture evidence without live provider or customer-data claims",
    },
    {
      id: "blocked-path",
      stageIds: ["workspace-setup", "project-choice", "failure-recovery", "feedback-capture"],
      narrative: "A missing workspace prerequisite or project data boundary blocks progress and routes to the owning surface.",
      safeOutcome: "stop and route blocker to cutline, docs, product UX, support, or engineering owner",
    },
    {
      id: "stale-or-unknown-evidence",
      stageIds: ["first-proof", "failure-recovery", "support-handoff"],
      narrative: "Unknown or stale proof evidence remains non-green and moves to recovery or support.",
      safeOutcome: "mark not ready, preserve redacted evidence, and wait for owner route",
    },
    {
      id: "support-handoff",
      stageIds: ["failure-recovery", "support-handoff", "feedback-capture"],
      narrative: "Support receives redacted evidence, severity, owner route, and feedback classification.",
      safeOutcome: "customer receives support-safe update while release owner tracks readiness impact",
    },
  ],
  blockerRoutes: [
    {
      route: "cutline",
      trigger: "blocked pilot outcome affects beta or launch readiness",
      owner: "release owner",
      safeNextAction: "route to cutline with accepted limitation or blocker status",
      customerSafeMessage: "Readiness is not ready until release owner accepts evidence.",
    },
    {
      route: "docs",
      trigger: "missing or confusing instruction blocks a fixture step",
      owner: "docs owner",
      safeNextAction: "open docs route with fixture id and customer-safe wording",
      customerSafeMessage: "Docs owner receives evidence before guidance changes.",
    },
    {
      route: "product-ux",
      trigger: "blocked workspace or project step needs UX evidence",
      owner: "workspace onboarding UX owner",
      safeNextAction: "route product UX gap without building production UI",
      customerSafeMessage: "Product UX owner receives blocked-step context and evidence.",
    },
    {
      route: "support",
      trigger: "support handoff or stale evidence needs customer update",
      owner: "support workflow owner",
      safeNextAction: "handoff redacted context and next update condition",
      customerSafeMessage: "Support can update the customer from redacted evidence.",
    },
    {
      route: "engineering",
      trigger: "unsafe, unknown, or failing fixture needs implementation owner review",
      owner: "owning engineering project",
      safeNextAction: "route engineering blocker with proof fixture and stop condition",
      customerSafeMessage: "Engineering owner must resolve evidence before the pilot proceeds.",
    },
  ],
  supportHandoffEvidence: {
    severity: "SEV3 pilot workflow blocked",
    redactionState: "customer-safe redacted evidence only",
    evidenceLink: "docs/design/proofs/vibe-pilot-first-proof-walkthrough/README.md",
    nextUpdateCondition: "support updates customer when owner route accepts evidence or blocker status changes",
  },
  accessibilityNotes: [
    "Keyboard order follows invite, workspace setup, project choice, first proof, recovery, support handoff, and feedback capture.",
    "Screen reader labels include stage, blocker route, proof mode, owner, support severity, and safe next action.",
    "Color is never the only signal for blocked, stale, support-routed, or accepted fixture states.",
    "Motion is optional and walkthrough transitions must respect reduced-motion preferences.",
  ],
  scopeOut: [
    "No customer-success automation.",
    "No CRM or sales workflow integration.",
    "No live customer data or raw tenant identifiers.",
    "No production tenant mutation.",
    "No provider deployment or credentials.",
    "No support tooling or queue implementation.",
    "No launch claims without evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(customer success automation|automated onboarding|cs automation)\b/i,
  /\b(crm|salesforce|hubspot)\b/i,
  /\b(live customer data|raw customer|customer pii|tenant data)\b/i,
  /\b(production tenant|mutate tenant|tenant mutation)\b/i,
  /\b(provider deployment|real provider|live provider|cloud credential|credential)\b/i,
  /\b(support tooling|support queue|ticketing|helpdesk)\b/i,
  /\b(launch claim|launch readiness|go live).*\b(evidence|without evidence)?\b/i,
];

export type PilotFirstProofRequestClassification = "in-scope-proof" | "scope-out";

export class VibePilotFirstProofWalkthroughParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Vibe pilot first-proof walkthrough failed parsing: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "VibePilotFirstProofWalkthroughParseError";
  }
}

export function parseVibePilotFirstProofWalkthrough(
  walkthrough: VibePilotFirstProofWalkthrough,
): ParsedVibePilotFirstProofWalkthrough {
  const validation = validateVibePilotFirstProofWalkthrough(walkthrough);

  if (!validation.ok) {
    throw new VibePilotFirstProofWalkthroughParseError(validation.errors);
  }

  // SAFETY: `return walkthrough as ParsedVibePilotFirstProofWalkthrough;` is required at this I/O or test boundary.
  return walkthrough as ParsedVibePilotFirstProofWalkthrough;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibePilotFirstProofWalkthrough(
  walkthrough: VibePilotFirstProofWalkthrough,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (walkthrough.issue !== "HOBO-563") {
    errors.push({ code: "wrong-issue", message: "walkthrough must pin HOBO-563" });
  }
  if (walkthrough.phase !== "M2") {
    errors.push({ code: "wrong-phase", message: "walkthrough must stay in M2" });
  }
  if (walkthrough.packagePath !== "src/draft/exp-proofs/ux/vibe-pilot-first-proof-walkthrough") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (walkthrough.proofPath !== "docs/design/proofs/vibe-pilot-first-proof-walkthrough/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }

  validateConsumedStoryboard(walkthrough.consumedStoryboard, errors);
  validateSteps(walkthrough.steps, errors);
  validateScenarios(walkthrough.scenarioPaths, errors);
  validateBlockerRoutes(walkthrough.blockerRoutes, errors);
  validateSupportHandoff(walkthrough.supportHandoffEvidence, errors);
  validateAccessibility(walkthrough.accessibilityNotes, errors);

  return { ok: errors.length === 0, errors };
}

export function classifyPilotFirstProofWalkthroughRequest(
  summary: string,
): PilotFirstProofRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

function validateConsumedStoryboard(
  consumed: ConsumedStoryboard,
  errors: ValidationError[],
): void {
  if (consumed.sourceIssue !== "HOBO-549") {
    errors.push({ code: "wrong-consumed-issue", message: "walkthrough must consume HOBO-549" });
  }
  if (consumed.packagePath !== "src/draft/exp-proofs/ux/vibe-first-customer-pilot-storyboard") {
    errors.push({ code: "wrong-consumed-package", message: "HOBO-549 package path drifted" });
  }
  if (consumed.proofPath !== "docs/design/proofs/vibe-first-customer-pilot-storyboard/README.md") {
    errors.push({ code: "wrong-consumed-proof", message: "HOBO-549 proof path drifted" });
  }
  if (!arraysEqual(consumed.stages, REQUIRED_PILOT_STORYBOARD_STAGES)) {
    errors.push({ code: "consumed-stage-drift", message: "HOBO-549 storyboard stages drifted" });
  }
}

function validateSteps(
  steps: readonly WalkthroughStep[],
  errors: ValidationError[],
): void {
  if (!arraysEqual(steps.map((step) => step.stage), REQUIRED_PILOT_STORYBOARD_STAGES)) {
    errors.push({ code: "missing-walkthrough-stage", message: "walkthrough must cover all HOBO-549 stages" });
  }

  const proofModes = new Set<PilotFirstProofMode>();
  for (const step of steps) {
    if (step.stage !== step.sourceStoryboardStage) {
      errors.push({ code: "stage-source-mismatch", message: `${step.stage} source stage drifted` });
    }
    for (const [field, value] of [
      ["title", step.title],
      ["persona", step.persona],
      ["userAction", step.userAction],
      ["expectedEvidence", step.expectedEvidence],
      ["customerSafeMessage", step.customerSafeMessage],
    ] as const) {
      if (value.trim().length === 0) {
        errors.push({ code: "missing-step-field", message: `${step.stage}.${field} must not be empty` });
      }
    }
    if (!REQUIRED_PILOT_FIRST_PROOF_BLOCKER_ROUTES.includes(step.blockerRoute)) {
      errors.push({ code: "unknown-step-route", message: `${step.stage} has an unknown blocker route` });
    }
    if (!REQUIRED_PILOT_FIRST_PROOF_PROOF_MODES.includes(step.proofMode)) {
      errors.push({ code: "unknown-proof-mode", message: `${step.stage} has an unknown proof mode` });
    } else {
      proofModes.add(step.proofMode);
    }
  }
  if (!arraysEqual([...proofModes], REQUIRED_PILOT_FIRST_PROOF_PROOF_MODES)) {
    errors.push({ code: "missing-proof-mode", message: "walkthrough must cover all proof mode labels" });
  }
}

function validateScenarios(
  scenarios: readonly ScenarioPath[],
  errors: ValidationError[],
): void {
  if (!arraysEqual(scenarios.map((scenario) => scenario.id), REQUIRED_PILOT_FIRST_PROOF_SCENARIOS)) {
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

function validateBlockerRoutes(
  routes: readonly BlockerRoute[],
  errors: ValidationError[],
): void {
  if (!arraysEqual(routes.map((route) => route.route), REQUIRED_PILOT_FIRST_PROOF_BLOCKER_ROUTES)) {
    errors.push({ code: "missing-blocker-route", message: "all blocker owner routes must be present" });
  }
  for (const route of routes) {
    for (const [field, value] of [
      ["trigger", route.trigger],
      ["owner", route.owner],
      ["safeNextAction", route.safeNextAction],
      ["customerSafeMessage", route.customerSafeMessage],
    ] as const) {
      if (value.trim().length === 0) {
        errors.push({ code: "missing-route-field", message: `${route.route}.${field} must not be empty` });
      }
    }
  }
}

function validateSupportHandoff(
  support: SupportHandoffEvidence,
  errors: ValidationError[],
): void {
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

function validateAccessibility(
  notes: readonly string[],
  errors: ValidationError[],
): void {
  const noteText = notes.join(" ").toLowerCase();
  for (const requiredNote of ["keyboard", "screen reader", "color", "motion"]) {
    if (!noteText.includes(requiredNote)) {
      errors.push({ code: "missing-accessibility-note", message: `accessibility notes must include ${requiredNote}` });
    }
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
