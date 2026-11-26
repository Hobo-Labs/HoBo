import { isJsonObject } from "./json.js";
export const REQUIRED_SURFACES = [
  "workspace-onboarding",
  "plan-diff",
  "deployment-dashboard",
  "marketplace-install",
  "publisher-portal",
  "docs",
  "admin-support",
  "release-support-artifacts",
];

export const REQUIRED_CHECKS = [
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
];

export const REQUIRED_EVIDENCE_MODES = [
  "automated-checks",
  "manual-assistive-tech",
  "beta-feedback",
  "defect-severity",
  "launch-blocker-threshold",
  "accepted-risk-exception",
];

const REQUIRED_BOUNDARIES = ["service", "ux", "support", "release"];
const CRITICAL_CHECKS = new Set([
  "keyboard-only-path",
  "focus-order",
  "visible-focus",
  "semantic-labels",
  "contrast",
  "screen-reader-smoke",
]);
const FORBIDDEN_SCOPE_PATTERNS = [
  /build production/i,
  /final visual design/i,
  /production dashboard/i,
  /full accessibility audit output/i,
  /fix all defects/i,
];
const EXCEPTION_CLASSES = new Set(["high-risk-non-blocker", "launch-note", "post-ga-follow-up"]);
const EXCEPTION_ROLES = new Set(["release-owner", "product-ux-owner", "support-owner", "legal-privacy-owner"]);
const NON_WAIVABLE_GATES = new Set([
  ...REQUIRED_EVIDENCE_MODES,
  "ci",
  "review",
  "security",
  "contract-tests",
]);

const SURFACE_OWNER = new Map([
  ["workspace-onboarding", "Workspace & Onboarding UX"],
  ["plan-diff", "Plan/Diff Viewer"],
  ["deployment-dashboard", "Deployment Dashboard & Topology Explorer"],
  ["marketplace-install", "Marketplace UX"],
  ["publisher-portal", "Publisher Portal"],
  ["docs", "V1 Release Notes & Upgrade Guide"],
  ["admin-support", "V1 Launch Support Desk & Escalation"],
  ["release-support-artifacts", "V1 Release Program & Cutline"],
]);

export const ACCESSIBILITY_USABILITY_BASELINE = {
  issue: "HOBO-505",
  project: "Accessibility & Usability Quality",
  phase: "M0",
  goal:
    "Define the v1 accessibility and usability launch baseline so keyboard, assistive-technology, responsive, copy, state, and exception evidence is explicit before HoBo claims launch readiness.",
  surfaces: REQUIRED_SURFACES.map((id) => ({
    id,
    ownerProject: SURFACE_OWNER.get(id),
    evidenceUse: "Launch readiness requires this surface to report accessibility and usability evidence or an accepted limitation.",
  })),
  requiredChecks: [
    {
      id: "keyboard-only-path",
      proofMode: "manual-assistive-tech",
      proves: "Primary workflows can be completed without a mouse.",
    },
    {
      id: "focus-order",
      proofMode: "manual-assistive-tech",
      proves: "Keyboard focus follows task order and does not strand users.",
    },
    {
      id: "visible-focus",
      proofMode: "automated-checks",
      proves: "Interactive controls expose visible focus indicators.",
    },
    {
      id: "semantic-labels",
      proofMode: "automated-checks",
      proves: "Controls, landmarks, and form fields expose usable names and roles.",
    },
    {
      id: "contrast",
      proofMode: "automated-checks",
      proves: "Text, controls, focus, and state indicators meet launch contrast thresholds or carry a limitation.",
    },
    {
      id: "responsive-layout",
      proofMode: "automated-checks",
      proves: "Supported viewports avoid overlapping content and hidden required controls.",
    },
    {
      id: "reduced-motion",
      proofMode: "automated-checks",
      proves: "Motion-sensitive states have a reduced-motion posture.",
    },
    {
      id: "screen-reader-smoke",
      proofMode: "manual-assistive-tech",
      proves: "Representative first-run and support paths have screen-reader smoke evidence.",
    },
    {
      id: "empty-error-loading-states",
      proofMode: "reference-fixture",
      proves: "Empty, error, and loading states explain state and next action without visual-only cues.",
    },
    {
      id: "copy-clarity",
      proofMode: "beta-feedback",
      proves: "Critical launch copy is understandable to target personas and support can triage unclear copy.",
    },
  ],
  evidenceMatrix: [
    {
      id: "automated-checks",
      ownerProject: "E2E Test Matrix",
      requiredBeforeLaunchClaim: true,
    },
    {
      id: "manual-assistive-tech",
      ownerProject: "Accessibility & Usability Quality",
      requiredBeforeLaunchClaim: true,
    },
    {
      id: "beta-feedback",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      requiredBeforeLaunchClaim: false,
    },
    {
      id: "defect-severity",
      ownerProject: "V1 Release Program & Cutline",
      requiredBeforeLaunchClaim: true,
    },
    {
      id: "launch-blocker-threshold",
      ownerProject: "V1 Release Program & Cutline",
      requiredBeforeLaunchClaim: true,
    },
    {
      id: "accepted-risk-exception",
      ownerProject: "V1 Release Program & Cutline",
      requiredBeforeLaunchClaim: false,
    },
  ],
  boundaries: {
    service:
      "This baseline names evidence and owners only; account, auth, dashboard, marketplace, docs, and support services keep implementation ownership.",
    ux:
      "This baseline defines checks and launch thresholds, not final visual design, component implementation, or full audit remediation.",
    support:
      "Support receives defect severity, affected surface, known limitation text, and safe next action; SLA and support tooling remain outside this issue.",
    release:
      "Launch blockers follow the release cutline taxonomy and cannot be waived through accepted-risk exceptions.",
  },
  scopeIn: [
    "Name v1 launch surfaces that require accessibility and usability evidence.",
    "Define required checks for keyboard, focus, semantic labels, contrast, responsive layout, reduced motion, screen-reader smoke, states, and copy clarity.",
    "Define evidence modes for automated checks, manual assistive-technology checks, beta feedback, defect severity, launch-blocker thresholds, and accepted-risk exceptions.",
    "Route defects to owning product projects without turning this project into a feature implementation bucket.",
  ],
  scopeOut: [
    "Do not build product UI, dashboard screens, marketplace flows, support tooling, docs portal, or design-system components.",
    "Do not create a full accessibility audit report or claim certification.",
    "Do not fix every accessibility or usability defect in this issue.",
    "Do not waive launch blockers, CI, review, security, or contract-test gates.",
  ],
  dependencies: [
    {
      source: "docs/design/workspace-onboarding-ux.md",
      reason: "Names onboarding surfaces and explicitly scopes accessibility audit output out of workspace M0.",
    },
    {
      source: "docs/design/launch-blocker-taxonomy.md",
      reason: "Defines launch blockers, high-risk non-blockers, launch notes, and exception boundaries.",
    },
    {
      source: "docs/design/beta-pilot-feedback.md",
      reason: "Routes usability beta feedback to Product UX and launch cutline owners.",
    },
    {
      source: "docs/design/pre-launch-outcome-contract.md",
      reason: "Maps launch evidence into plan/diff, go/no-go, telemetry, support, and release-note surfaces.",
    },
    {
      source: "docs/design/ai-generation-launch-posture.md",
      reason: "Keeps generated UI as proposal until UX and accessibility evidence accepts it.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1-M4 product UI, automated testing, manual audit, support, and remediation issues wait until this baseline is accepted.",
  },
};

export function validateAccessibilityUsabilityBaseline(baseline) {
  const errors = [];

  if (!baseline || !isJsonObject(baseline)) {
    return { ok: false, errors: ["baseline record is required"] };
  }
  if (baseline.issue !== "HOBO-505") {
    errors.push("issue must be HOBO-505");
  }
  if (baseline.phase !== "M0") {
    errors.push("phase must be M0");
  }

  if (!sameOrderedIds(baseline.surfaces, REQUIRED_SURFACES)) {
    errors.push("surfaces are incomplete or out of order");
  }
  if (!sameOrderedIds(baseline.requiredChecks, REQUIRED_CHECKS)) {
    errors.push("required checks are incomplete or out of order");
  }
  if (!sameOrderedIds(baseline.evidenceMatrix, REQUIRED_EVIDENCE_MODES)) {
    errors.push("evidence matrix is incomplete or out of order");
  }

  for (const surface of baseline.surfaces ?? []) {
    if (!surface.ownerProject || !surface.evidenceUse) {
      errors.push(`surface ${surface.id ?? "<missing>"} must name ownerProject and evidenceUse`);
    }
  }
  for (const check of baseline.requiredChecks ?? []) {
    if (!check.proofMode || !check.proves) {
      errors.push(`check ${check.id ?? "<missing>"} must name proofMode and proof`);
    }
  }
  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!baseline.boundaries?.[boundary]) {
      errors.push(`missing ${boundary} boundary`);
    }
  }
  for (const entry of baseline.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`scope creep: ${entry}`);
    }
  }
  if ((baseline.scopeOut ?? []).length < 4) {
    errors.push("scope out must distinguish launch blockers, audit output, implementation fixes, and gate waivers");
  }
  if ((baseline.dependencies ?? []).length < 5) {
    errors.push("dependencies must include onboarding, launch blockers, beta feedback, outcome baseline, and generation posture");
  }
  if (!baseline.followUpGate?.allowedAfter || !baseline.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return { ok: errors.length === 0, errors };
}

export function classifyAccessibilityFinding(finding) {
  const decisionClass = classifyDecisionClass(finding);

  return {
    decisionClass,
    mayShip: decisionClass !== "launch-blocker",
    ownerProject: routeAccessibilityFinding(finding),
    requiredEvidence:
      decisionClass === "launch-blocker"
        ? ["finding record", "affected launch surface", "owner", "failed check or customer impact"]
        : ["finding record", "risk impact", "mitigation or limitation", "owner"],
  };
}

export function routeAccessibilityFinding(finding) {
  return SURFACE_OWNER.get(finding?.surface) ?? "V1 Release Program & Cutline";
}

export function validateAccessibilityException(request) {
  const errors = [];

  if (!EXCEPTION_CLASSES.has(request?.decisionClass)) {
    errors.push(`${request?.decisionClass ?? "<missing>"} cannot use the exception process`);
  }
  if (request?.decisionClass === "launch-blocker") {
    errors.push("launch blockers cannot be waived by exception");
  }
  if (!EXCEPTION_ROLES.has(request?.approverRole)) {
    errors.push(`${request?.approverRole ?? "<missing>"} is not an approved exception role`);
  }
  for (const field of ["findingRecord", "impact", "mitigation", "expiry"]) {
    if (!request?.evidence?.[field]) {
      errors.push(`exception evidence requires ${field}`);
    }
  }
  for (const gate of request?.gateOverrides ?? []) {
    if (NON_WAIVABLE_GATES.has(gate)) {
      errors.push(`${gate} gate cannot be overridden`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function classifyDecisionClass(finding) {
  if (finding?.requiredGateFailing) {
    return "launch-blocker";
  }
  if (finding?.customerImpact && CRITICAL_CHECKS.has(finding?.check)) {
    return "launch-blocker";
  }
  if (finding?.customerVisibleLimitation && finding?.ownerAcceptedRisk) {
    return "launch-note";
  }
  if (finding?.mitigationReady && finding?.ownerAcceptedRisk) {
    return "high-risk-non-blocker";
  }
  if (finding?.customerVisibleLimitation) {
    return "launch-note";
  }

  return "post-ga-follow-up";
}

function sameOrderedIds(entries, expectedIds) {
  return (
    Array.isArray(entries) &&
    entries.length === expectedIds.length &&
    entries.every((entry, index) => entry.id === expectedIds[index])
  );
}
