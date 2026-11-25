import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const REQUIRED_DECISION_TREE_CASES = [
  "happy-reference-check",
  "install-failure",
  "missing-auth-svid",
  "blocked-plan",
  "deploy-failure",
  "policy-denial",
  "stale-evidence",
  "unsupported-request",
  "support-handoff",
] as const;

export const REQUIRED_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

type DecisionTreeCaseId = (typeof REQUIRED_DECISION_TREE_CASES)[number];
type ProofMode = (typeof REQUIRED_PROOF_MODES)[number];
type PathState = "happy" | "blocked" | "stale-or-unknown" | "support-handoff";

// domain-view: parse-produced draft-proof record; its wire form is the RedactionEvidence proto message in data-models/.
type RedactionEvidence = {
  readonly redacted: true;
  readonly visibleFields: readonly string[];
  readonly withheldFields: readonly string[];
};

// domain-view: parse-produced draft-proof record; its wire form is the TroubleshootingDecisionCase proto message in data-models/.
export type TroubleshootingDecisionCase = {
  readonly caseId: DecisionTreeCaseId;
  readonly pathState: PathState;
  readonly symptom: string;
  readonly diagnosticEvidence: readonly string[];
  readonly owner: string;
  readonly safeNextAction: string;
  readonly customerSafeWording: string;
  readonly escalationRoute: string;
  readonly proofMode: ProofMode;
  readonly quickstartFixtureRefs: readonly string[];
  readonly accessibilityNotes: readonly string[];
  readonly redaction: RedactionEvidence;
};

// domain-view: parse-produced draft-proof record; its wire form is the VibeTroubleshootingDecisionTrees proto message in data-models/.
type VibeTroubleshootingDecisionTrees = {
  readonly issue: "HOBO-553";
  readonly phase: "M1";
  readonly targetPackage: "src/draft/exp-proofs/ux/vibe-troubleshooting-decision-trees";
  readonly proofNote: "docs/design/proofs/vibe-troubleshooting-decision-trees/README.md";
  readonly designRefs: readonly string[];
  readonly proofModes: readonly ProofMode[];
  readonly cases: readonly TroubleshootingDecisionCase[];
  readonly scopeOut: readonly string[];
};

export type ParsedVibeTroubleshootingDecisionTrees = VibeTroubleshootingDecisionTrees & {
  readonly __brand: "ParsedVibeTroubleshootingDecisionTrees";
};

export const VIBE_TROUBLESHOOTING_DECISION_TREES: VibeTroubleshootingDecisionTrees = {
  issue: "HOBO-553",
  phase: "M1",
  targetPackage: "src/draft/exp-proofs/ux/vibe-troubleshooting-decision-trees",
  proofNote: "docs/design/proofs/vibe-troubleshooting-decision-trees/README.md",
  designRefs: [
    "docs/design/troubleshooting-guides.md",
    "docs/design/proofs/hobo-437-troubleshooting-guides-scope/index.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/launch-support-escalation.md",
    "docs/design/support-sla-channels.md",
    "docs/design/known-limitations-register.md",
  ],
  proofModes: REQUIRED_PROOF_MODES,
  cases: [
    {
      caseId: "happy-reference-check",
      pathState: "happy",
      symptom: "Reference quickstart health check completes and evidence is current.",
      diagnosticEvidence: [
        "hobo doctor quickstart --fixture rlq-inspect-event-projection-v1",
        "fixture:rlq-deploy-run-accepted-v1",
      ],
      owner: "Docs maintainer",
      safeNextAction:
        "Keep the accepted quickstart fixture id with the guide and avoid broadening the claim beyond the recorded proof mode.",
      customerSafeWording:
        "The quickstart fixture is current and no escalation is needed from this guide entry.",
      escalationRoute: "No escalation; revisit if freshness or proof-mode evidence changes.",
      proofMode: "reference fixture",
      quickstartFixtureRefs: [
        "rlq-deploy-run-accepted-v1",
        "rlq-inspect-event-projection-v1",
      ],
      accessibilityNotes: [
        "Healthy status is stated in text and does not depend on green color alone.",
      ],
      redaction: redaction(["fixture id", "projection freshness", "owner"], [
        "tenant id",
        "raw logs",
        "provider account",
      ]),
    },
    {
      caseId: "install-failure",
      pathState: "blocked",
      symptom: "Local install or bootstrap preflight fails before the first project exists.",
      diagnosticEvidence: [
        "hobo doctor install --fixture tg-install-preflight-failed-v1",
        "preflight.missing-supported-runtime",
      ],
      owner: "Platform Engineering",
      safeNextAction:
        "Run the supported bootstrap preflight again after environment repair; do not install tools from the guide automatically.",
      customerSafeWording:
        "Your local environment is missing a supported prerequisite. Keep the preflight output and follow the supported setup path.",
      escalationRoute: "Support Workflow when the supported preflight remains blocked.",
      proofMode: "reference fixture",
      quickstartFixtureRefs: ["rlq-define-object-graph-v1"],
      accessibilityNotes: [
        "The missing prerequisite and safe retry are named before any command block.",
      ],
      redaction: redaction(["runtime name", "preflight code", "operating system"], [
        "home directory",
        "machine username",
        "local secret paths",
      ]),
    },
    {
      caseId: "missing-auth-svid",
      pathState: "blocked",
      symptom: "CLI or MCP command cannot find a valid workload SVID or agent principal.",
      diagnosticEvidence: [
        "hobo doctor auth --fixture tg-auth-svid-missing-v1",
        "identity.svid.missing",
      ],
      owner: "Identity / Security",
      safeNextAction:
        "Refresh the fixture principal or route to identity support; never paste tokens or private key material into the guide.",
      customerSafeWording:
        "Authentication evidence is missing or expired. The next step is identity handoff, not credential sharing.",
      escalationRoute: "Identity support with redacted principal fingerprint and correlation id.",
      proofMode: "simulated",
      quickstartFixtureRefs: ["rlq-collect-manifest-ir-v1"],
      accessibilityNotes: [
        "The blocked auth state is textual and includes the correlation id location.",
      ],
      redaction: redaction(["principal fingerprint", "correlation id", "auth reason"], [
        "bearer token",
        "private key",
        "raw SVID",
      ]),
    },
    {
      caseId: "blocked-plan",
      pathState: "blocked",
      symptom: "Plan preview is blocked by capacity, compatibility, or missing approval evidence.",
      diagnosticEvidence: [
        "hobo plan --fixture rlq-plan-safe-preview-v1 --json",
        "gatekeeper.plan.blocked",
      ],
      owner: "Plan/Diff Reviewer",
      safeNextAction:
        "Keep the Gatekeeper reason, required approval, and cost/capacity evidence together before asking for review.",
      customerSafeWording:
        "The plan is blocked pending review evidence. No deployment has been attempted.",
      escalationRoute: "Plan/Diff review owner with Gatekeeper reason and proof-mode label.",
      proofMode: "reference fixture",
      quickstartFixtureRefs: ["rlq-plan-safe-preview-v1"],
      accessibilityNotes: [
        "Blocked reason, reviewer, and next action are written as separate lines.",
      ],
      redaction: redaction(["gate code", "approval route", "cost band"], [
        "provider quote detail",
        "account id",
        "customer budget notes",
      ]),
    },
    {
      caseId: "deploy-failure",
      pathState: "blocked",
      symptom: "Deploy run fails after acceptance begins and needs owner routing.",
      diagnosticEvidence: [
        "hobo up --fixture tg-deploy-run-failed-v1 --json",
        "resource.actor.failed",
      ],
      owner: "Control Plane / Operators",
      safeNextAction:
        "Collect the deployment-set id, failed resource, and correlation id; do not perform live repair from the guide.",
      customerSafeWording:
        "The deploy reference failed and needs operator review with a redacted evidence pack.",
      escalationRoute: "Operators/SRE with deployment-set id and redacted failure envelope.",
      proofMode: "reference fixture",
      quickstartFixtureRefs: ["rlq-deploy-run-accepted-v1"],
      accessibilityNotes: [
        "Failure state, owner, and no-live-repair boundary are visible in plain text.",
      ],
      redaction: redaction(["deployment-set id", "resource alias", "correlation id"], [
        "provider credential",
        "raw provider log",
        "customer payload",
      ]),
    },
    {
      caseId: "policy-denial",
      pathState: "blocked",
      symptom: "Policy denies the requested action or capability.",
      diagnosticEvidence: [
        "hobo doctor policy --fixture tg-policy-denial-v1",
        "policy.denied",
      ],
      owner: "Policy / Security",
      safeNextAction:
        "Show the denied action, policy id, and required approval path; do not describe bypass instructions.",
      customerSafeWording:
        "A policy rule blocked the action. The safe path is approval or a scoped change request.",
      escalationRoute: "Security review with policy id, decision id, and redacted subject.",
      proofMode: "simulated",
      quickstartFixtureRefs: ["rlq-plan-safe-preview-v1"],
      accessibilityNotes: [
        "Denied state does not rely on red color and includes approval route text.",
      ],
      redaction: redaction(["policy id", "decision id", "action"], [
        "subject token",
        "tenant policy internals",
        "private exception notes",
      ]),
    },
    {
      caseId: "stale-evidence",
      pathState: "stale-or-unknown",
      symptom: "Troubleshooting evidence is stale, unknown, or not backed by an accepted fixture.",
      diagnosticEvidence: [
        "hobo inspect evidence --fixture rlq-manage-stale-evidence-v1",
        "evidence.freshness.unknown",
      ],
      owner: "Docs / Support",
      safeNextAction:
        "Mark the answer stale, collect current fixture evidence, and stop before making readiness claims.",
      customerSafeWording:
        "The evidence is not current enough to use as a readiness signal.",
      escalationRoute: "Docs maintainer for fixture refresh; Support if a customer workflow is blocked.",
      proofMode: "reference fixture",
      quickstartFixtureRefs: ["rlq-manage-stale-evidence-v1"],
      accessibilityNotes: [
        "Staleness duration and stop condition are present in text.",
      ],
      redaction: redaction(["freshness window", "fixture id", "owner"], [
        "customer run log",
        "raw telemetry",
        "tenant identifier",
      ]),
    },
    {
      caseId: "unsupported-request",
      pathState: "blocked",
      symptom: "Requested troubleshooting action is outside v1 support or launch claims.",
      diagnosticEvidence: [
        "hobo doctor request --fixture rlq-recover-scope-out-v1",
        "scope.out.unsupported",
      ],
      owner: "Known Limitations / Cutline",
      safeNextAction:
        "Route to known limitations and do not describe unsupported behavior as available.",
      customerSafeWording:
        "That request is outside the current supported path. The guide can record the limitation and follow-up owner.",
      escalationRoute: "Cutline owner for accepted-risk or follow-up routing.",
      proofMode: "scope-out",
      quickstartFixtureRefs: ["rlq-recover-scope-out-v1"],
      accessibilityNotes: [
        "Unsupported state is explicit and includes the follow-up owner.",
      ],
      redaction: redaction(["limitation id", "follow-up owner", "safe alternative"], [
        "customer promise",
        "private roadmap date",
        "account-specific workaround",
      ]),
    },
    {
      caseId: "support-handoff",
      pathState: "support-handoff",
      symptom: "User has a blocked workflow and a support-safe evidence pack is ready.",
      diagnosticEvidence: [
        "hobo doctor --support-bundle --fixture tg-support-handoff-v1",
        "support.handoff.ready",
      ],
      owner: "Support Workflow",
      safeNextAction:
        "Attach only support-safe fields and preserve the owner route, severity, and safe next action.",
      customerSafeWording:
        "A redacted support handoff is ready. It includes the owner route and excludes private payloads.",
      escalationRoute: "Support operator with severity, owner route, and redaction evidence.",
      proofMode: "reference fixture",
      quickstartFixtureRefs: [
        "rlq-inspect-event-projection-v1",
        "rlq-manage-stale-evidence-v1",
      ],
      accessibilityNotes: [
        "Severity and owner route are text-first and available outside color or icon state.",
      ],
      redaction: redaction(["severity", "owner route", "correlation id"], [
        "raw diagnostic payload",
        "customer data",
        "provider credential",
      ]),
    },
  ],
  scopeOut: [
    "No diagnostic automation.",
    "No support queue or ticket routing implementation.",
    "No live repair workflow.",
    "No production docs portal publication.",
    "No customer data or unredacted logs.",
    "No launch claims without accepted evidence.",
  ],
};

export function parseVibeTroubleshootingDecisionTrees(
  value: JsonValue,
): ParsedVibeTroubleshootingDecisionTrees {
  assertRecord(value, "proof");
  assertLiteral(value.issue, "HOBO-553", "issue");
  assertLiteral(value.phase, "M1", "phase");
  assertLiteral(
    value.targetPackage,
    "src/draft/exp-proofs/ux/vibe-troubleshooting-decision-trees",
    "targetPackage",
  );
  assertLiteral(
    value.proofNote,
    "docs/design/proofs/vibe-troubleshooting-decision-trees/README.md",
    "proofNote",
  );

  const designRefs = assertStringArray(value.designRefs, "designRefs");
  const proofModes = assertProofModes(value.proofModes);
  const cases = assertDecisionCases(value.cases);
  const scopeOut = assertStringArray(value.scopeOut, "scopeOut");

  if (!arraysEqual(cases.map((entry) => entry.caseId), REQUIRED_DECISION_TREE_CASES)) {
    throw new TypeError("cases must cover required decision tree cases in order");
  }

  for (const entry of cases) {
    if (!entry.redaction.redacted || entry.redaction.withheldFields.length === 0) {
      throw new TypeError(`${entry.caseId} must carry redaction evidence`);
    }
    if (entry.customerSafeWording.match(/\b(secret|token|private key|customer data)\b/i)) {
      throw new TypeError(`${entry.caseId} customer wording leaks sensitive concepts`);
    }
  }

  return {
    issue: "HOBO-553",
    phase: "M1",
    targetPackage: "src/draft/exp-proofs/ux/vibe-troubleshooting-decision-trees",
    proofNote: "docs/design/proofs/vibe-troubleshooting-decision-trees/README.md",
    designRefs,
    proofModes,
    cases,
    scopeOut,
    __brand: "ParsedVibeTroubleshootingDecisionTrees",
  };
}

export function renderCustomerSafeGuideEntry(entry: TroubleshootingDecisionCase): string {
  return [
    `Symptom: ${entry.symptom}`,
    `Owner: ${entry.owner}`,
    `Safe next action: ${entry.safeNextAction}`,
    `Customer wording: ${entry.customerSafeWording}`,
    `Escalation: ${entry.escalationRoute}`,
    `proof mode: ${entry.proofMode}`,
  ].join("\n");
}

export function renderSupportHandoff(entry: TroubleshootingDecisionCase) {
  return {
    caseId: entry.caseId,
    owner: entry.owner,
    safeNextAction: entry.safeNextAction,
    escalationRoute: entry.escalationRoute,
    redaction: entry.redaction,
    visibleFields: entry.redaction.visibleFields,
  } as const;
}

export function classifyTroubleshootingScope(input: string) {
  const normalized = input.toLowerCase();
  if (/\bdiagnostic automation\b|\bautomate diagnostics?\b/.test(normalized)) {
    return { allowed: false, reason: "diagnostic-automation" } as const;
  }
  if (/\bsupport ticket queue\b|\bqueue routing\b|\bticket routing\b/.test(normalized)) {
    return { allowed: false, reason: "support-queue" } as const;
  }
  if (/\blive provider\b|\blive repair\b|\brepair live\b/.test(normalized)) {
    return { allowed: false, reason: "live-repair" } as const;
  }
  if (/\bcustomer data\b|\bunredacted logs?\b|\bprovider credentials?\b/.test(normalized)) {
    return { allowed: false, reason: "customer-data" } as const;
  }
  if (/\blaunch claims?\b|\bunsupported claims?\b|\bclaim without evidence\b/.test(normalized)) {
    return { allowed: false, reason: "unsupported-launch-claim" } as const;
  }
  return { allowed: true, reason: "reference-fixture" } as const;
}

function redaction(
  visibleFields: readonly string[],
  withheldFields: readonly string[],
): RedactionEvidence {
  return {
    redacted: true,
    visibleFields,
    withheldFields,
  };
}

function assertDecisionCases(value: JsonValue): readonly TroubleshootingDecisionCase[] {
  if (!Array.isArray(value)) {
    throw new TypeError("cases must be an array");
  }
  return value.map((item, index) => assertDecisionCase(item, `cases[${index}]`));
}

function assertDecisionCase(value: JsonValue, label: string): TroubleshootingDecisionCase {
  assertRecord(value, label);
  assertRecord(value.redaction, `${label}.redaction`);
  return {
    caseId: assertOneOf(value.caseId, REQUIRED_DECISION_TREE_CASES, `${label}.caseId`),
    pathState: assertOneOf(
      value.pathState,
      ["happy", "blocked", "stale-or-unknown", "support-handoff"] as const,
      `${label}.pathState`,
    ),
    symptom: assertString(value.symptom, `${label}.symptom`),
    diagnosticEvidence: assertStringArray(
      value.diagnosticEvidence,
      `${label}.diagnosticEvidence`,
    ),
    owner: assertString(value.owner, `${label}.owner`),
    safeNextAction: assertString(value.safeNextAction, `${label}.safeNextAction`),
    customerSafeWording: assertString(
      value.customerSafeWording,
      `${label}.customerSafeWording`,
    ),
    escalationRoute: assertString(value.escalationRoute, `${label}.escalationRoute`),
    proofMode: assertOneOf(value.proofMode, REQUIRED_PROOF_MODES, `${label}.proofMode`),
    quickstartFixtureRefs: assertStringArray(
      value.quickstartFixtureRefs,
      `${label}.quickstartFixtureRefs`,
    ),
    accessibilityNotes: assertStringArray(
      value.accessibilityNotes,
      `${label}.accessibilityNotes`,
    ),
    redaction: {
      redacted: assertLiteral(value.redaction.redacted, true, `${label}.redaction.redacted`),
      visibleFields: assertStringArray(
        value.redaction.visibleFields,
        `${label}.redaction.visibleFields`,
      ),
      withheldFields: assertStringArray(
        value.redaction.withheldFields,
        `${label}.redaction.withheldFields`,
      ),
    },
  };
}

function assertProofModes(value: JsonValue): readonly ProofMode[] {
  if (!Array.isArray(value)) {
    throw new TypeError("proofModes must be an array");
  }
  const modes = value.map((item, index) =>
    assertOneOf(item, REQUIRED_PROOF_MODES, `proofModes[${index}]`),
  );
  if (!arraysEqual(modes, REQUIRED_PROOF_MODES)) {
    throw new TypeError("proofModes must list every required proof mode in order");
  }
  return modes;
}

function assertString(value: JsonValue, field: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertStringArray(value: JsonValue, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty array`);
  }
  return value.map((item, index) => assertString(item, `${field}[${index}]`));
}

function assertRecord(value: JsonValue, field: string): asserts value is JsonObject {
  if (!isJsonObject(value) || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertLiteral<const T extends string | boolean>(
  value: JsonValue,
  expected: T,
  field: string,
): T {
  if (value !== expected) {
    throw new TypeError(`${field} must be ${String(expected)}`);
  }
  return expected;
}

function assertOneOf<const T extends readonly string[]>(
  value: JsonValue,
  allowed: T,
  field: string,
): T[number] {
  if (!isJsonString(value) || !allowed.includes(value)) {
    throw new TypeError(`${field} must be one of ${allowed.join(", ")}`);
  }
  // SAFETY: `return value as T[number];` is required at this I/O or test boundary.
  return value as T[number];
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
