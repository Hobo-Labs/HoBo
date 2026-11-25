import { isJsonString } from "./json.js";
export const REQUIRED_TUTORIAL_ROLES = [
  "app developer",
  "platform engineer",
  "GitOps",
  "SecOps",
  "DevOps",
  "SRE",
] as const;

export const REQUIRED_ROLE_TUTORIAL_COVERAGE = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_ROLE_TUTORIAL_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_ROLE_TUTORIAL_QUICKSTART_FIXTURE_IDS = [
  "rlq-define-object-graph-v1",
  "rlq-collect-manifest-ir-v1",
  "rlq-plan-safe-preview-v1",
  "rlq-deploy-run-accepted-v1",
  "rlq-inspect-event-projection-v1",
  "rlq-manage-stale-evidence-v1",
  "rlq-migrate-brownfield-preview-v1",
  "rlq-recover-snapshot-restore-v1",
  "rlq-recover-scope-out-v1",
] as const;

const QUICKSTART_PROOF_MODES = [
  "reference-fixture",
  "simulated",
  "live",
  "scope-out",
] as const;

type TutorialRole = (typeof REQUIRED_TUTORIAL_ROLES)[number];
type TutorialCoveragePath = (typeof REQUIRED_ROLE_TUTORIAL_COVERAGE)[number];
type TutorialProofMode = (typeof REQUIRED_ROLE_TUTORIAL_PROOF_MODES)[number];
type TutorialQuickstartFixtureId = (typeof REQUIRED_ROLE_TUTORIAL_QUICKSTART_FIXTURE_IDS)[number];
type QuickstartProofMode = (typeof QUICKSTART_PROOF_MODES)[number];

// domain-view: parse-produced draft-proof record; its wire form is the TutorialCoverage proto message in data-models/.
type TutorialCoverage = {
  readonly id: TutorialCoveragePath;
  readonly evidence: string;
  readonly outlineRoles: readonly TutorialRole[];
};

// domain-view: parse-produced draft-proof record; its wire form is the TutorialQuickstartFixtureRef proto message in data-models/.
type TutorialQuickstartFixtureRef = {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: TutorialQuickstartFixtureId;
  readonly proofMode: QuickstartProofMode;
  readonly tutorialUse: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the RoleTutorialOutline proto message in data-models/.
type RoleTutorialOutline = {
  readonly role: TutorialRole;
  readonly walkthroughAnchor: string;
  readonly personaGoal: string;
  readonly prerequisites: readonly string[];
  readonly commandPath: readonly string[];
  readonly mcpTools: readonly string[];
  readonly fixtureStrategy: string;
  readonly expectedOutputs: readonly string[];
  readonly failureBranch: string;
  readonly proofModeLabels: readonly TutorialProofMode[];
  readonly quickstartFixtureIds: readonly TutorialQuickstartFixtureId[];
  readonly accessibilityNotes: readonly string[];
  readonly supportHandoff: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the VibeRoleTutorialOutlines proto message in data-models/.
type VibeRoleTutorialOutlines = {
  readonly issue: "HOBO-552";
  readonly phase: "M1";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-role-tutorial-outlines";
  readonly proofPath: "docs/design/proofs/vibe-role-tutorial-outlines/README.md";
  readonly designRefs: readonly string[];
  readonly roles: readonly TutorialRole[];
  readonly quickstartFixtureRefs: readonly TutorialQuickstartFixtureRef[];
  readonly coveragePaths: readonly TutorialCoverage[];
  readonly outlines: readonly RoleTutorialOutline[];
  readonly scopeOut: readonly string[];
};

declare const parsedRoleTutorialOutlinesBrand: unique symbol;

export type ParsedVibeRoleTutorialOutlines = VibeRoleTutorialOutlines & {
  readonly [parsedRoleTutorialOutlinesBrand]: true;
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

const allProofModes = [...REQUIRED_ROLE_TUTORIAL_PROOF_MODES] as const;

const allRoles = [...REQUIRED_TUTORIAL_ROLES] as const;

const standardScopeOut = [
  "No final tutorial content.",
  "No live provider execution.",
  "No hosted docs implementation.",
  "No production recordings.",
  "No customer data.",
  "No launch claims without evidence.",
] as const;

export const VIBE_ROLE_TUTORIAL_OUTLINES: VibeRoleTutorialOutlines = {
  issue: "HOBO-552",
  phase: "M1",
  packagePath: "src/draft/exp-proofs/ux/vibe-role-tutorial-outlines",
  proofPath: "docs/design/proofs/vibe-role-tutorial-outlines/README.md",
  designRefs: [
    "docs/design/tutorials-walkthroughs.md",
    "docs/design/walkthrough.md",
    "docs/design/worked-example.md#plan-19",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
    "docs/design/proofs/dx-resource-lifecycle-scenario-matrix/README.md",
    "docs/design/proofs/cli-mcp-parity-resource-lifecycle-contracts/README.md",
  ],
  roles: allRoles,
  quickstartFixtureRefs: [
    {
      sourceIssue: "HOBO-577",
      fixtureId: "rlq-define-object-graph-v1",
      proofMode: "reference-fixture",
      tutorialUse: "role outlines start from the accepted object graph fixture rather than inventing tutorial resources",
    },
    {
      sourceIssue: "HOBO-577",
      fixtureId: "rlq-collect-manifest-ir-v1",
      proofMode: "simulated",
      tutorialUse: "all role outlines can start from accepted manifest collection output without running a live collector",
    },
    {
      sourceIssue: "HOBO-577",
      fixtureId: "rlq-plan-safe-preview-v1",
      proofMode: "simulated",
      tutorialUse: "plan and approval tutorial steps consume the same DeploymentPlan and Gatekeeper preview fixture",
    },
    {
      sourceIssue: "HOBO-577",
      fixtureId: "rlq-deploy-run-accepted-v1",
      proofMode: "simulated",
      tutorialUse: "deploy-oriented tutorial checkpoints consume the accepted simulated Deployment Set receipt",
    },
    {
      sourceIssue: "HOBO-577",
      fixtureId: "rlq-inspect-event-projection-v1",
      proofMode: "reference-fixture",
      tutorialUse: "inspect and doctor tutorial steps read replayed projection evidence instead of plan-only state",
    },
    {
      sourceIssue: "HOBO-577",
      fixtureId: "rlq-manage-stale-evidence-v1",
      proofMode: "reference-fixture",
      tutorialUse: "blocked and stale tutorial branches use the accepted doctor/stale-evidence fixture",
    },
    {
      sourceIssue: "HOBO-577",
      fixtureId: "rlq-migrate-brownfield-preview-v1",
      proofMode: "simulated",
      tutorialUse: "platform, GitOps, and DevOps outlines can reference migration preview evidence without adoption authority",
    },
    {
      sourceIssue: "HOBO-577",
      fixtureId: "rlq-recover-snapshot-restore-v1",
      proofMode: "reference-fixture",
      tutorialUse: "rollback and recovery tutorial branches use accepted snapshot-restore preview evidence",
    },
    {
      sourceIssue: "HOBO-577",
      fixtureId: "rlq-recover-scope-out-v1",
      proofMode: "scope-out",
      tutorialUse: "every outline carries an explicit recovery and production-live boundary",
    },
  ],
  coveragePaths: [
    {
      id: "happy-path",
      evidence: "each role reaches an accepted fixture-backed checkpoint with expected outputs and proof-mode labels",
      outlineRoles: allRoles,
    },
    {
      id: "blocked-path",
      evidence: "each role names a blocked branch and support-safe next action instead of hiding failed evidence",
      outlineRoles: allRoles,
    },
    {
      id: "stale-or-unknown-evidence",
      evidence: "each role routes stale or unknown evidence through the HOBO-577 doctor fixture and safe limitation wording",
      outlineRoles: allRoles,
    },
    {
      id: "support-handoff",
      evidence: "each role has a support handoff with owner, evidence source, and safe next step",
      outlineRoles: allRoles,
    },
  ],
  outlines: [
    {
      role: "app developer",
      walkthroughAnchor: "docs/design/walkthrough.md#part-1--app-developer-one-command-to-live",
      personaGoal: "Move from a sample app idea to collect, plan, deploy simulation, inspect, and recovery evidence without choosing providers.",
      prerequisites: [
        "accepted snapshop resource lifecycle quickstart fixtures",
        "local repository with mocked HoBo boundaries and no provider credentials",
      ],
      commandPath: [
        "hobo new snapshop --fixture resource-lifecycle",
        "hobo collect ./examples/snapshop --fixture rlq-collect-manifest-ir-v1 --json",
        "hobo plan --fixture rlq-collect-manifest-ir-v1 --camp preview --json",
        "hobo up --plan-fixture rlq-plan-safe-preview-v1 --mode simulated --json",
        "hobo inspect run --fixture rlq-deploy-run-accepted-v1 --last --json",
      ],
      mcpTools: ["hobo_read_resource_lifecycle_fixture", "hobo_collect", "hobo_plan", "hobo_up", "hobo_inspect_run"],
      fixtureStrategy: "Reuse HOBO-577 define, collect, plan, deploy, inspect, stale-evidence, and scope-out fixtures so the tutorial proves workflow shape without provider execution.",
      expectedOutputs: [
        "hobo.manifest/v1 fixture reference",
        "DeploymentPlan preview with proof mode",
        "simulated Deployment Set receipt",
        "support-safe inspect output",
      ],
      failureBranch: "If plan evidence is stale or unknown, route to hobo doctor over rlq-manage-stale-evidence-v1 and stop before deploy claims.",
      proofModeLabels: allProofModes,
      quickstartFixtureIds: [
        "rlq-define-object-graph-v1",
        "rlq-collect-manifest-ir-v1",
        "rlq-plan-safe-preview-v1",
        "rlq-deploy-run-accepted-v1",
        "rlq-inspect-event-projection-v1",
        "rlq-manage-stale-evidence-v1",
        "rlq-recover-scope-out-v1",
      ],
      accessibilityNotes: [
        "Terminal examples preserve command, output, proof mode, and next action in keyboard-copyable text.",
        "Screen reader and non-visual readers get explicit status labels instead of color-only success or failure.",
      ],
      supportHandoff: "Support receives fixture id, failed checkpoint, proof mode, and next safe action without customer payloads or credentials.",
    },
    {
      role: "platform engineer",
      walkthroughAnchor: "docs/design/walkthrough.md#part-2--platform-engineer-map-platform-defaults",
      personaGoal: "Evaluate provider defaults, resource definitions, and approval boundaries before app teams rely on inferred Camps.",
      prerequisites: [
        "accepted resource definition and plan-preview fixtures",
        "policy owner for inferred Camp approval remains outside this proof",
      ],
      commandPath: [
        "hobo plan ./platform --camp prod --fixture rlq-plan-safe-preview-v1 --json",
        "hobo up ./platform --camp prod --mode simulated --json",
        "hobo doctor --camp prod --fixture rlq-inspect-event-projection-v1",
        "hobo inspect topology --camp prod --fixture rlq-inspect-event-projection-v1",
      ],
      mcpTools: ["hobo_plan_platform", "hobo_up_platform", "hobo_doctor", "hobo_inspect_topology"],
      fixtureStrategy: "Bind platform-default tutorial steps to DeploymentPlan, stale-evidence, and migration-preview fixtures while keeping provider catalogs mocked.",
      expectedOutputs: [
        "provider-default checklist tied to fixture ids",
        "Gatekeeper preview for inferred Camp approval",
        "topology/status read model label",
      ],
      failureBranch: "If a provider default is missing or stale, stop at doctor guidance and route to platform owner before app tutorials advance.",
      proofModeLabels: allProofModes,
      quickstartFixtureIds: [
        "rlq-plan-safe-preview-v1",
        "rlq-deploy-run-accepted-v1",
        "rlq-inspect-event-projection-v1",
        "rlq-manage-stale-evidence-v1",
        "rlq-migrate-brownfield-preview-v1",
        "rlq-recover-scope-out-v1",
      ],
      accessibilityNotes: [
        "Keyboard order follows prerequisite, command, expected evidence, and owner-route cells.",
        "Screen reader and non-visual summaries include environment, proof mode, and owner route.",
      ],
      supportHandoff: "Route blocked defaults to Platform Engineering with proof fixture, missing decision, and no live provider credentials.",
    },
    {
      role: "GitOps",
      walkthroughAnchor: "docs/design/walkthrough.md#part-3--gitops-git-is-the-trigger-hobo-up-is-the-engine",
      personaGoal: "Turn PR-driven plan, preview, promotion, rollback, and drift evidence into a tutorial outline that stays CLI-first.",
      prerequisites: [
        "CI fixture can render hobo plan and hobo up output as reference transcript",
        "promotion and rollback are simulated against Deployment Set fixtures",
      ],
      commandPath: [
        "git push origin feature/snapshop",
        "hobo plan --camp pr-42 --fixture rlq-plan-safe-preview-v1 --json",
        "hobo up --camp pr-42 --mode simulated --json",
        "hobo up --camp prod --rollback deployment-set:previous --fixture rlq-recover-snapshot-restore-v1 --dry-run",
      ],
      mcpTools: ["hobo_plan_ci", "hobo_up_ci", "hobo_promote", "hobo_rollback"],
      fixtureStrategy: "Reuse plan, deploy, migration, snapshot-recovery, and recovery scope-out fixtures so GitOps learns PR automation behavior without mutable production deploys.",
      expectedOutputs: [
        "PR plan comment fixture",
        "preview Camp proof-mode label",
        "rollback dry-run limitation and owner route",
      ],
      failureBranch: "If CI reads stale plan evidence, require a fresh hobo plan fixture and route unsupported promotion to release owner.",
      proofModeLabels: allProofModes,
      quickstartFixtureIds: [
        "rlq-plan-safe-preview-v1",
        "rlq-deploy-run-accepted-v1",
        "rlq-manage-stale-evidence-v1",
        "rlq-migrate-brownfield-preview-v1",
        "rlq-recover-snapshot-restore-v1",
        "rlq-recover-scope-out-v1",
      ],
      accessibilityNotes: [
        "CI tutorial output includes text status for pending, blocked, stale, and accepted states.",
        "Non-visual readers get the exact command, fixture id, and support owner in each PR-comment example.",
      ],
      supportHandoff: "Support receives PR fixture id, failed command, release owner, and customer-safe limitation wording.",
    },
    {
      role: "SecOps",
      walkthroughAnchor: "docs/design/walkthrough.md#part-4--secops-trust-as-code-secrets-never-typed",
      personaGoal: "Review policy, proof evidence, denial, and waiver boundaries for tutorial steps without granting hidden authority.",
      prerequisites: [
        "Gatekeeper and policy-denial fixtures are accepted",
        "no static keys, provider credentials, or customer data appear in examples",
      ],
      commandPath: [
        "hobo plan --fixture rlq-plan-safe-preview-v1 --camp prod --json",
        "hobo doctor --fixture rlq-inspect-event-projection-v1 --policy-pack platform",
        "hobo up --camp prod --mode simulated --json",
      ],
      mcpTools: ["hobo_plan", "hobo_doctor_policy", "hobo_policy_decision", "hobo_up"],
      fixtureStrategy: "Use accepted Gatekeeper and stale-evidence fixtures to teach safe refusals, proof modes, and support escalation before approval.",
      expectedOutputs: [
        "policy.Decided-style fixture link",
        "proof-mode labeled refusal or approval",
        "redacted support handoff packet",
      ],
      failureBranch: "If evidence is missing, tutorial stops at denial and records owner route rather than adding waiver or policy bypass behavior.",
      proofModeLabels: allProofModes,
      quickstartFixtureIds: [
        "rlq-plan-safe-preview-v1",
        "rlq-deploy-run-accepted-v1",
        "rlq-inspect-event-projection-v1",
        "rlq-manage-stale-evidence-v1",
        "rlq-recover-scope-out-v1",
      ],
      accessibilityNotes: [
        "Security warnings are text-first and do not rely on color or icon-only denial states.",
        "Screen reader and non-visual summaries include denied capability, proof mode, and required owner.",
      ],
      supportHandoff: "Route policy-denied tutorial states to SecOps owner with redacted evidence and no credentials.",
    },
    {
      role: "DevOps",
      walkthroughAnchor: "docs/design/walkthrough.md#part-5--devops-run-the-control-plane-and-the-ci-fabric",
      personaGoal: "Outline self-host bootstrap, runner health, import preview, and restore evidence while keeping control-plane implementation out of scope.",
      prerequisites: [
        "seed Yard and runner examples are represented as fixtures only",
        "brownfield migration preview fixture is accepted before any adoption claims",
      ],
      commandPath: [
        "hobo up ./platform --seed --mode simulated --json",
        "hobo import terraform ./infra --fixture rlq-migrate-brownfield-preview-v1 --dry-run --json",
        "hobo inspect topology --camp prod --fixture rlq-inspect-event-projection-v1",
        "hobo logs --follow runner --fixture rlq-manage-stale-evidence-v1",
      ],
      mcpTools: ["hobo_seed_platform", "hobo_import_terraform", "hobo_inspect_topology", "hobo_tail_runner_logs"],
      fixtureStrategy: "Frame self-host, import, and restore tutorial steps as reference fixtures so no hosted control-plane or live runner is created.",
      expectedOutputs: [
        "seed run reference fixture",
        "migration preview event list",
        "runner health support handoff",
      ],
      failureBranch: "If runner or import evidence is stale, the tutorial routes to support/debug ownership before any live bootstrap claim.",
      proofModeLabels: allProofModes,
      quickstartFixtureIds: [
        "rlq-plan-safe-preview-v1",
        "rlq-inspect-event-projection-v1",
        "rlq-manage-stale-evidence-v1",
        "rlq-migrate-brownfield-preview-v1",
        "rlq-recover-snapshot-restore-v1",
        "rlq-recover-scope-out-v1",
      ],
      accessibilityNotes: [
        "Long command transcripts include copyable commands and stable headings for keyboard navigation.",
        "Non-visual readers get plain-language runner state, proof mode, and owner handoff in each expected output.",
      ],
      supportHandoff: "Route bootstrap, runner, or import failures to DevOps/support-debug owner with fixture evidence only.",
    },
    {
      role: "SRE",
      walkthroughAnchor: "docs/design/walkthrough.md#part-6--sre-slos-runbooks-and-an-ai-on-call-thats-governed",
      personaGoal: "Teach incident inspection, logs, stale projections, rollback preview, and support-safe escalation from replayable evidence.",
      prerequisites: [
        "incident and projection examples are reference fixtures",
        "rollback remains a dry-run or scope-out boundary until release gates exist",
      ],
      commandPath: [
        "hobo inspect run --last --camp prod --fixture rlq-deploy-run-accepted-v1",
        "hobo logs --follow api --fixture rlq-manage-stale-evidence-v1",
        "hobo doctor --fixture rlq-inspect-event-projection-v1 --focus stale-projection",
        "hobo up --camp prod --rollback deployment-set:previous --fixture rlq-recover-snapshot-restore-v1 --dry-run",
      ],
      mcpTools: ["hobo_inspect_incident", "hobo_tail_logs", "hobo_doctor", "hobo_rollback"],
      fixtureStrategy: "Pin SRE tutorial steps to stale projection and recovery scope-out fixtures so the outline proves diagnosis workflow, not live remediation.",
      expectedOutputs: [
        "incident-style timeline fixture",
        "redacted log excerpt",
        "rollback dry-run limitation",
        "support escalation owner",
      ],
      failureBranch: "If the incident cannot be classified from fixtures, escalate to human owner and do not claim autonomous remediation.",
      proofModeLabels: allProofModes,
      quickstartFixtureIds: [
        "rlq-plan-safe-preview-v1",
        "rlq-deploy-run-accepted-v1",
        "rlq-inspect-event-projection-v1",
        "rlq-manage-stale-evidence-v1",
        "rlq-recover-snapshot-restore-v1",
        "rlq-recover-scope-out-v1",
      ],
      accessibilityNotes: [
        "Timeline output is ordered text with timestamps, status labels, and keyboard-copyable evidence ids.",
        "Screen reader and non-visual summaries include severity, proof mode, and next owner rather than color-only status.",
      ],
      supportHandoff: "Route unclassified or stale incident tutorial states to SRE/support owner with redacted logs and fixture ids.",
    },
  ],
  scopeOut: standardScopeOut,
};

const COMMAND_PATTERN =
  /^(hobo (new|collect|plan|up|inspect|logs|doctor|import terraform)\b|git push\b)/;

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(final tutorial content|write final tutorial|final docs tutorial)\b/i,
  /\b(live provider execution|real credentials|provider credentials|aws key|azure credential|gcp credential|secret)\b/i,
  /\b(hosted docs implementation|docs portal implementation|production docs portal)\b/i,
  /\b(production recordings|demo video|public recording)\b/i,
  /\b(customer data|tenant data|customer payload)\b/i,
  /\b(launch claim|launch claims|production readiness).*\b(without evidence|unbacked)\b/i,
];

export type RoleTutorialRequestClassification = "in-scope-proof" | "scope-out";

export class VibeRoleTutorialOutlinesParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Vibe role tutorial outlines failed parsing: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "VibeRoleTutorialOutlinesParseError";
  }
}

export function parseVibeRoleTutorialOutlines(
  outlines: VibeRoleTutorialOutlines,
): ParsedVibeRoleTutorialOutlines {
  const validation = validateVibeRoleTutorialOutlines(outlines);

  if (!validation.ok) {
    throw new VibeRoleTutorialOutlinesParseError(validation.errors);
  }

  // SAFETY: `return outlines as ParsedVibeRoleTutorialOutlines;` is required at this I/O or test boundary.
  return outlines as ParsedVibeRoleTutorialOutlines;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibeRoleTutorialOutlines(
  outlines: VibeRoleTutorialOutlines,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (outlines.issue !== "HOBO-552") {
    errors.push({ code: "wrong-issue", message: "tutorial outline proof must pin HOBO-552" });
  }
  if (outlines.phase !== "M1") {
    errors.push({ code: "wrong-phase", message: "tutorial outline proof must stay in M1" });
  }
  if (outlines.packagePath !== "src/draft/exp-proofs/ux/vibe-role-tutorial-outlines") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (outlines.proofPath !== "docs/design/proofs/vibe-role-tutorial-outlines/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }
  if (!arraysEqual(outlines.roles, REQUIRED_TUTORIAL_ROLES)) {
    errors.push({ code: "missing-role", message: "top-level role list must match required six-role order" });
  }
  if (!arraysEqual(outlines.coveragePaths.map((path) => path.id), REQUIRED_ROLE_TUTORIAL_COVERAGE)) {
    errors.push({ code: "missing-coverage-path", message: "coverage paths must include happy, blocked, stale, and support paths" });
  }

  validateQuickstartRefs(outlines.quickstartFixtureRefs, errors);
  validateOutlines(outlines.outlines, errors);
  validateScopeOut(outlines.scopeOut, errors);

  return { ok: errors.length === 0, errors };
}

export function classifyRoleTutorialRequest(
  request: string,
): RoleTutorialRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(request))
    ? "scope-out"
    : "in-scope-proof";
}

function validateOutlines(
  outlines: readonly RoleTutorialOutline[],
  errors: ValidationError[],
): void {
  if (!arraysEqual(outlines.map((outline) => outline.role), REQUIRED_TUTORIAL_ROLES)) {
    errors.push({ code: "missing-role", message: "outlines must cover each required role once" });
  }

  const proofModes = new Set<TutorialProofMode>();
  for (const outline of outlines) {
    if (!outline.walkthroughAnchor.startsWith("docs/design/walkthrough.md#")) {
      errors.push({ code: "missing-walkthrough-anchor", message: `${outline.role} must cite walkthrough.md` });
    }
    validateString(outline.personaGoal, `${outline.role}.personaGoal`, errors);
    validateNonEmptyArray(outline.prerequisites, `${outline.role}.prerequisites`, errors);
    validateNonEmptyArray(outline.commandPath, `${outline.role}.commandPath`, errors);
    validateNonEmptyArray(outline.mcpTools, `${outline.role}.mcpTools`, errors);
    validateString(outline.fixtureStrategy, `${outline.role}.fixtureStrategy`, errors);
    validateNonEmptyArray(outline.expectedOutputs, `${outline.role}.expectedOutputs`, errors);
    validateString(outline.failureBranch, `${outline.role}.failureBranch`, errors);
    validateNonEmptyArray(outline.accessibilityNotes, `${outline.role}.accessibilityNotes`, errors);
    validateString(outline.supportHandoff, `${outline.role}.supportHandoff`, errors);

    for (const command of outline.commandPath) {
      if (!COMMAND_PATTERN.test(command)) {
        errors.push({ code: "non-canonical-command", message: `${outline.role} command invents a lifecycle verb: ${command}` });
      }
    }
    for (const proofMode of outline.proofModeLabels) {
      if (!REQUIRED_ROLE_TUTORIAL_PROOF_MODES.includes(proofMode)) {
        errors.push({ code: "unsupported-proof-mode", message: `${outline.role} uses unsupported proof mode ${String(proofMode)}` });
      } else {
        proofModes.add(proofMode);
      }
    }
    for (const fixtureId of outline.quickstartFixtureIds) {
      if (!REQUIRED_ROLE_TUTORIAL_QUICKSTART_FIXTURE_IDS.includes(fixtureId)) {
        errors.push({ code: "unknown-quickstart-fixture", message: `${outline.role} references unknown quickstart fixture ${String(fixtureId)}` });
      }
    }
  }

  for (const proofMode of REQUIRED_ROLE_TUTORIAL_PROOF_MODES) {
    if (!proofModes.has(proofMode)) {
      errors.push({ code: "missing-proof-mode", message: `missing proof mode ${proofMode}` });
    }
  }
}

function validateQuickstartRefs(
  refs: readonly TutorialQuickstartFixtureRef[],
  errors: ValidationError[],
): void {
  if (!arraysEqual(refs.map((ref) => ref.fixtureId), REQUIRED_ROLE_TUTORIAL_QUICKSTART_FIXTURE_IDS)) {
    errors.push({ code: "missing-quickstart-fixture", message: "tutorial outlines must cite required HOBO-577 fixture ids" });
  }

  for (const ref of refs) {
    if (ref.sourceIssue !== "HOBO-577") {
      errors.push({ code: "wrong-quickstart-source", message: `${ref.fixtureId} must cite HOBO-577` });
    }
    if (!QUICKSTART_PROOF_MODES.includes(ref.proofMode)) {
      errors.push({ code: "unknown-quickstart-proof-mode", message: `${ref.fixtureId} uses unsupported quickstart proof mode` });
    }
    validateString(ref.tutorialUse, `${ref.fixtureId}.tutorialUse`, errors);
  }
}

function validateScopeOut(scopeOut: readonly string[], errors: ValidationError[]): void {
  for (const expected of standardScopeOut) {
    if (!scopeOut.includes(expected)) {
      errors.push({ code: "missing-scope-out", message: `scope out missing ${expected}` });
    }
  }
}

function validateString(value: string, name: string, errors: ValidationError[]): void {
  if (!isJsonString(value) || value.trim().length === 0) {
    errors.push({ code: "missing-field", message: `${name} must not be empty` });
  }
}

function validateNonEmptyArray(
  value: readonly string[],
  name: string,
  errors: ValidationError[],
): void {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => !isJsonString(entry) || entry.trim().length === 0)) {
    errors.push({ code: "missing-field", message: `${name} must contain strings` });
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
