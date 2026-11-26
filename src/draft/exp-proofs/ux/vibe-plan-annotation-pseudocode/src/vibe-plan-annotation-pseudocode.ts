import { isJsonObject, type JsonValue } from "./json.js";
export const REQUIRED_ANNOTATION_CASES = [
  "policy denial",
  "widened permission",
  "cost estimate",
  "capacity warning",
  "stale SLO signal",
  "missing approval",
] as const;

export const REQUIRED_PSEUDOCODE_FIELDS = [
  "annotation input",
  "display grouping",
  "severity",
  "proof mode",
  "missing evidence",
  "support owner routing",
] as const;

export type AnnotationCase = (typeof REQUIRED_ANNOTATION_CASES)[number];
export type AnnotationDisplayGroup = "policy" | "cost" | "capacity" | "approval" | "readiness";
export type AnnotationSeverity = "info" | "warning" | "blocked" | "critical";
export type ProofMode = "reference fixture" | "simulated" | "scope-out" | "live";
export type EvidenceState = "happy" | "blocked" | "stale/unknown";

// domain-view: parse-produced draft-proof record; its wire form is the PlanAnnotationFixture proto message in data-models/.
export type PlanAnnotationFixture = {
  case: AnnotationCase;
  annotationInput: string;
  displayGroup: AnnotationDisplayGroup;
  severity: AnnotationSeverity;
  proofMode: ProofMode;
  evidenceState: EvidenceState;
  missingEvidenceBehavior: "not applicable" | "show as unavailable" | "show as stale/unknown" | "show as success";
  supportOwnerRoute: string;
  supportSafeWording: string;
  accessibilityNote: string;
  fixtureId: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the PlanAnnotationContractFixtures proto message in data-models/.
export type PlanAnnotationContractFixtures = {
  protobuf: "architecture/vibe_plan_annotation_pseudocode.proto";
  cue: "architecture/vibe_plan_annotation_pseudocode.cue";
  pact: "architecture/pacts/vibe_plan_annotation_pseudocode.pact.json";
};

export type PlanAnnotationPseudocode = {
  schema: "hobo.vibe-plan-annotation-pseudocode/v1";
  issue: "HOBO-543";
  phase: "M1";
  targetPackagePath: "src/draft/exp-proofs/ux/vibe-plan-annotation-pseudocode";
  proofNotePath: "docs/design/proofs/vibe-plan-annotation-pseudocode/README.md";
  designRefs: string[];
  annotations: PlanAnnotationFixture[];
  contractFixtures: PlanAnnotationContractFixtures;
  scopeOut: string[];
  __brand: "ParsedPlanAnnotationPseudocode";
};

type UnparsedPlanAnnotationPseudocode = Omit<PlanAnnotationPseudocode, "__brand">;

export const VIBE_PLAN_ANNOTATION_PSEUDOCODE = {
  schema: "hobo.vibe-plan-annotation-pseudocode/v1",
  issue: "HOBO-543",
  phase: "M1",
  targetPackagePath: "src/draft/exp-proofs/ux/vibe-plan-annotation-pseudocode",
  proofNotePath: "docs/design/proofs/vibe-plan-annotation-pseudocode/README.md",
  designRefs: [
    "docs/design/plan-diff-viewer.md",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/control-plane.md#plan-04",
    "docs/design/contracts-policy-flags.md#plan-29",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/cli-spec.md",
    "docs/design/adr/02-identity-security.md#adr-0015",
    "docs/design/adr/01-architecture-core.md#adr-0033",
    "docs/design/adr/02-identity-security.md#adr-0045",
  ],
  annotations: [
    {
      case: "policy denial",
      annotationInput: "GatekeeperDecision.deny(policy.pack:network.egress)",
      displayGroup: "policy",
      severity: "blocked",
      proofMode: "reference fixture",
      evidenceState: "blocked",
      missingEvidenceBehavior: "not applicable",
      supportOwnerRoute: "security-reviewer",
      supportSafeWording:
        "Blocked by policy before provider work. Support can cite the Gatekeeper decision without exposing policy internals.",
      accessibilityNote:
        "Terminal output uses the word blocked, a stable heading, and a remediation line rather than color alone.",
      fixtureId: "fixture.plan.annotation.policy-denial",
    },
    {
      case: "widened permission",
      annotationInput: "PermissionDelta widens storage.write from preview to prod",
      displayGroup: "policy",
      severity: "critical",
      proofMode: "reference fixture",
      evidenceState: "blocked",
      missingEvidenceBehavior: "not applicable",
      supportOwnerRoute: "platform-security-owner",
      supportSafeWording:
        "Permission widening needs an explicit approver route; customer-safe wording names the capability class only.",
      accessibilityNote:
        "Screen-reader order names the widened capability before the approval route and does not rely on icon-only emphasis.",
      fixtureId: "fixture.plan.annotation.widened-permission",
    },
    {
      case: "cost estimate",
      annotationInput: "CostEstimate monthlyUsd=42.10 source=reference-fixture",
      displayGroup: "cost",
      severity: "info",
      proofMode: "simulated",
      evidenceState: "happy",
      missingEvidenceBehavior: "show as unavailable",
      supportOwnerRoute: "finops-owner",
      supportSafeWording:
        "Cost is simulated from reference fixtures; support must not present it as billed or provider-quoted spend.",
      accessibilityNote:
        "Plain-text output labels this as simulated and keeps currency, source, and owner on separate lines.",
      fixtureId: "fixture.plan.annotation.cost-estimate",
    },
    {
      case: "capacity warning",
      annotationInput: "CapacitySignal limited-region-capacity for gpu.small in us-east",
      displayGroup: "capacity",
      severity: "warning",
      proofMode: "simulated",
      evidenceState: "blocked",
      missingEvidenceBehavior: "show as unavailable",
      supportOwnerRoute: "platform-capacity-owner",
      supportSafeWording:
        "Support-safe capacity wording routes to the platform-capacity owner and states that no live provider reservation is implied.",
      accessibilityNote:
        "Warning text is present without color dependency and includes the blocked region and next action.",
      fixtureId: "fixture.plan.annotation.capacity-warning",
    },
    {
      case: "stale SLO signal",
      annotationInput: "SloSignal checkout-latency p95 older than freshness bound",
      displayGroup: "readiness",
      severity: "warning",
      proofMode: "reference fixture",
      evidenceState: "stale/unknown",
      missingEvidenceBehavior: "show as stale/unknown",
      supportOwnerRoute: "sre-owner",
      supportSafeWording:
        "Support-safe SLO wording routes to the SRE owner and asks for refreshed evidence before readiness claims.",
      accessibilityNote:
        "Terminal output says stale or unknown evidence in text and places the refresh request before any success language.",
      fixtureId: "fixture.plan.annotation.stale-slo-signal",
    },
    {
      case: "missing approval",
      annotationInput: "ApprovalRef required but absent for destructive diff",
      displayGroup: "approval",
      severity: "blocked",
      proofMode: "scope-out",
      evidenceState: "blocked",
      missingEvidenceBehavior: "show as unavailable",
      supportOwnerRoute: "approval-owner",
      supportSafeWording:
        "Approval runtime is out of scope; the annotation names the missing approval and safe owner route only.",
      accessibilityNote:
        "Terminal-friendly wording uses a blocked heading, missing approval label, and owner route in stable order.",
      fixtureId: "fixture.plan.annotation.missing-approval",
    },
  ],
  contractFixtures: {
    protobuf: "architecture/vibe_plan_annotation_pseudocode.proto",
    cue: "architecture/vibe_plan_annotation_pseudocode.cue",
    pact: "architecture/pacts/vibe_plan_annotation_pseudocode.pact.json",
  },
  scopeOut: [
    "No policy engine, approval runtime, billing, quota enforcement, or provider cost API is implemented.",
    "No live provider calls, cloud credentials, customer data, production UI, or launch claims are introduced.",
    "No annotation may present stale, missing, or simulated evidence as live success.",
  ],
} satisfies UnparsedPlanAnnotationPseudocode;

export type ScopeCreepDenial = {
  decision: "reject";
  reason: string;
  request: string;
};

export type PlanAnnotationRequestClassification = "in-scope-proof" | "scope-out";

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(production policy|policy engine|approval runtime|quota enforcement|billing engine|billing service)\b/i,
  /\b(billing integration|billing system|billing for|quota limits?|quota service)\b/i,
  /\b(live.*(cost|cloud|provider)|cloud cost api|provider cost api|AWS|Azure|GCP|Cloudflare)\b/i,
  /\b(credentials?|secret|customer data|real account)\b/i,
  /\b(production ui|dashboard implementation|production dashboard|build dashboard|ship.*ui|launch claim|final launch)\b/i,
];

export function parsePlanAnnotationPseudocode(input: JsonValue): PlanAnnotationPseudocode {
  const result = evaluatePlanAnnotationPseudocode(input);
  if (!result.record || result.errors.length > 0) {
    throw new TypeError(result.errors.join("; "));
  }

  return {
    ...result.record,
    __brand: "ParsedPlanAnnotationPseudocode",
  };
}

export interface PlanAnnotationEvaluation {
  ok: boolean;
  errors: string[];
  record?: UnparsedPlanAnnotationPseudocode;
  accepted: {
    cases: AnnotationCase[];
    proofModes: ProofMode[];
    blockedStates: EvidenceState[];
  };
}

export function evaluatePlanAnnotationPseudocode(input: JsonValue): PlanAnnotationEvaluation {
  const errors: string[] = [];
  if (!input || !isJsonObject(input)) {
    return {
      ok: false,
      errors: ["plan annotation pseudocode record is required"],
      accepted: { cases: [], proofModes: [], blockedStates: [] },
    };
  }

  // SAFETY: `const record = input as Partial<UnparsedPlanAnnotationPseudocode>;` is required at this I/O or test boundary.
  const record = input as Partial<UnparsedPlanAnnotationPseudocode>;
  if (record.schema !== "hobo.vibe-plan-annotation-pseudocode/v1") {
    errors.push("schema must be hobo.vibe-plan-annotation-pseudocode/v1");
  }
  if (record.issue !== "HOBO-543") {
    errors.push("issue must be HOBO-543");
  }
  if (record.phase !== "M1") {
    errors.push("phase must be M1");
  }
  if (record.targetPackagePath !== "src/draft/exp-proofs/ux/vibe-plan-annotation-pseudocode") {
    errors.push("target package path must match HOBO-543 acceptance");
  }
  if (record.proofNotePath !== "docs/design/proofs/vibe-plan-annotation-pseudocode/README.md") {
    errors.push("proof note path must match HOBO-543 acceptance");
  }
  if (!Array.isArray(record.designRefs) || record.designRefs.length === 0) {
    errors.push("design refs are required");
  }
  if (!Array.isArray(record.scopeOut) || record.scopeOut.length === 0) {
    errors.push("scope-out guardrails are required");
  }

  const annotations = Array.isArray(record.annotations) ? record.annotations : [];
  const cases = annotations
    .map((annotation) => annotation.case)
    .filter((value): value is AnnotationCase => isAnnotationCase(value));
  for (const requiredCase of REQUIRED_ANNOTATION_CASES) {
    if (!cases.includes(requiredCase)) {
      errors.push(`missing annotation case: ${requiredCase}`);
    }
  }

  for (const annotation of annotations) {
    validateAnnotation(annotation, errors);
  }

  const proofModes = unique(
    annotations
      .map((annotation) => annotation.proofMode)
      .filter((value): value is ProofMode => isProofMode(value) && value !== "live"),
  );
  const blockedStates = unique(
    annotations
      .map((annotation) => annotation.evidenceState)
      .filter((value): value is EvidenceState => isEvidenceState(value) && value !== "happy"),
  );

  return {
    ok: errors.length === 0,
    errors,
    // SAFETY: `record: record as UnparsedPlanAnnotationPseudocode,` is required at this I/O or test boundary.
    record: record as UnparsedPlanAnnotationPseudocode,
    accepted: { cases, proofModes, blockedStates },
  };
}

export function renderAnnotationPseudocode(contract: PlanAnnotationPseudocode): string {
  const lines = [
    "for each annotation input:",
    "  parse annotation input into a PlanAnnotationFixture",
    "  assert proof mode is reference fixture, simulated, or scope-out",
    "  if missing evidence is stale, unavailable, or unknown:",
    "    neverLabelUnknownEvidenceAsSuccess(annotation)",
    "  derive severity from policy, cost, capacity, approval, or readiness evidence",
    "  routeToSupportOwner(annotation.supportOwnerRoute)",
    "  groupBy(annotation.displayGroup)",
    "  render display grouping with severity, proof mode, missing evidence, and support owner routing",
  ];

  return [
    ...lines,
    "",
    ...contract.annotations.map(
      (annotation) =>
        `${annotation.case}: ${annotation.displayGroup}/${annotation.severity}/${annotation.proofMode}/${annotation.missingEvidenceBehavior}/${annotation.supportOwnerRoute}`,
    ),
  ].join("\n");
}

export function classifyPlanAnnotationRequest(
  summary: string,
): PlanAnnotationRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

export function rejectPlanAnnotationScopeCreep(requests: string[]): ScopeCreepDenial[] {
  return requests.flatMap((request) => {
    const reason = forbiddenReason(request);
    return reason ? [{ decision: "reject" as const, reason, request }] : [];
  });
}

function validateAnnotation(annotation: Partial<PlanAnnotationFixture>, errors: string[]): void {
  if (!isAnnotationCase(annotation.case)) {
    errors.push(`unknown annotation case: ${String(annotation.case)}`);
  }
  if (!annotation.annotationInput) {
    errors.push(`${annotation.case}: annotation input is required`);
  }
  if (!isDisplayGroup(annotation.displayGroup)) {
    errors.push(`${annotation.case}: display grouping is required`);
  }
  if (!isSeverity(annotation.severity)) {
    errors.push(`${annotation.case}: severity is required`);
  }
  if (!isEvidenceState(annotation.evidenceState)) {
    errors.push(`${annotation.case}: evidence state is required`);
  }
  if (!isProofMode(annotation.proofMode)) {
    errors.push(`${annotation.case}: proof mode is required`);
  }
  if (annotation.proofMode === "live") {
    errors.push(`${annotation.case}: live proof mode is out of scope`);
  }
  if (annotation.missingEvidenceBehavior === "show as success") {
    errors.push(`${annotation.case}: unknown evidence must not be shown as success`);
  }
  if (!annotation.supportOwnerRoute) {
    errors.push(`${annotation.case}: support owner route is required`);
  }
  if (!annotation.supportSafeWording || !/support|customer-safe|owner|route/i.test(annotation.supportSafeWording)) {
    errors.push(`${annotation.case}: support-safe wording is required`);
  }
  if (!annotation.accessibilityNote || !/terminal|screen.reader|plain.text|non-color|stable|blocked/i.test(annotation.accessibilityNote)) {
    errors.push(`${annotation.case}: accessibility note must be terminal-friendly`);
  }
  if (!annotation.fixtureId) {
    errors.push(`${annotation.case}: fixture id is required`);
  }
}

function forbiddenReason(request: string): string | undefined {
  if (classifyPlanAnnotationRequest(request) === "scope-out") {
    if (/billing|quota/i.test(request)) {
      return "production policy, approval, quota, or billing engines are out of scope";
    }
    if (/live.*(cost|cloud|provider)|cloud cost api|provider cost|AWS|Azure|GCP|Cloudflare/i.test(request)) {
      return "live provider and cloud cost API calls are out of scope";
    }
    if (/credentials?|secret|customer data|real account/i.test(request)) {
      return "credentials, secrets, real accounts, and customer data are out of scope";
    }
    if (/dashboard|production ui|ship.*ui|launch claim|final launch/i.test(request)) {
      return "production UI and launch claims require accepted evidence outside this proof";
    }
    return "production policy, approval, quota, or billing engines are out of scope";
  }
  return undefined;
}

function isAnnotationCase(value: JsonValue): value is AnnotationCase {
  // SAFETY: `return REQUIRED_ANNOTATION_CASES.includes(value as AnnotationCase);` is required at this I/O or test boundary.
  return REQUIRED_ANNOTATION_CASES.includes(value as AnnotationCase);
}

function isDisplayGroup(value: JsonValue): value is AnnotationDisplayGroup {
  return (
    value === "policy" ||
    value === "cost" ||
    value === "capacity" ||
    value === "approval" ||
    value === "readiness"
  );
}

function isSeverity(value: JsonValue): value is AnnotationSeverity {
  return value === "info" || value === "warning" || value === "blocked" || value === "critical";
}

function isProofMode(value: JsonValue): value is ProofMode {
  return value === "reference fixture" || value === "simulated" || value === "scope-out" || value === "live";
}

function isEvidenceState(value: JsonValue): value is EvidenceState {
  return value === "happy" || value === "blocked" || value === "stale/unknown";
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
