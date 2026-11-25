export const REQUIRED_REPRESENTATIVE_ARTIFACTS = [
  "onboarding",
  "plan-diff",
  "deployment-dashboard",
  "marketplace",
  "docs",
  "support",
  "publisher",
  "launch-demo",
] as const;

export const REQUIRED_REPRESENTATIVE_CHECKS = [
  "keyboard-path",
  "screen-reader-smoke",
  "responsive-layout",
  "contrast-threshold",
  "reduced-motion",
  "state-clarity",
  "copy-clarity",
] as const;

export const REQUIRED_REPRESENTATIVE_SOURCE_ISSUES = ["HOBO-554", "HOBO-577"] as const;

export const REQUIRED_REPRESENTATIVE_QUICKSTART_FIXTURE_IDS = [
  "rlq-define-object-graph-v1",
  "rlq-plan-safe-preview-v1",
  "rlq-inspect-event-projection-v1",
  "rlq-deploy-run-accepted-v1",
  "rlq-manage-stale-evidence-v1",
  "rlq-recover-snapshot-restore-v1",
  "rlq-collect-manifest-ir-v1",
  "rlq-recover-scope-out-v1",
] as const;

export const REQUIRED_REPRESENTATIVE_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
  "accessibility-notes",
  "proof-mode-labels",
] as const;

const REQUIRED_REPRESENTATIVE_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

type RepresentativeArtifact = (typeof REQUIRED_REPRESENTATIVE_ARTIFACTS)[number];
type RepresentativeCheckId = (typeof REQUIRED_REPRESENTATIVE_CHECKS)[number];
type RepresentativeSourceIssue = (typeof REQUIRED_REPRESENTATIVE_SOURCE_ISSUES)[number];
type RepresentativeQuickstartFixtureId =
  (typeof REQUIRED_REPRESENTATIVE_QUICKSTART_FIXTURE_IDS)[number];
type RepresentativeScenarioId = (typeof REQUIRED_REPRESENTATIVE_SCENARIOS)[number];
type RepresentativeProofMode = (typeof REQUIRED_REPRESENTATIVE_PROOF_MODES)[number];
type QuickstartProofMode = "reference-fixture" | "simulated" | "live" | "scope-out";
type CheckSeverity = "launch-blocker" | "major" | "minor";

// domain-view: parse-produced draft-proof record; its wire form is the RepresentativeCheckDefinition proto message in data-models/.
export type RepresentativeCheckDefinition = {
  readonly id: RepresentativeCheckId;
  readonly label: string;
  readonly evidenceKind: string;
  readonly proves: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the RepresentativeCheckEvidence proto message in data-models/.
export type RepresentativeCheckEvidence = {
  readonly checkId: RepresentativeCheckId;
  readonly expectedEvidence: string;
  readonly severity: CheckSeverity;
  readonly ownerRoute: string;
  readonly acceptedRiskPath: string;
  readonly launchReadinessImpact: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the RepresentativeArtifactChecks proto message in data-models/.
export type RepresentativeArtifactChecks = {
  readonly artifact: RepresentativeArtifact;
  readonly title: string;
  readonly ownerRoute: string;
  readonly acceptedRiskPath: string;
  readonly checklistSourceIssue: "HOBO-554";
  readonly quickstartFixtureId: RepresentativeQuickstartFixtureId;
  readonly checks: readonly RepresentativeCheckEvidence[];
  readonly proofModeLabels: readonly RepresentativeProofMode[];
  readonly accessibilityNote: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the RepresentativeQuickstartFixtureReference proto message in data-models/.
export type RepresentativeQuickstartFixtureReference = {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: RepresentativeQuickstartFixtureId;
  readonly proofMode: QuickstartProofMode;
  readonly consumingArtifact: RepresentativeArtifact;
  readonly representativeUse: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the RepresentativeScenario proto message in data-models/.
export type RepresentativeScenario = {
  readonly id: RepresentativeScenarioId;
  readonly artifactRefs: readonly RepresentativeArtifact[];
  readonly requiredEvidence: readonly string[];
  readonly safeOutcome: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the VibeRepresentativeA11yUsabilityChecks proto message in data-models/.
export type VibeRepresentativeA11yUsabilityChecks = {
  readonly issue: "HOBO-565";
  readonly phase: "M2";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-representative-a11y-usability-checks";
  readonly proofPath: "docs/design/proofs/vibe-representative-a11y-usability-checks/README.md";
  readonly designRefs: readonly string[];
  readonly sourceIssues: readonly RepresentativeSourceIssue[];
  readonly quickstartFixtureRefs: readonly RepresentativeQuickstartFixtureReference[];
  readonly checkDefinitions: readonly RepresentativeCheckDefinition[];
  readonly artifactChecks: readonly RepresentativeArtifactChecks[];
  readonly scenarios: readonly RepresentativeScenario[];
  readonly proofModeLabels: readonly RepresentativeProofMode[];
  readonly scopeOut: readonly string[];
};

export type ValidationError = {
  readonly code: string;
  readonly message: string;
};

declare const parsedRepresentativeChecksBrand: unique symbol;

export type ParsedVibeRepresentativeA11yUsabilityChecks =
  VibeRepresentativeA11yUsabilityChecks & {
    readonly [parsedRepresentativeChecksBrand]: true;
  };

export type RepresentativeCheckRequestClassification = "in-scope-proof" | "scope-out";

const CHECK_DEFINITIONS: readonly RepresentativeCheckDefinition[] = [
  {
    id: "keyboard-path",
    label: "Keyboard path",
    evidenceKind: "manual representative check",
    proves: "Primary artifact steps are reachable, ordered, and operable without pointer input.",
  },
  {
    id: "screen-reader-smoke",
    label: "Screen-reader smoke",
    evidenceKind: "manual assistive-tech smoke check",
    proves: "Representative labels, landmarks, state, owner, and next action are announced.",
  },
  {
    id: "responsive-layout",
    label: "Responsive layout",
    evidenceKind: "deterministic viewport fixture",
    proves: "Required text, controls, and status fields remain visible without overlap.",
  },
  {
    id: "contrast-threshold",
    label: "Contrast threshold",
    evidenceKind: "deterministic color-token fixture",
    proves: "Text, state, focus, and severity affordances meet launch baseline or carry limitation evidence.",
  },
  {
    id: "reduced-motion",
    label: "Reduced motion",
    evidenceKind: "preference-state fixture",
    proves: "Motion-heavy transitions expose a reduced-motion posture and preserve status meaning.",
  },
  {
    id: "state-clarity",
    label: "State clarity",
    evidenceKind: "reference fixture",
    proves: "Happy, blocked, stale, unknown, and scope-out states explain owner and next action.",
  },
  {
    id: "copy-clarity",
    label: "Copy clarity",
    evidenceKind: "beta-facing copy review",
    proves: "Artifact copy is customer-safe, support-routable, and does not overstate readiness.",
  },
] as const;

const ARTIFACT_CONFIGS: readonly Omit<RepresentativeArtifactChecks, "checks" | "checklistSourceIssue" | "proofModeLabels">[] = [
  {
    artifact: "onboarding",
    title: "First-run onboarding and workspace activation artifact",
    ownerRoute: "Workspace & Onboarding UX",
    acceptedRiskPath: "launch-cutline-review",
    quickstartFixtureId: "rlq-define-object-graph-v1",
    accessibilityNote: "Exercise invite, anonymous try-it, workspace, project, blocker, and value-proof entry states.",
  },
  {
    artifact: "plan-diff",
    title: "Plan/diff review artifact over golden fixtures",
    ownerRoute: "Plan/Diff Viewer",
    acceptedRiskPath: "release-owner-review",
    quickstartFixtureId: "rlq-plan-safe-preview-v1",
    accessibilityNote: "Exercise safe, destructive, blocked, stale, unknown-evidence, policy, cost, and approval states.",
  },
  {
    artifact: "deployment-dashboard",
    title: "Deployment dashboard and topology/status artifact",
    ownerRoute: "Deployment Dashboard & Topology Explorer",
    acceptedRiskPath: "product-owner-remediation",
    quickstartFixtureId: "rlq-inspect-event-projection-v1",
    accessibilityNote: "Exercise topology, timeline, health, stale projection, RBAC, and support handoff states.",
  },
  {
    artifact: "marketplace",
    title: "Marketplace discovery and install-intent artifact",
    ownerRoute: "Marketplace UX",
    acceptedRiskPath: "product-owner-remediation",
    quickstartFixtureId: "rlq-deploy-run-accepted-v1",
    accessibilityNote: "Exercise approved, preview, limited beta, policy-blocked, deprecated, and yanked listing states.",
  },
  {
    artifact: "docs",
    title: "Docs portal, tutorials, troubleshooting, and search artifact",
    ownerRoute: "Docs Portal",
    acceptedRiskPath: "release-owner-review",
    quickstartFixtureId: "rlq-manage-stale-evidence-v1",
    accessibilityNote: "Exercise audience path, search metadata, stale-content, tutorial, and troubleshooting states.",
  },
  {
    artifact: "support",
    title: "Support case and redacted evidence handoff artifact",
    ownerRoute: "V1 Launch Support Desk & Escalation",
    acceptedRiskPath: "support-owner-route",
    quickstartFixtureId: "rlq-recover-snapshot-restore-v1",
    accessibilityNote: "Exercise intake, severity, evidence-linked, owner-routed, customer-updated, and closed states.",
  },
  {
    artifact: "publisher",
    title: "Publisher profile, submission, review, rejection, and yank remediation artifact",
    ownerRoute: "Publisher Portal",
    acceptedRiskPath: "product-owner-remediation",
    quickstartFixtureId: "rlq-collect-manifest-ir-v1",
    accessibilityNote: "Exercise maintainer roles, evidence upload, review queue, rejection, and remediation states.",
  },
  {
    artifact: "launch-demo",
    title: "Launch demo storyboard, screenshot manifest, and proof-mode asset artifact",
    ownerRoute: "V1 Release Program & Cutline",
    acceptedRiskPath: "launch-cutline-review",
    quickstartFixtureId: "rlq-recover-scope-out-v1",
    accessibilityNote: "Exercise recording manifest, screenshot, transcript, fixture refresh, limitation, and scope-out labels.",
  },
] as const;

const QUICKSTART_FIXTURE_REFS: readonly RepresentativeQuickstartFixtureReference[] = [
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-define-object-graph-v1",
    proofMode: "reference-fixture",
    consumingArtifact: "onboarding",
    representativeUse: "onboarding evidence reuses accepted object-graph labels and first-run step order",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-plan-safe-preview-v1",
    proofMode: "simulated",
    consumingArtifact: "plan-diff",
    representativeUse: "plan review evidence reuses accepted plan preview proof-mode and refusal wording",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-inspect-event-projection-v1",
    proofMode: "reference-fixture",
    consumingArtifact: "deployment-dashboard",
    representativeUse: "dashboard evidence reuses projection fixture ids for topology and stale-state checks",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-deploy-run-accepted-v1",
    proofMode: "live",
    consumingArtifact: "marketplace",
    representativeUse: "marketplace install intent can cite accepted deploy evidence without building install runtime",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-manage-stale-evidence-v1",
    proofMode: "reference-fixture",
    consumingArtifact: "docs",
    representativeUse: "docs and troubleshooting evidence reuse stale-evidence copy and owner routing",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-snapshot-restore-v1",
    proofMode: "live",
    consumingArtifact: "support",
    representativeUse: "support handoff evidence can cite recovery fixture without promising production restore",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-collect-manifest-ir-v1",
    proofMode: "simulated",
    consumingArtifact: "publisher",
    representativeUse: "publisher review evidence reuses manifest collection fixture names for uploaded proof records",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-scope-out-v1",
    proofMode: "scope-out",
    consumingArtifact: "launch-demo",
    representativeUse: "launch demo evidence keeps scope-out labels visible before launch claims are allowed",
  },
] as const;

export const VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS: VibeRepresentativeA11yUsabilityChecks = {
  issue: "HOBO-565",
  phase: "M2",
  packagePath: "src/draft/exp-proofs/ux/vibe-representative-a11y-usability-checks",
  proofPath: "docs/design/proofs/vibe-representative-a11y-usability-checks/README.md",
  designRefs: [
    "docs/design/accessibility-usability-launch-baseline.md",
    "docs/design/workspace-onboarding-ux.md",
    "docs/design/plan-diff-viewer.md",
    "docs/design/deployment-dashboard-topology-explorer.md",
    "docs/design/marketplace-ux.md",
    "docs/design/docs-portal.md",
    "docs/design/support-workflow.md",
    "docs/design/publisher-portal.md",
    "docs/design/launch-demo-golden-path.md",
    "docs/design/proofs/vibe-accessibility-usability-checklist/README.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  sourceIssues: REQUIRED_REPRESENTATIVE_SOURCE_ISSUES,
  quickstartFixtureRefs: QUICKSTART_FIXTURE_REFS,
  checkDefinitions: CHECK_DEFINITIONS,
  artifactChecks: ARTIFACT_CONFIGS.map((artifact) => ({
    ...artifact,
    checklistSourceIssue: "HOBO-554",
    proofModeLabels: REQUIRED_REPRESENTATIVE_PROOF_MODES,
    checks: CHECK_DEFINITIONS.map((check) => ({
      checkId: check.id,
      expectedEvidence: `${artifact.artifact} ${check.label.toLowerCase()} evidence over ${artifact.quickstartFixtureId}`,
      severity: severityFor(artifact.artifact, check.id),
      ownerRoute: artifact.ownerRoute,
      acceptedRiskPath: artifact.acceptedRiskPath,
      launchReadinessImpact: readinessImpactFor(artifact.artifact, check.id),
    })),
  })),
  scenarios: [
    {
      id: "happy-path",
      artifactRefs: ["onboarding", "plan-diff", "deployment-dashboard", "marketplace"],
      requiredEvidence: ["all required representative checks pass", "owner route recorded", "proof mode visible"],
      safeOutcome: "artifact can be treated as branch evidence for the named fixture only",
    },
    {
      id: "blocked-path",
      artifactRefs: ["plan-diff", "marketplace", "publisher", "support"],
      requiredEvidence: ["blocking check id", "severity", "accepted-risk path", "launch readiness impact"],
      safeOutcome: "route blocker to owner without waiving launch gates or inventing runtime behavior",
    },
    {
      id: "stale-or-unknown-evidence",
      artifactRefs: ["deployment-dashboard", "docs", "launch-demo"],
      requiredEvidence: ["freshness label", "unknown evidence copy", "safe downgrade path"],
      safeOutcome: "mark evidence stale or unknown instead of using it as launch-ready proof",
    },
    {
      id: "support-handoff",
      artifactRefs: ["support", "publisher", "marketplace", "docs"],
      requiredEvidence: ["customer-safe summary", "owner route", "next update condition"],
      safeOutcome: "handoff redacted evidence to the named owner without customer-data exposure",
    },
    {
      id: "accessibility-notes",
      artifactRefs: ["onboarding", "publisher", "docs", "launch-demo"],
      requiredEvidence: ["keyboard path", "screen-reader smoke", "responsive layout", "reduced-motion note"],
      safeOutcome: "make accessibility disposition explicit before customer-ready claims",
    },
    {
      id: "proof-mode-labels",
      artifactRefs: ["launch-demo", "plan-diff", "deployment-dashboard", "marketplace"],
      requiredEvidence: ["live label", "simulated label", "reference fixture label", "scope-out label"],
      safeOutcome: "keep live, simulated, reference fixture, and scope-out evidence separate",
    },
  ],
  proofModeLabels: REQUIRED_REPRESENTATIVE_PROOF_MODES,
  scopeOut: [
    "No full accessibility audit or certification.",
    "No product UI remediation.",
    "No automated accessibility test suite buildout.",
    "No launch waiver approval.",
    "No customer data or customer screenshots.",
    "No launch claims without named evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(full accessibility audit|audit execution|certify|certification)\b/i,
  /\b(product ui|ui remediation|remediate.*screen|fix.*product)\b/i,
  /\b(automated accessibility test suite|automated test suite|axe suite|playwright suite)\b/i,
  /\b(launch waiver|waiver approval|approve.*exception|accepted-risk approval)\b/i,
  /\b(customer data|customer screenshot|real customer|tenant data)\b/i,
  /\b(launch claim|customer-ready claim|public claim).*\b(without evidence|unsupported)?\b/i,
];

export class VibeRepresentativeChecksParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(
      `Vibe representative accessibility and usability checks failed parsing: ${errors
        .map((error) => error.code)
        .join(", ")}`,
    );
    this.name = "VibeRepresentativeChecksParseError";
  }
}

export function parseVibeRepresentativeA11yUsabilityChecks(
  checks: VibeRepresentativeA11yUsabilityChecks,
): ParsedVibeRepresentativeA11yUsabilityChecks {
  const validation = validateVibeRepresentativeA11yUsabilityChecks(checks);

  if (!validation.ok) {
    throw new VibeRepresentativeChecksParseError(validation.errors);
  }

  // SAFETY: `return checks as ParsedVibeRepresentativeA11yUsabilityChecks;` is required at this I/O or test boundary.
  return checks as ParsedVibeRepresentativeA11yUsabilityChecks;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibeRepresentativeA11yUsabilityChecks(
  checks: VibeRepresentativeA11yUsabilityChecks,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (checks.issue !== "HOBO-565") {
    errors.push({ code: "wrong-issue", message: "representative checks must pin HOBO-565" });
  }
  if (checks.phase !== "M2") {
    errors.push({ code: "wrong-phase", message: "representative checks must stay in M2" });
  }
  if (checks.packagePath !== "src/draft/exp-proofs/ux/vibe-representative-a11y-usability-checks") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (checks.proofPath !== "docs/design/proofs/vibe-representative-a11y-usability-checks/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }
  if (!arraysEqual(checks.sourceIssues, REQUIRED_REPRESENTATIVE_SOURCE_ISSUES)) {
    errors.push({ code: "missing-source-issue", message: "representative checks must cite HOBO-554 and HOBO-577" });
  }
  if (!arraysEqual(checks.checkDefinitions.map((check) => check.id), REQUIRED_REPRESENTATIVE_CHECKS)) {
    errors.push({ code: "missing-check-definition", message: "representative check ids drifted" });
  }
  if (!arraysEqual(checks.artifactChecks.map((artifact) => artifact.artifact), REQUIRED_REPRESENTATIVE_ARTIFACTS)) {
    errors.push({ code: "missing-artifact", message: "representative artifact coverage drifted" });
  }
  if (!arraysEqual(checks.proofModeLabels, REQUIRED_REPRESENTATIVE_PROOF_MODES)) {
    errors.push({ code: "missing-proof-mode-label", message: "proof labels must cover live, simulated, reference fixture, and scope-out" });
  }

  validateQuickstartFixtureRefs(checks.quickstartFixtureRefs, errors);

  for (const definition of checks.checkDefinitions) {
    if (!definition.label || !definition.evidenceKind || !definition.proves) {
      errors.push({
        code: "incomplete-check-definition",
        message: `${definition.id} must name label, evidence kind, and proof statement`,
      });
    }
  }

  for (const artifact of checks.artifactChecks) {
    if (artifact.checklistSourceIssue !== "HOBO-554") {
      errors.push({
        code: "wrong-checklist-source",
        message: `${artifact.artifact} must cite HOBO-554`,
      });
    }
    if (!artifact.ownerRoute || !artifact.acceptedRiskPath || !artifact.accessibilityNote) {
      errors.push({
        code: "missing-artifact-metadata",
        message: `${artifact.artifact} must name owner, accepted-risk path, and accessibility note`,
      });
    }
    if (!REQUIRED_REPRESENTATIVE_QUICKSTART_FIXTURE_IDS.includes(artifact.quickstartFixtureId)) {
      errors.push({
        code: "unknown-artifact-quickstart-fixture",
        message: `${artifact.artifact} cites unknown quickstart fixture`,
      });
    }
    if (!arraysEqual(artifact.proofModeLabels, REQUIRED_REPRESENTATIVE_PROOF_MODES)) {
      errors.push({
        code: "missing-artifact-proof-mode",
        message: `${artifact.artifact} must carry all proof-mode labels`,
      });
    }
    if (!arraysEqual(artifact.checks.map((check) => check.checkId), REQUIRED_REPRESENTATIVE_CHECKS)) {
      errors.push({
        code: "missing-artifact-check",
        message: `${artifact.artifact} must carry every representative check`,
      });
    }
    for (const check of artifact.checks) {
      if (!check.expectedEvidence) {
        errors.push({
          code: "missing-check-evidence",
          message: `${artifact.artifact}:${check.checkId} must name expected evidence`,
        });
      }
      if (!["launch-blocker", "major", "minor"].includes(check.severity)) {
        errors.push({
          code: "invalid-check-severity",
          message: `${artifact.artifact}:${check.checkId} uses invalid severity`,
        });
      }
      if (!check.ownerRoute || !check.acceptedRiskPath || !check.launchReadinessImpact) {
        errors.push({
          code: "missing-check-routing",
          message: `${artifact.artifact}:${check.checkId} must name owner, risk path, and launch impact`,
        });
      }
    }
  }

  if (!arraysEqual(checks.scenarios.map((scenario) => scenario.id), REQUIRED_REPRESENTATIVE_SCENARIOS)) {
    errors.push({
      code: "missing-scenario",
      message: "scenario coverage must include happy, blocked, stale/unknown, support, accessibility, and proof labels",
    });
  }
  for (const scenario of checks.scenarios) {
    if (scenario.artifactRefs.length === 0 || scenario.requiredEvidence.length === 0 || !scenario.safeOutcome) {
      errors.push({
        code: "incomplete-scenario",
        message: `${scenario.id} must name artifacts, evidence, and safe outcome`,
      });
    }
    for (const artifact of scenario.artifactRefs) {
      if (!REQUIRED_REPRESENTATIVE_ARTIFACTS.includes(artifact)) {
        errors.push({
          code: "unknown-scenario-artifact",
          message: `${scenario.id} references unknown artifact ${String(artifact)}`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function summarizeArtifactReadiness(
  checks: ParsedVibeRepresentativeA11yUsabilityChecks,
): ReadonlyArray<{
  readonly artifact: RepresentativeArtifact;
  readonly ownerRoute: string;
  readonly requiredChecks: number;
  readonly highestSeverity: CheckSeverity;
  readonly acceptedRiskPath: string;
  readonly claimsFullAudit: boolean;
}> {
  return checks.artifactChecks.map((artifact) => ({
    artifact: artifact.artifact,
    ownerRoute: artifact.ownerRoute,
    requiredChecks: artifact.checks.length,
    highestSeverity: highestSeverity(artifact.checks.map((check) => check.severity)),
    acceptedRiskPath: artifact.acceptedRiskPath,
    claimsFullAudit: /full accessibility audit|certification/i.test(
      [
        artifact.accessibilityNote,
        ...artifact.checks.map((check) => `${check.expectedEvidence} ${check.launchReadinessImpact}`),
      ].join(" "),
    ),
  }));
}

export function classifyRepresentativeCheckRequest(
  summary: string,
): RepresentativeCheckRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

function validateQuickstartFixtureRefs(
  refs: readonly RepresentativeQuickstartFixtureReference[],
  errors: ValidationError[],
): void {
  if (!Array.isArray(refs)) {
    errors.push({
      code: "missing-quickstart-fixture-refs",
      message: "representative checks must cite HOBO-577 quickstart fixtures",
    });
    return;
  }

  if (!arraysEqual(refs.map((ref) => ref.fixtureId), REQUIRED_REPRESENTATIVE_QUICKSTART_FIXTURE_IDS)) {
    errors.push({
      code: "missing-quickstart-fixture",
      message: "required HOBO-577 quickstart fixture ids drifted",
    });
  }
  for (const ref of refs) {
    if (ref.sourceIssue !== "HOBO-577") {
      errors.push({ code: "wrong-quickstart-source", message: `${ref.fixtureId} must cite HOBO-577` });
    }
    if (!REQUIRED_REPRESENTATIVE_ARTIFACTS.includes(ref.consumingArtifact)) {
      errors.push({
        code: "unknown-quickstart-artifact",
        message: `${ref.fixtureId} targets unknown representative artifact`,
      });
    }
    if (!ref.representativeUse || ref.representativeUse.length < 30) {
      errors.push({
        code: "missing-quickstart-use",
        message: `${ref.fixtureId} must explain representative artifact consumption`,
      });
    }
  }
}

function severityFor(artifact: RepresentativeArtifact, checkId: RepresentativeCheckId): CheckSeverity {
  if (
    checkId === "keyboard-path" ||
    checkId === "screen-reader-smoke" ||
    artifact === "onboarding" ||
    artifact === "support" ||
    artifact === "launch-demo"
  ) {
    return "launch-blocker";
  }
  if (checkId === "copy-clarity" && (artifact === "docs" || artifact === "marketplace")) {
    return "major";
  }
  if (checkId === "state-clarity" || checkId === "contrast-threshold" || checkId === "responsive-layout") {
    return "major";
  }
  return "minor";
}

function readinessImpactFor(artifact: RepresentativeArtifact, checkId: RepresentativeCheckId): string {
  const base = `${artifact} cannot be treated as launch-ready evidence until ${checkId} has named proof`;
  return severityFor(artifact, checkId) === "launch-blocker"
    ? `${base}; release cutline must block or route accepted risk`
    : `${base}; owner must remediate or document limitation`;
}

function highestSeverity(severities: readonly CheckSeverity[]): CheckSeverity {
  if (severities.includes("launch-blocker")) return "launch-blocker";
  if (severities.includes("major")) return "major";
  return "minor";
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
