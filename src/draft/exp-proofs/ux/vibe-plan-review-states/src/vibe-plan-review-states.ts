export const REQUIRED_PLAN_REVIEW_PERSONAS = [
  "app developer reviewer",
  "platform engineer approver",
  "security reviewer",
  "support operator",
] as const;

export const REQUIRED_PLAN_REVIEW_SURFACES = [
  "plan-summary",
  "change-diff",
  "risk-policy",
  "cost-capacity",
  "approval-support",
] as const;

export const REQUIRED_PLAN_REVIEW_STATES = [
  "create",
  "update",
  "no-op",
  "destructive",
  "blocked",
  "stale",
  "unknown-evidence",
] as const;

export const REQUIRED_PLAN_REVIEW_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_PLAN_REVIEW_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_PLAN_REVIEW_QUICKSTART_FIXTURE_IDS = [
  "rlq-plan-safe-preview-v1",
  "rlq-manage-stale-evidence-v1",
  "rlq-migrate-brownfield-preview-v1",
  "rlq-recover-snapshot-restore-v1",
] as const;

type PlanReviewPersona = (typeof REQUIRED_PLAN_REVIEW_PERSONAS)[number];
type PlanReviewSurfaceId = (typeof REQUIRED_PLAN_REVIEW_SURFACES)[number];
type PlanReviewStateId = (typeof REQUIRED_PLAN_REVIEW_STATES)[number];
type PlanReviewScenarioId = (typeof REQUIRED_PLAN_REVIEW_SCENARIOS)[number];
type PlanReviewProofMode = (typeof REQUIRED_PLAN_REVIEW_PROOF_MODES)[number];
type PlanReviewQuickstartFixtureId = (typeof REQUIRED_PLAN_REVIEW_QUICKSTART_FIXTURE_IDS)[number];

type PlanReviewStateFixture = {
  readonly id: PlanReviewStateId;
  readonly label: string;
  readonly evidenceSource: string;
  readonly owner: string;
  readonly safeNextAction: string;
  readonly riskCategory: string;
  readonly policyDisposition: string;
  readonly costDisposition: string;
  readonly capacityDisposition: string;
  readonly customerSafeWording: string;
  readonly proofMode: PlanReviewProofMode;
};

type PlanReviewSurface = {
  readonly id: PlanReviewSurfaceId;
  readonly title: string;
  readonly personas: readonly PlanReviewPersona[];
  readonly stateIds: readonly PlanReviewStateId[];
  readonly questionsAnswered: readonly string[];
};

type PlanReviewScenarioPath = {
  readonly id: PlanReviewScenarioId;
  readonly narrative: string;
  readonly stateIds: readonly PlanReviewStateId[];
  readonly safeOutcome: string;
};

type PlanReviewQuickstartFixtureRef = {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: PlanReviewQuickstartFixtureId;
  readonly consumer: "Plan/Diff";
  readonly proofMode: "reference-fixture" | "simulated" | "live" | "scope-out";
  readonly planReviewUse: string;
};

type PlanReviewSupportHandoff = {
  readonly owner: string;
  readonly evidenceSource: string;
  readonly safeAction: string;
  readonly customerSafeMessage: string;
  readonly redactionBoundary: string;
};

type VibePlanReviewStates = {
  readonly issue: "HOBO-542";
  readonly phase: "M1";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-plan-review-states";
  readonly proofPath: "docs/design/proofs/vibe-plan-review-states/README.md";
  readonly designRefs: readonly string[];
  readonly quickstartFixtureRefs: readonly PlanReviewQuickstartFixtureRef[];
  readonly personas: readonly PlanReviewPersona[];
  readonly reviewSurfaces: readonly PlanReviewSurface[];
  readonly planStates: readonly PlanReviewStateFixture[];
  readonly scenarioPaths: readonly PlanReviewScenarioPath[];
  readonly supportHandoff: PlanReviewSupportHandoff;
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

declare const parsedPlanReviewStatesBrand: unique symbol;

export type ParsedVibePlanReviewStates = VibePlanReviewStates & {
  readonly [parsedPlanReviewStatesBrand]: true;
};

const PLAN_STATES: readonly PlanReviewStateFixture[] = [
  {
    id: "create",
    label: "Create preview",
    evidenceSource: "fixture://rlq-plan-safe-preview-v1/Delta.create",
    owner: "Control Plane",
    safeNextAction: "approve simulated plan preview after policy receipt review",
    riskCategory: "low additive change",
    policyDisposition: "Gatekeeper allow with audit receipt",
    costDisposition: "estimated monthly delta is present and bounded",
    capacityDisposition: "capacity envelope has explicit headroom",
    customerSafeWording: "Safe preview: creates new resources after approval; no live apply happens in this proof.",
    proofMode: "simulated",
  },
  {
    id: "update",
    label: "Update preview",
    evidenceSource: "fixture://rlq-plan-safe-preview-v1/Delta.update",
    owner: "Plan/Diff Viewer",
    safeNextAction: "review changed fields and open approval handoff",
    riskCategory: "medium configuration change",
    policyDisposition: "obligation requires reviewer acknowledgement",
    costDisposition: "cost estimate changed and cites reliability owner",
    capacityDisposition: "capacity impact is known from reference fixture",
    customerSafeWording: "Preview update: review changed settings before deploy simulation.",
    proofMode: "reference fixture",
  },
  {
    id: "no-op",
    label: "No-op preview",
    evidenceSource: "fixture://rlq-plan-safe-preview-v1/Delta.no-op",
    owner: "Developer Experience",
    safeNextAction: "approve no-op or revise manifest if change was expected",
    riskCategory: "no material change",
    policyDisposition: "no new policy obligation",
    costDisposition: "no cost delta",
    capacityDisposition: "no capacity delta",
    customerSafeWording: "No change: preview found no resource difference.",
    proofMode: "live",
  },
  {
    id: "destructive",
    label: "Destructive preview",
    evidenceSource: "fixture://rlq-recover-snapshot-restore-v1/rollback-boundary",
    owner: "Control Plane",
    safeNextAction: "block until rollback and owner approval evidence exists",
    riskCategory: "high destructive action",
    policyDisposition: "Gatekeeper blocks without explicit approval",
    costDisposition: "cost may decrease but cannot override destructive risk",
    capacityDisposition: "capacity removal requires recovery fixture",
    customerSafeWording: "Destructive preview: blocked until rollback and approval evidence are present.",
    proofMode: "reference fixture",
  },
  {
    id: "blocked",
    label: "Policy-blocked preview",
    evidenceSource: "fixture://rlq-plan-safe-preview-v1/Gatekeeper.denied",
    owner: "Security",
    safeNextAction: "open policy owner review and revise requested permission",
    riskCategory: "security policy denial",
    policyDisposition: "deny-ceiling blocks deploy",
    costDisposition: "cost estimate is not enough to proceed",
    capacityDisposition: "capacity is not evaluated after denial",
    customerSafeWording: "Blocked: policy evidence prevents this plan from proceeding.",
    proofMode: "simulated",
  },
  {
    id: "stale",
    label: "Stale evidence preview",
    evidenceSource: "fixture://rlq-manage-stale-evidence-v1/projection",
    owner: "Reliability",
    safeNextAction: "wait for projection refresh or handoff support packet",
    riskCategory: "stale operational evidence",
    policyDisposition: "approval held until fresh enough evidence exists",
    costDisposition: "cost signal is stale and must be labeled",
    capacityDisposition: "capacity signal is stale and must be labeled",
    customerSafeWording: "Stale preview: evidence is delayed; wait for refresh before approving.",
    proofMode: "reference fixture",
  },
  {
    id: "unknown-evidence",
    label: "Unknown evidence preview",
    evidenceSource: "fixture://rlq-migrate-brownfield-preview-v1/missing-owner",
    owner: "Support",
    safeNextAction: "handoff to support with missing owner and evidence source",
    riskCategory: "unknown evidence",
    policyDisposition: "fail closed until owner and source are known",
    costDisposition: "cost unavailable",
    capacityDisposition: "capacity unavailable",
    customerSafeWording: "Unknown preview: evidence is missing, so the plan cannot proceed yet.",
    proofMode: "scope-out",
  },
];

const REVIEW_SURFACES: readonly PlanReviewSurface[] = [
  {
    id: "plan-summary",
    title: "Plan summary with safe next action",
    personas: ["app developer reviewer", "platform engineer approver"],
    stateIds: ["create", "update", "no-op"],
    questionsAnswered: [
      "What changed, which fixture proved it, and what action can safely happen next?",
      "Is this a create, update, or no-op plan that stays inside simulated proof mode?",
    ],
  },
  {
    id: "change-diff",
    title: "Resource change diff with destructive guard",
    personas: ["app developer reviewer", "platform engineer approver", "support operator"],
    stateIds: ["create", "update", "destructive"],
    questionsAnswered: [
      "Which resource fields changed and where does destructive or rollback evidence appear?",
      "Which owner must approve before a destructive preview can move forward?",
    ],
  },
  {
    id: "risk-policy",
    title: "Risk and policy disposition",
    personas: ["security reviewer", "platform engineer approver"],
    stateIds: ["blocked", "destructive", "unknown-evidence"],
    questionsAnswered: [
      "Which Gatekeeper or policy disposition blocks the plan instead of hiding risk in green copy?",
      "Which permission, tenant, or evidence gap must be fixed before approval?",
    ],
  },
  {
    id: "cost-capacity",
    title: "Cost and capacity evidence labels",
    personas: ["platform engineer approver", "security reviewer"],
    stateIds: ["create", "update", "stale", "unknown-evidence"],
    questionsAnswered: [
      "Are cost and capacity known, estimated, stale, unavailable, or outside this proof?",
      "Which owner receives stale or unavailable cost/capacity handoff?",
    ],
  },
  {
    id: "approval-support",
    title: "Approval and support handoff",
    personas: ["support operator", "security reviewer", "app developer reviewer"],
    stateIds: ["blocked", "stale", "unknown-evidence", "destructive"],
    questionsAnswered: [
      "What customer-safe wording, evidence source, owner, and redaction boundary should support use?",
      "Which approval or wait condition prevents unsupported launch or deploy claims?",
    ],
  },
];

const QUICKSTART_FIXTURE_REFS: readonly PlanReviewQuickstartFixtureRef[] = [
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-plan-safe-preview-v1",
    consumer: "Plan/Diff",
    proofMode: "simulated",
    planReviewUse: "source for safe create, update, no-op, and blocked Gatekeeper plan states",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-manage-stale-evidence-v1",
    consumer: "Plan/Diff",
    proofMode: "reference-fixture",
    planReviewUse: "source for stale evidence copy, owner route, and wait condition",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-migrate-brownfield-preview-v1",
    consumer: "Plan/Diff",
    proofMode: "simulated",
    planReviewUse: "source for unknown brownfield owner and missing evidence handoff",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-snapshot-restore-v1",
    consumer: "Plan/Diff",
    proofMode: "reference-fixture",
    planReviewUse: "source for destructive rollback boundary and recovery precondition labels",
  },
];

export const VIBE_PLAN_REVIEW_STATES: VibePlanReviewStates = {
  issue: "HOBO-542",
  phase: "M1",
  packagePath: "src/draft/exp-proofs/ux/vibe-plan-review-states",
  proofPath: "docs/design/proofs/vibe-plan-review-states/README.md",
  designRefs: [
    "docs/design/plan-diff-viewer.md",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/control-plane.md#plan-04",
    "docs/design/platform-engineering.md#plan-25",
    "docs/design/contracts-policy-flags.md#plan-29",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  quickstartFixtureRefs: QUICKSTART_FIXTURE_REFS,
  personas: REQUIRED_PLAN_REVIEW_PERSONAS,
  reviewSurfaces: REVIEW_SURFACES,
  planStates: PLAN_STATES,
  scenarioPaths: [
    {
      id: "happy-path",
      narrative: "Safe create/update/no-op previews expose changed fields, owner, proof mode, and approval state.",
      stateIds: ["create", "update", "no-op"],
      safeOutcome: "approve simulated plan preview or revise manifest if expected changes are absent",
    },
    {
      id: "blocked-path",
      narrative: "Policy and destructive states block progression with owner, risk, and recovery evidence.",
      stateIds: ["blocked", "destructive"],
      safeOutcome: "block deploy simulation until policy or approval evidence is present",
    },
    {
      id: "stale-or-unknown-evidence",
      narrative: "Stale and unknown evidence are labeled explicitly instead of treated as success.",
      stateIds: ["stale", "unknown-evidence"],
      safeOutcome: "wait for refresh or hand off to support with missing evidence source",
    },
    {
      id: "support-handoff",
      narrative: "Support receives owner, evidence source, safe action, and customer-safe wording.",
      stateIds: ["blocked", "stale", "unknown-evidence"],
      safeOutcome: "handoff support packet without tenant data, provider credentials, or launch claims",
    },
  ],
  supportHandoff: {
    owner: "Support",
    evidenceSource: "fixture://rlq-manage-stale-evidence-v1/support-handoff",
    safeAction: "open support handoff with plan id, fixture id, owner, and next wait condition",
    customerSafeMessage: "customer-safe plan review note: evidence is delayed or blocked, not failed silently",
    redactionBoundary: "redact tenant data, provider credentials, and internal policy ids",
  },
  accessibilityNotes: [
    "Keyboard order follows plan summary, change diff, risk policy, cost capacity, then approval support regions.",
    "Screen reader labels include state, evidence source, owner, policy disposition, and proof mode.",
    "Contrast cannot be the only signal for safe, blocked, destructive, stale, or unknown states.",
    "Reduced motion users get static diff groups and no animated risk transition requirement.",
  ],
  scopeOut: [
    "No planner or matcher implementation.",
    "No apply, rollback, approval workflow, or live infrastructure mutation.",
    "No live cost API or provider credentials.",
    "No production UI implementation.",
    "No launch readiness or customer-facing claim without evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(planner|matcher|resource planner|matching engine)\b/i,
  /\b(apply|rollback|provision|deploy live|live infrastructure|infrastructure changes)\b/i,
  /\b(live cost api|provider credentials|aws key|azure credential|gcp credential|secret)\b/i,
  /\b(production ui|approval workflow|final ui|dashboard implementation)\b/i,
  /\b(launch readiness|launch claim|customer-facing claim).*\b(evidence|without evidence)?\b/i,
];

export type PlanReviewRequestClassification = "in-scope-proof" | "scope-out";

export class VibePlanReviewStatesParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Vibe plan review states failed parsing: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "VibePlanReviewStatesParseError";
  }
}

export function parseVibePlanReviewStates(
  states: VibePlanReviewStates,
): ParsedVibePlanReviewStates {
  const validation = validateVibePlanReviewStates(states);

  if (!validation.ok) {
    throw new VibePlanReviewStatesParseError(validation.errors);
  }

  // SAFETY: `return states as ParsedVibePlanReviewStates;` is required at this I/O or test boundary.
  return states as ParsedVibePlanReviewStates;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibePlanReviewStates(
  states: VibePlanReviewStates,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (states.issue !== "HOBO-542") {
    errors.push({ code: "wrong-issue", message: "plan review proof must pin HOBO-542" });
  }
  if (states.phase !== "M1") {
    errors.push({ code: "wrong-phase", message: "plan review proof must stay in M1" });
  }
  if (states.packagePath !== "src/draft/exp-proofs/ux/vibe-plan-review-states") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (states.proofPath !== "docs/design/proofs/vibe-plan-review-states/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }
  if (!arraysEqual(states.personas, REQUIRED_PLAN_REVIEW_PERSONAS)) {
    errors.push({ code: "missing-persona", message: "required persona set must be exact" });
  }
  if (!arraysEqual(states.reviewSurfaces.map((surface) => surface.id), REQUIRED_PLAN_REVIEW_SURFACES)) {
    errors.push({ code: "missing-review-surface", message: "review surfaces must cover accepted surfaces" });
  }
  if (!arraysEqual(states.planStates.map((state) => state.id), REQUIRED_PLAN_REVIEW_STATES)) {
    errors.push({ code: "missing-plan-state", message: "plan states must cover accepted state sequence" });
  }

  validateQuickstartFixtureRefs(states.quickstartFixtureRefs, errors);
  validateReviewSurfaces(states.reviewSurfaces, states.planStates, errors);
  validatePlanStates(states.planStates, errors);
  validateScenarioPaths(states.scenarioPaths, errors);
  validateAccessibility(states.accessibilityNotes, errors);
  validateSupportHandoff(states.supportHandoff, errors);

  return { ok: errors.length === 0, errors };
}

export function classifyPlanReviewRequest(summary: string): PlanReviewRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

function validateQuickstartFixtureRefs(
  refs: readonly PlanReviewQuickstartFixtureRef[],
  errors: ValidationError[],
): void {
  if (!Array.isArray(refs)) {
    errors.push({ code: "missing-quickstart-fixtures", message: "quickstart fixture references are required" });
    return;
  }

  if (!arraysEqual(refs.map((ref) => ref.fixtureId), REQUIRED_PLAN_REVIEW_QUICKSTART_FIXTURE_IDS)) {
    errors.push({
      code: "missing-quickstart-fixture",
      message: "plan review must cite accepted HOBO-577 Plan/Diff fixture ids",
    });
  }

  for (const ref of refs) {
    if (ref.sourceIssue !== "HOBO-577") {
      errors.push({ code: "wrong-quickstart-source", message: `${ref.fixtureId} must cite HOBO-577` });
    }
    if (ref.consumer !== "Plan/Diff") {
      errors.push({ code: "wrong-quickstart-consumer", message: `${ref.fixtureId} must target Plan/Diff` });
    }
    if (!ref.planReviewUse) {
      errors.push({ code: "missing-plan-review-use", message: `${ref.fixtureId} must explain usage` });
    }
  }
}

function validateReviewSurfaces(
  surfaces: readonly PlanReviewSurface[],
  states: readonly PlanReviewStateFixture[],
  errors: ValidationError[],
): void {
  const stateIds = new Set(states.map((state) => state.id));

  for (const persona of REQUIRED_PLAN_REVIEW_PERSONAS) {
    if (!surfaces.some((surface) => surface.personas.includes(persona))) {
      errors.push({ code: "missing-persona-surface", message: `${persona} needs a review surface` });
    }
  }

  for (const surface of surfaces) {
    if (surface.personas.length === 0 || surface.questionsAnswered.length === 0) {
      errors.push({ code: "incomplete-surface", message: `${surface.id} needs personas and questions` });
    }
    for (const stateId of surface.stateIds) {
      if (!stateIds.has(stateId)) {
        errors.push({ code: "unknown-surface-state", message: `${surface.id} references missing ${stateId}` });
      }
    }
  }
}

function validatePlanStates(states: readonly PlanReviewStateFixture[], errors: ValidationError[]): void {
  const proofModes = new Set<PlanReviewProofMode>();

  for (const state of states) {
    if (
      !state.evidenceSource ||
      !state.owner ||
      !state.safeNextAction ||
      !state.riskCategory ||
      !state.policyDisposition ||
      !state.customerSafeWording
    ) {
      errors.push({ code: "missing-state-metadata", message: `${state.id} is missing required metadata` });
    }
    if (!REQUIRED_PLAN_REVIEW_PROOF_MODES.includes(state.proofMode)) {
      errors.push({ code: "unsupported-proof-mode", message: `${state.id} uses unsupported proof mode` });
    } else {
      proofModes.add(state.proofMode);
    }
  }

  for (const proofMode of REQUIRED_PLAN_REVIEW_PROOF_MODES) {
    if (!proofModes.has(proofMode)) {
      errors.push({ code: "missing-proof-mode", message: `missing ${proofMode} proof mode` });
    }
  }
}

function validateScenarioPaths(paths: readonly PlanReviewScenarioPath[], errors: ValidationError[]): void {
  if (!arraysEqual(paths.map((path) => path.id), REQUIRED_PLAN_REVIEW_SCENARIOS)) {
    errors.push({ code: "missing-scenario-path", message: "scenario paths must cover acceptance states" });
  }

  for (const path of paths) {
    if (!path.narrative || !path.safeOutcome || path.stateIds.length === 0) {
      errors.push({ code: "incomplete-scenario", message: `${path.id} must name narrative and safe outcome` });
    }
  }
}

function validateAccessibility(notes: readonly string[], errors: ValidationError[]): void {
  const text = notes.join(" ").toLowerCase();
  for (const required of ["keyboard", "screen reader", "contrast", "reduced motion"]) {
    if (!text.includes(required)) {
      errors.push({ code: "missing-accessibility-note", message: `accessibility notes need ${required}` });
    }
  }
}

function validateSupportHandoff(handoff: PlanReviewSupportHandoff, errors: ValidationError[]): void {
  if (
    !handoff.owner ||
    !handoff.evidenceSource ||
    !handoff.safeAction ||
    !handoff.customerSafeMessage ||
    !handoff.redactionBoundary
  ) {
    errors.push({ code: "missing-support-handoff", message: "support handoff must be complete" });
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
