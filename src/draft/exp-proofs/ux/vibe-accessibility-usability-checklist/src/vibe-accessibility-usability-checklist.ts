export const REQUIRED_LAUNCH_SURFACES = [
  "workspace-onboarding",
  "plan-diff",
  "deployment-dashboard",
  "marketplace-install",
  "publisher-portal",
  "docs",
  "admin-support",
  "release-support-artifacts",
] as const;

export const REQUIRED_ACCESSIBILITY_CHECKS = [
  "keyboard-only-path",
  "focus-order",
  "visible-focus",
  "semantic-labels",
  "contrast",
  "responsive-layout",
  "reduced-motion",
  "screen-reader-smoke",
  "empty-error-loading-states",
  "copy-clarity",
] as const;

export const REQUIRED_PROOF_MODE_LABELS = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const ACCEPTED_RISK_ROUTES = [
  "launch-cutline-review",
  "release-owner-review",
  "product-owner-remediation",
  "support-owner-route",
] as const;

export const REQUIRED_ACCESSIBILITY_QUICKSTART_FIXTURE_IDS = [
  "rlq-define-object-graph-v1",
  "rlq-collect-manifest-ir-v1",
  "rlq-plan-safe-preview-v1",
  "rlq-deploy-run-accepted-v1",
  "rlq-inspect-event-projection-v1",
  "rlq-manage-stale-evidence-v1",
  "rlq-recover-snapshot-restore-v1",
  "rlq-recover-scope-out-v1",
] as const;

export const REQUIRED_ACCESSIBILITY_QUICKSTART_PROOF_MODES = [
  "reference-fixture",
  "simulated",
  "live",
  "scope-out",
] as const;

type LaunchSurface = (typeof REQUIRED_LAUNCH_SURFACES)[number];
type AccessibilityCheckId = (typeof REQUIRED_ACCESSIBILITY_CHECKS)[number];
type ProofModeLabel = (typeof REQUIRED_PROOF_MODE_LABELS)[number];
type AcceptedRiskRoute = (typeof ACCEPTED_RISK_ROUTES)[number];
type AccessibilityQuickstartFixtureId =
  (typeof REQUIRED_ACCESSIBILITY_QUICKSTART_FIXTURE_IDS)[number];
type AccessibilityQuickstartProofMode =
  (typeof REQUIRED_ACCESSIBILITY_QUICKSTART_PROOF_MODES)[number];
type LaunchSeverity = "launch-blocker" | "major" | "minor";

// domain-view: parse-produced draft-proof record; its wire form is the AccessibilityCheck proto message in data-models/.
type AccessibilityCheck = {
  readonly id: AccessibilityCheckId;
  readonly label: string;
  readonly evidenceMode: string;
  readonly proves: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the SurfaceChecklistEntry proto message in data-models/.
type SurfaceChecklistEntry = {
  readonly surface: LaunchSurface;
  readonly owner: string;
  readonly evidenceMode: string;
  readonly requiredChecks: readonly AccessibilityCheckId[];
  readonly launchSeverity: LaunchSeverity;
  readonly acceptedRiskRoute: AcceptedRiskRoute;
  readonly proofModes: readonly ProofModeLabel[];
};

// domain-view: parse-produced draft-proof record; its wire form is the AccessibilityQuickstartFixtureReference proto message in data-models/.
type AccessibilityQuickstartFixtureReference = {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: AccessibilityQuickstartFixtureId;
  readonly proofMode: AccessibilityQuickstartProofMode;
  readonly consumingSurface: LaunchSurface;
  readonly accessibilityUse: string;
};

type ChecklistScenarioId =
  | "happy-path"
  | "blocked-path"
  | "stale-or-unknown-evidence"
  | "support-handoff"
  | "accessibility-notes"
  | "proof-mode-labels";

// domain-view: parse-produced draft-proof record; its wire form is the ChecklistScenario proto message in data-models/.
type ChecklistScenario = {
  readonly id: ChecklistScenarioId;
  readonly surfaceRefs: readonly LaunchSurface[];
  readonly requiredEvidence: readonly string[];
  readonly safeOutcome: string;
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the VibeAccessibilityChecklist proto message in data-models/.
type VibeAccessibilityChecklist = {
  readonly issue: "HOBO-554";
  readonly phase: "M1";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-accessibility-usability-checklist";
  readonly proofPath: "docs/design/proofs/vibe-accessibility-usability-checklist/README.md";
  readonly designRefs: readonly string[];
  readonly quickstartFixtureRefs: readonly AccessibilityQuickstartFixtureReference[];
  readonly checks: readonly AccessibilityCheck[];
  readonly surfaceChecklist: readonly SurfaceChecklistEntry[];
  readonly scenarios: readonly ChecklistScenario[];
  readonly scopeOut: readonly string[];
};

declare const parsedChecklistBrand: unique symbol;

export type ParsedVibeAccessibilityChecklist = VibeAccessibilityChecklist & {
  readonly [parsedChecklistBrand]: true;
};

export type ChecklistRequestClassification = "in-scope-proof" | "scope-out";

const REQUIRED_SCENARIOS: readonly ChecklistScenarioId[] = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
  "accessibility-notes",
  "proof-mode-labels",
] as const;

interface SurfaceOwnerMap {
  readonly "workspace-onboarding": string;
  readonly "plan-diff": string;
  readonly "deployment-dashboard": string;
  readonly "marketplace-install": string;
  readonly "publisher-portal": string;
  readonly docs: string;
  readonly "admin-support": string;
  readonly "release-support-artifacts": string;
}

const SURFACE_OWNER: SurfaceOwnerMap = {
  "workspace-onboarding": "Workspace & Onboarding UX",
  "plan-diff": "Plan/Diff Viewer",
  "deployment-dashboard": "Deployment Dashboard & Topology Explorer",
  "marketplace-install": "Marketplace UX",
  "publisher-portal": "Publisher Portal",
  docs: "Docs Portal",
  "admin-support": "V1 Launch Support Desk & Escalation",
  "release-support-artifacts": "V1 Release Program & Cutline",
};

const CHECKS: readonly AccessibilityCheck[] = [
  {
    id: "keyboard-only-path",
    label: "Keyboard-only path",
    evidenceMode: "manual assistive-tech check",
    proves: "Primary workflows can be completed without pointer input.",
  },
  {
    id: "focus-order",
    label: "Focus order",
    evidenceMode: "manual assistive-tech check",
    proves: "Keyboard focus follows task order and does not strand users.",
  },
  {
    id: "visible-focus",
    label: "Visible focus",
    evidenceMode: "automated check",
    proves: "Interactive controls expose visible focus indicators.",
  },
  {
    id: "semantic-labels",
    label: "Semantic labels",
    evidenceMode: "automated check",
    proves: "Controls, landmarks, and form fields expose usable names and roles.",
  },
  {
    id: "contrast",
    label: "Contrast",
    evidenceMode: "automated check",
    proves: "Text, controls, focus, and state indicators meet launch thresholds or carry a limitation.",
  },
  {
    id: "responsive-layout",
    label: "Responsive layout",
    evidenceMode: "automated check",
    proves: "Supported viewports avoid overlapping content and hidden required controls.",
  },
  {
    id: "reduced-motion",
    label: "Reduced motion",
    evidenceMode: "automated check",
    proves: "Motion-sensitive states have a reduced-motion posture.",
  },
  {
    id: "screen-reader-smoke",
    label: "Screen-reader smoke",
    evidenceMode: "manual assistive-tech check",
    proves: "Representative first-run and support paths have screen-reader smoke evidence.",
  },
  {
    id: "empty-error-loading-states",
    label: "Empty/error/loading states",
    evidenceMode: "reference fixture",
    proves: "Non-happy states explain state and next action without visual-only cues.",
  },
  {
    id: "copy-clarity",
    label: "Copy clarity",
    evidenceMode: "beta feedback",
    proves: "Critical launch copy is understandable and support can triage unclear copy.",
  },
] as const;

const requiredChecks = REQUIRED_ACCESSIBILITY_CHECKS;
const requiredProofModes = REQUIRED_PROOF_MODE_LABELS;

const QUICKSTART_FIXTURE_REFS: readonly AccessibilityQuickstartFixtureReference[] = [
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-define-object-graph-v1",
    proofMode: "reference-fixture",
    consumingSurface: "workspace-onboarding",
    accessibilityUse: "first-run workspace copy can test labels and keyboard order against the accepted object-graph quickstart",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-collect-manifest-ir-v1",
    proofMode: "simulated",
    consumingSurface: "publisher-portal",
    accessibilityUse: "publisher evidence-upload states reuse manifest collection fixture wording without claiming live uploads",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-plan-safe-preview-v1",
    proofMode: "simulated",
    consumingSurface: "plan-diff",
    accessibilityUse: "plan and approval checklist states reuse the accepted preview fixture for focus and state clarity evidence",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-deploy-run-accepted-v1",
    proofMode: "live",
    consumingSurface: "marketplace-install",
    accessibilityUse: "marketplace installability labels cite deploy evidence while keeping live install runtime out of scope",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-inspect-event-projection-v1",
    proofMode: "reference-fixture",
    consumingSurface: "deployment-dashboard",
    accessibilityUse: "dashboard topology and status cards use accepted projection evidence for screen-reader and stale-state copy",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-manage-stale-evidence-v1",
    proofMode: "reference-fixture",
    consumingSurface: "docs",
    accessibilityUse: "docs stale-evidence language supplies state clarity and copy clarity checks for unknown proof states",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-snapshot-restore-v1",
    proofMode: "live",
    consumingSurface: "admin-support",
    accessibilityUse: "support handoff copy can cite recovery preview evidence while avoiding production restore claims",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-scope-out-v1",
    proofMode: "scope-out",
    consumingSurface: "release-support-artifacts",
    accessibilityUse: "release go/no-go artifacts keep scope-out claims visible before launch evidence can be accepted",
  },
];

const SURFACE_CHECKLIST: readonly SurfaceChecklistEntry[] = [
  {
    surface: "workspace-onboarding",
    owner: SURFACE_OWNER["workspace-onboarding"],
    evidenceMode: "first-run reference fixture plus manual keyboard and screen-reader smoke",
    requiredChecks,
    launchSeverity: "launch-blocker",
    acceptedRiskRoute: "launch-cutline-review",
    proofModes: requiredProofModes,
  },
  {
    surface: "plan-diff",
    owner: SURFACE_OWNER["plan-diff"],
    evidenceMode: "risk and approval fixture plus automated contrast/responsive checks",
    requiredChecks,
    launchSeverity: "launch-blocker",
    acceptedRiskRoute: "release-owner-review",
    proofModes: requiredProofModes,
  },
  {
    surface: "deployment-dashboard",
    owner: SURFACE_OWNER["deployment-dashboard"],
    evidenceMode: "projection-backed reference fixture and reduced-motion checklist",
    requiredChecks,
    launchSeverity: "major",
    acceptedRiskRoute: "product-owner-remediation",
    proofModes: requiredProofModes,
  },
  {
    surface: "marketplace-install",
    owner: SURFACE_OWNER["marketplace-install"],
    evidenceMode: "installability copy fixture and policy-blocked state check",
    requiredChecks,
    launchSeverity: "major",
    acceptedRiskRoute: "product-owner-remediation",
    proofModes: requiredProofModes,
  },
  {
    surface: "publisher-portal",
    owner: SURFACE_OWNER["publisher-portal"],
    evidenceMode: "publisher review fixture and evidence-upload state check",
    requiredChecks,
    launchSeverity: "major",
    acceptedRiskRoute: "product-owner-remediation",
    proofModes: requiredProofModes,
  },
  {
    surface: "docs",
    owner: SURFACE_OWNER.docs,
    evidenceMode: "docs IA fixture, search metadata, and stale-content copy clarity check",
    requiredChecks,
    launchSeverity: "minor",
    acceptedRiskRoute: "release-owner-review",
    proofModes: requiredProofModes,
  },
  {
    surface: "admin-support",
    owner: SURFACE_OWNER["admin-support"],
    evidenceMode: "support triage fixture and customer-safe evidence handoff check",
    requiredChecks,
    launchSeverity: "launch-blocker",
    acceptedRiskRoute: "support-owner-route",
    proofModes: requiredProofModes,
  },
  {
    surface: "release-support-artifacts",
    owner: SURFACE_OWNER["release-support-artifacts"],
    evidenceMode: "go/no-go and accepted-risk record fixture",
    requiredChecks,
    launchSeverity: "launch-blocker",
    acceptedRiskRoute: "launch-cutline-review",
    proofModes: requiredProofModes,
  },
] as const;

export const VIBE_ACCESSIBILITY_USABILITY_CHECKLIST: VibeAccessibilityChecklist = {
  issue: "HOBO-554",
  phase: "M1",
  packagePath: "src/draft/exp-proofs/ux/vibe-accessibility-usability-checklist",
  proofPath: "docs/design/proofs/vibe-accessibility-usability-checklist/README.md",
  designRefs: [
    "docs/design/accessibility-usability-launch-baseline.md",
    "docs/design/workspace-onboarding-ux.md",
    "docs/design/plan-diff-viewer.md",
    "docs/design/deployment-dashboard-topology-explorer.md",
    "docs/design/marketplace-ux.md",
    "docs/design/publisher-portal.md",
    "docs/design/support-workflow.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  quickstartFixtureRefs: QUICKSTART_FIXTURE_REFS,
  checks: CHECKS,
  surfaceChecklist: SURFACE_CHECKLIST,
  scenarios: [
    {
      id: "happy-path",
      surfaceRefs: ["workspace-onboarding", "plan-diff", "deployment-dashboard"],
      requiredEvidence: ["all required checks pass", "owner route recorded", "proof mode visible"],
      safeOutcome: "surface can be treated as launch evidence for the named fixture only",
    },
    {
      id: "blocked-path",
      surfaceRefs: ["plan-diff", "marketplace-install", "admin-support"],
      requiredEvidence: ["blocking check id", "launch severity", "accepted-risk route"],
      safeOutcome: "route blocker to owner without waiving required launch gates",
    },
    {
      id: "stale-or-unknown-evidence",
      surfaceRefs: ["deployment-dashboard", "docs", "release-support-artifacts"],
      requiredEvidence: ["freshness label", "unknown evidence copy", "safe downgrade path"],
      safeOutcome: "mark evidence stale or unknown instead of using it as green launch proof",
    },
    {
      id: "support-handoff",
      surfaceRefs: ["admin-support", "publisher-portal", "marketplace-install"],
      requiredEvidence: ["support-safe summary", "owner route", "next update condition"],
      safeOutcome: "handoff to support owner with redacted evidence and no customer-data leak",
    },
    {
      id: "accessibility-notes",
      surfaceRefs: ["workspace-onboarding", "publisher-portal", "docs"],
      requiredEvidence: ["keyboard path", "screen-reader smoke", "reduced-motion note"],
      safeOutcome: "make accessibility disposition explicit before customer-ready claims",
    },
    {
      id: "proof-mode-labels",
      surfaceRefs: ["release-support-artifacts", "plan-diff", "deployment-dashboard"],
      requiredEvidence: ["live label", "simulated label", "reference fixture label", "scope-out label"],
      safeOutcome: "keep live, simulated, reference fixture, and scope-out evidence separate",
    },
  ],
  scopeOut: [
    "No product UI implementation.",
    "No full accessibility audit execution or certification.",
    "No automated accessibility test suite buildout.",
    "No launch exception or waiver approval.",
    "No customer data or customer screenshots.",
    "No launch claims without named evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(product ui|ui remediation|remediate all screens|fix all defects)\b/i,
  /\b(full accessibility audit|audit execution|certify|certification)\b/i,
  /\b(automated test suite|test suite buildout|playwright suite|axe suite)\b/i,
  /\b(launch waiver|waiver approval|approve.*exception|exception approval)\b/i,
  /\b(customer data|customer screenshot|tenant data|real user data)\b/i,
  /\b(launch claim|customer-ready claim|public claim).*\b(without evidence|unsupported)?\b/i,
];

export class VibeAccessibilityChecklistParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Vibe accessibility checklist failed parsing: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "VibeAccessibilityChecklistParseError";
  }
}

export function parseVibeAccessibilityChecklist(
  checklist: VibeAccessibilityChecklist,
): ParsedVibeAccessibilityChecklist {
  const validation = validateVibeAccessibilityChecklist(checklist);

  if (!validation.ok) {
    throw new VibeAccessibilityChecklistParseError(validation.errors);
  }

  // SAFETY: `return checklist as ParsedVibeAccessibilityChecklist;` is required at this I/O or test boundary.
  return checklist as ParsedVibeAccessibilityChecklist;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibeAccessibilityChecklist(
  checklist: VibeAccessibilityChecklist,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (checklist.issue !== "HOBO-554") {
    errors.push({ code: "wrong-issue", message: "checklist must pin HOBO-554" });
  }
  if (checklist.phase !== "M1") {
    errors.push({ code: "wrong-phase", message: "checklist must stay in M1" });
  }
  if (checklist.packagePath !== "src/draft/exp-proofs/ux/vibe-accessibility-usability-checklist") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (checklist.proofPath !== "docs/design/proofs/vibe-accessibility-usability-checklist/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }
  if (!arraysEqual(checklist.checks.map((check) => check.id), REQUIRED_ACCESSIBILITY_CHECKS)) {
    errors.push({ code: "missing-required-check", message: "required accessibility checks drifted" });
  }
  if (!arraysEqual(checklist.surfaceChecklist.map((surface) => surface.surface), REQUIRED_LAUNCH_SURFACES)) {
    errors.push({ code: "missing-launch-surface", message: "required launch surfaces drifted" });
  }

  validateQuickstartFixtureRefs(checklist.quickstartFixtureRefs, errors);

  for (const check of checklist.checks) {
    if (!check.label || !check.evidenceMode || !check.proves) {
      errors.push({
        code: "incomplete-check",
        message: `${check.id} must name label, evidence mode, and proof statement`,
      });
    }
  }

  for (const surface of checklist.surfaceChecklist) {
    if (!surface.owner || !surface.evidenceMode) {
      errors.push({
        code: "missing-surface-owner",
        message: `${surface.surface} must name owner and evidence mode`,
      });
    }
    if (!arraysEqual(surface.requiredChecks, REQUIRED_ACCESSIBILITY_CHECKS)) {
      errors.push({
        code: "missing-surface-check",
        message: `${surface.surface} must require every accessibility/usability check`,
      });
    }
    if (!["launch-blocker", "major", "minor"].includes(surface.launchSeverity)) {
      errors.push({
        code: "invalid-launch-severity",
        message: `${surface.surface} must use accepted severity`,
      });
    }
    if (!ACCEPTED_RISK_ROUTES.includes(surface.acceptedRiskRoute)) {
      errors.push({
        code: "invalid-risk-route",
        message: `${surface.surface} must use accepted risk route`,
      });
    }
    if (!arraysEqual(surface.proofModes, REQUIRED_PROOF_MODE_LABELS)) {
      errors.push({
        code: "missing-proof-mode-label",
        message: `${surface.surface} must preserve live, simulated, reference fixture, and scope-out labels`,
      });
    }
  }

  if (!arraysEqual(checklist.scenarios.map((scenario) => scenario.id), REQUIRED_SCENARIOS)) {
    errors.push({
      code: "missing-scenario",
      message: "scenario coverage must include happy, blocked, stale/unknown, support, accessibility, and proof labels",
    });
  }

  for (const scenario of checklist.scenarios) {
    if (scenario.surfaceRefs.length === 0 || scenario.requiredEvidence.length === 0 || !scenario.safeOutcome) {
      errors.push({
        code: "incomplete-scenario",
        message: `${scenario.id} must name surfaces, evidence, and safe outcome`,
      });
    }
    for (const surface of scenario.surfaceRefs) {
      if (!REQUIRED_LAUNCH_SURFACES.includes(surface)) {
        errors.push({
          code: "unknown-scenario-surface",
          message: `${scenario.id} references unknown surface ${String(surface)}`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function summarizeSurfaceEvidence(
  checklist: ParsedVibeAccessibilityChecklist,
): ReadonlyArray<{
  readonly surface: LaunchSurface;
  readonly owner: string;
  readonly requiredChecks: number;
  readonly launchSeverity: LaunchSeverity;
  readonly evidenceMode: string;
  readonly acceptedRiskRoute: AcceptedRiskRoute;
  readonly claimsFullAudit: boolean;
}> {
  return checklist.surfaceChecklist.map((surface) => ({
    surface: surface.surface,
    owner: surface.owner,
    requiredChecks: surface.requiredChecks.length,
    launchSeverity: surface.launchSeverity,
    evidenceMode: surface.evidenceMode,
    acceptedRiskRoute: surface.acceptedRiskRoute,
    claimsFullAudit: /full accessibility audit|certification/i.test(surface.evidenceMode),
  }));
}

export function classifyChecklistRequest(summary: string): ChecklistRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

function validateQuickstartFixtureRefs(
  refs: readonly AccessibilityQuickstartFixtureReference[],
  errors: ValidationError[],
): void {
  if (!Array.isArray(refs)) {
    errors.push({
      code: "missing-quickstart-fixture-refs",
      message: "accessibility checklist must cite accepted HOBO-577 quickstart fixture refs",
    });
    return;
  }

  const fixtureIds = refs.map((ref) => ref.fixtureId);
  const proofModes = new Set<AccessibilityQuickstartProofMode>();
  const consumingSurfaces = new Set<LaunchSurface>();

  if (!arraysEqual(fixtureIds, REQUIRED_ACCESSIBILITY_QUICKSTART_FIXTURE_IDS)) {
    errors.push({
      code: "missing-quickstart-fixture",
      message: "accessibility checklist must cite the required HOBO-577 quickstart fixture ids",
    });
  }

  for (const ref of refs) {
    if (ref.sourceIssue !== "HOBO-577") {
      errors.push({
        code: "wrong-quickstart-source",
        message: `${ref.fixtureId} must cite HOBO-577`,
      });
    }
    if (!REQUIRED_ACCESSIBILITY_QUICKSTART_FIXTURE_IDS.includes(ref.fixtureId)) {
      errors.push({
        code: "unknown-quickstart-fixture",
        message: `${ref.fixtureId} is not an accepted HOBO-577 accessibility fixture`,
      });
    }
    if (!REQUIRED_ACCESSIBILITY_QUICKSTART_PROOF_MODES.includes(ref.proofMode)) {
      errors.push({
        code: "unknown-quickstart-proof-mode",
        message: `${ref.fixtureId} uses unsupported HOBO-577 proof mode ${String(ref.proofMode)}`,
      });
    } else {
      proofModes.add(ref.proofMode);
    }
    if (!REQUIRED_LAUNCH_SURFACES.includes(ref.consumingSurface)) {
      errors.push({
        code: "unknown-quickstart-consuming-surface",
        message: `${ref.fixtureId} targets unsupported surface ${String(ref.consumingSurface)}`,
      });
    } else {
      consumingSurfaces.add(ref.consumingSurface);
    }
    if (!ref.accessibilityUse || ref.accessibilityUse.length < 30) {
      errors.push({
        code: "missing-quickstart-accessibility-use",
        message: `${ref.fixtureId} must explain accessibility checklist consumption`,
      });
    }
  }

  for (const proofMode of REQUIRED_ACCESSIBILITY_QUICKSTART_PROOF_MODES) {
    if (proofModes.has(proofMode)) continue;
    errors.push({
      code: "missing-quickstart-proof-mode",
      message: "accessibility checklist must preserve HOBO-577 reference-fixture, simulated, live, and scope-out labels",
    });
  }

  for (const surface of REQUIRED_LAUNCH_SURFACES) {
    if (consumingSurfaces.has(surface)) continue;
    errors.push({
      code: "missing-quickstart-consuming-surface",
      message: `${surface} must cite a HOBO-577 quickstart fixture`,
    });
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
